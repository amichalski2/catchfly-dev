export type FailureCategory =
  | 'tool-selection' | 'structured-output' | 'argument-errors'
  | 'hallucinated-tool' | 'sequencing' | 'error';

export type ToolSchema = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown> | null;
};

export type TrajectoryStep = {
  text?: string;
  reasoningText?: string;
  toolCalls?: Array<{ functionName: string; args: Record<string, unknown>; result?: unknown }>;
  toolResults?: unknown[];
};

export type TelemetryEvent = {
  schemaVersion: '1';
  eventId: string;
  sessionId: string;
  sequence: number;
  type: 'session.started' | 'tool.called' | 'tool.completed' | 'tool.failed' |
    'task.completed' | 'task.failed' | 'session.abandoned' | 'deployment.registered' | 'manifest.observed';
  occurredAt: string;
  payload: Record<string, unknown>;
};

export type CatchflyOptions = {
  endpoint: string;
  projectId: string;
  environmentId: string;
  apiKey: string;
  deployment: {
    id: string;
    appVersionId: string;
    appVersionLabel?: string;
    deployedAt?: string;
    commitSha?: string;
    toolManifest?: ToolSchema[];
  };
  batchSize?: number;
  flushIntervalMs?: number;
  maxBufferSize?: number;
  /** Maximum serialized request size. Kept below Catchfly's 2 MiB ingest limit. */
  maxBatchBytes?: number;
  maxRetries?: number;
  retryBaseMs?: number;
  fetch?: typeof fetch;
  onError?: (error: Error) => void;
};

export type EventRejection = { index: number; error: string };

export type DeliveryReceipt = {
  batchId?: string;
  accepted: number;
  duplicates: number;
  sampledOut: number;
  rejected: EventRejection[];
};

export class DeliveryError extends Error {
  readonly status?: number;
  readonly retryable: boolean;
  readonly rejected: EventRejection[];

  constructor(
    message: string,
    options: { status?: number; retryable?: boolean; rejected?: EventRejection[] } = {},
  ) {
    super(message);
    this.name = 'DeliveryError';
    this.status = options.status;
    this.retryable = options.retryable ?? true;
    this.rejected = options.rejected ?? [];
  }
}

export type FlushOptions = {
  /** Use the browser's unload-safe fetch path. Intended only for pagehide. */
  keepalive?: boolean;
  /** Keep a transiently failed batch for a later interval. Defaults to true. */
  requeueOnFailure?: boolean;
};

export type StartSessionInput = {
  id?: string;
  agent?: string;
  model?: string;
  intent?: string;
  metadata?: Record<string, unknown>;
  transcript?: TrajectoryStep[];
};

export type ToolCallInput = {
  callId?: string;
  toolName: string;
  toolSchemaVersion?: string;
  arguments?: Record<string, unknown>;
};

export type ToolResultInput = {
  callId: string;
  toolName: string;
  toolSchemaVersion?: string;
  arguments?: Record<string, unknown>;
  result?: unknown;
  durationMs?: number;
  errorType?: string;
  errorMessage?: string;
};

const uid = (prefix: string): string => `${prefix}_${crypto.randomUUID()}`;
const byteLength = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;

function deploymentPayload(deployment: CatchflyOptions['deployment']): Record<string, unknown> {
  return {
    deploymentId: deployment.id,
    appVersionId: deployment.appVersionId,
    appVersionLabel: deployment.appVersionLabel,
    deployedAt: deployment.deployedAt,
    commitSha: deployment.commitSha,
    toolManifest: deployment.toolManifest,
  };
}

export class CatchflySession {
  readonly id: string;
  private readonly client: Catchfly;
  private sequence = 0;
  private ended = false;

  constructor(client: Catchfly, input: StartSessionInput) {
    this.client = client;
    this.id = input.id ?? uid('ses');
    this.emit('session.started', {
      ...deploymentPayload(client.deployment),
      agent: input.agent,
      model: input.model,
      intent: input.intent,
      metadata: input.metadata,
      transcript: input.transcript,
    });
  }

  toolCalled(input: ToolCallInput): string {
    const callId = input.callId ?? uid('call');
    this.emit('tool.called', { ...input, callId });
    return callId;
  }

  toolCompleted(input: ToolResultInput): void {
    this.emit('tool.completed', input);
  }

  toolFailed(input: ToolResultInput): void {
    this.emit('tool.failed', input);
  }

  complete(): void {
    this.finish('task.completed', {});
  }

  fail(input: { failureCategory?: FailureCategory; failureTool?: string } = {}): void {
    this.finish('task.failed', input);
  }

  abandon(): void {
    this.finish('session.abandoned', {});
  }

  private finish(type: 'task.completed' | 'task.failed' | 'session.abandoned', payload: TelemetryEvent['payload']): void {
    if (this.ended) return;
    this.emit(type, payload);
    this.ended = true;
  }

  private emit(type: TelemetryEvent['type'], payload: TelemetryEvent['payload']): void {
    if (this.ended) throw new Error(`Catchfly session ${this.id} has already ended.`);
    this.client.enqueue({
      schemaVersion: '1',
      eventId: uid('evt'),
      sessionId: this.id,
      sequence: this.sequence++,
      type,
      occurredAt: new Date().toISOString(),
      payload,
    });
  }
}

export class Catchfly {
  readonly deployment: CatchflyOptions['deployment'];
  private readonly endpoint: string;
  private readonly projectId: string;
  private readonly environmentId: string;
  private readonly apiKey: string;
  private readonly batchSize: number;
  private readonly maxBufferSize: number;
  private readonly maxBatchBytes: number;
  private readonly request: typeof fetch;
  private readonly onError: (error: Error) => void;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly timer: ReturnType<typeof setInterval>;
  private queue: TelemetryEvent[] = [];
  private sending: Promise<void> | null = null;

  constructor(options: CatchflyOptions) {
    if (!options.deployment?.id || !options.deployment.appVersionId) {
      throw new Error('Catchfly requires deployment.id and deployment.appVersionId.');
    }
    this.endpoint = options.endpoint.replace(/\/$/, '');
    this.projectId = options.projectId;
    this.environmentId = options.environmentId;
    this.apiKey = options.apiKey;
    this.deployment = options.deployment;
    this.batchSize = Math.max(1, options.batchSize ?? 50);
    this.maxBufferSize = Math.max(this.batchSize, options.maxBufferSize ?? 1_000);
    this.maxBatchBytes = Math.min(1_800_000, Math.max(16_384, options.maxBatchBytes ?? 512 * 1024));
    this.request = options.fetch ?? globalThis.fetch;
    this.onError = options.onError ?? (() => {});
    this.maxRetries = Math.max(0, options.maxRetries ?? 3);
    this.retryBaseMs = Math.max(50, options.retryBaseMs ?? 500);
    this.timer = setInterval(() => void this.flush(), Math.max(250, options.flushIntervalMs ?? 2_000));
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  startSession(input: StartSessionInput = {}): CatchflySession {
    return new CatchflySession(this, input);
  }

  enqueue(event: TelemetryEvent): void {
    if (this.queue.length >= this.maxBufferSize) {
      this.queue.shift();
      this.onError(new Error('Catchfly telemetry buffer was full; the oldest event was dropped.'));
    }
    this.queue.push(event);
    // Do not let a large transcript sit until pagehide, where browsers impose a
    // much smaller keepalive request budget.
    if (this.queue.length >= this.batchSize || byteLength(event) >= 48 * 1024) void this.flush();
  }

  async flush(options: FlushOptions = {}): Promise<void> {
    if (this.sending) return this.sending;
    if (this.queue.length === 0) return;
    const keepalive = options.keepalive === true;
    const byteLimit = keepalive ? Math.min(this.maxBatchBytes, 60 * 1024) : this.maxBatchBytes;
    const batch = this.takeBatch(byteLimit, !keepalive);
    if (batch.length === 0) {
      // A single event may be valid for normal ingest but too large for the
      // browser keepalive budget. Preserve it and make a best-effort normal
      // request instead of silently discarding the trace.
      if (keepalive && this.queue.length > 0) {
        return this.flush({ requeueOnFailure: options.requeueOnFailure });
      }
      return;
    }
    let requeued = false;
    this.sending = this.sendWithRetry(batch, keepalive).catch((error: unknown) => {
      const normalized = error instanceof DeliveryError
        ? error
        : new DeliveryError(error instanceof Error ? error.message : String(error));
      if (normalized.retryable && options.requeueOnFailure !== false) {
        this.prepend(batch);
        requeued = true;
      }
      this.onError(normalized);
    }).finally(() => {
      this.sending = null;
      // A requeued batch waits for the next interval. Retrying immediately here
      // would turn an outage into a tight, unbounded loop.
      if (!requeued && this.queue.length >= this.batchSize) void this.flush();
    });
    return this.sending;
  }

  async shutdown(): Promise<void> {
    clearInterval(this.timer);
    while (this.queue.length > 0 || this.sending) {
      if (this.sending) await this.sending;
      else await this.flush({ requeueOnFailure: false });
    }
  }

  private takeBatch(maxBytes: number, dropOversized: boolean): TelemetryEvent[] {
    const batch: TelemetryEvent[] = [];
    let bytes = byteLength({ environmentId: this.environmentId, events: [] });
    while (batch.length < this.batchSize && this.queue.length > 0) {
      const event = this.queue[0];
      const eventBytes = byteLength(event) + (batch.length > 0 ? 1 : 0);
      if (bytes + eventBytes > maxBytes) {
        if (batch.length > 0) break;
        if (!dropOversized) break;
        this.queue.shift();
        this.onError(new DeliveryError(
          `Catchfly telemetry event ${event.eventId} exceeds the ${maxBytes}-byte delivery limit and was dropped.`,
          { retryable: false },
        ));
        continue;
      }
      batch.push(this.queue.shift()!);
      bytes += eventBytes;
    }
    return batch;
  }

  private prepend(events: TelemetryEvent[]): void {
    const combined = [...events, ...this.queue];
    if (combined.length > this.maxBufferSize) {
      const dropped = combined.length - this.maxBufferSize;
      combined.length = this.maxBufferSize;
      this.onError(new DeliveryError(
        `Catchfly telemetry buffer was full while restoring a failed batch; ${dropped} newest event(s) were dropped.`,
        { retryable: false },
      ));
    }
    this.queue = combined;
  }

  private async sendWithRetry(events: TelemetryEvent[], keepalive: boolean): Promise<void> {
    const idempotencyKey = uid('batch');
    let lastError: unknown;
    const retries = keepalive ? 0 : this.maxRetries;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        await this.sendOnce(events, idempotencyKey, keepalive);
        return;
      } catch (error) {
        lastError = error;
        const retryable = !(error instanceof DeliveryError) || error.retryable;
        if (!retryable) throw error;
        if (attempt < retries) {
          await new Promise<void>((resolve) => setTimeout(resolve, this.retryBaseMs * (2 ** attempt)));
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async sendOnce(events: TelemetryEvent[], idempotencyKey: string, keepalive: boolean): Promise<void> {
    const response = await this.request(`${this.endpoint}/api/v1/projects/${encodeURIComponent(this.projectId)}/events`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
      },
      body: JSON.stringify({ environmentId: this.environmentId, events }),
      keepalive,
    });
    if (!response.ok) {
      let message = `Catchfly ingest failed with ${response.status}.`;
      try {
        const body = await response.json() as { error?: unknown };
        if (typeof body.error === 'string') message = body.error;
      } catch {
        // The status remains useful when a proxy returned a non-JSON error.
      }
      throw new DeliveryError(message, {
        status: response.status,
        retryable: response.status === 408 || response.status === 429 || response.status >= 500,
      });
    }
    let receipt: DeliveryReceipt | null = null;
    try {
      const body = await response.json() as Partial<DeliveryReceipt>;
      receipt = {
        batchId: body.batchId,
        accepted: Number(body.accepted ?? 0),
        duplicates: Number(body.duplicates ?? 0),
        sampledOut: Number(body.sampledOut ?? 0),
        rejected: Array.isArray(body.rejected) ? body.rejected : [],
      };
    } catch {
      // A successful response from an older compatible server may have no JSON receipt.
    }
    if (receipt && receipt.rejected.length > 0) {
      this.onError(new DeliveryError(
        `Catchfly rejected ${receipt.rejected.length} event(s): ${receipt.rejected.map((entry) => `#${entry.index} ${entry.error}`).join('; ')}`,
        { status: response.status, retryable: false, rejected: receipt.rejected },
      ));
    }
  }
}

export {
  instrumentWebMCP,
  type InstrumentableContext,
  type InstrumentableTool,
} from './instrument.js';
