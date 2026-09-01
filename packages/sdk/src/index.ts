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
  deployment?: {
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
  maxRetries?: number;
  retryBaseMs?: number;
  fetch?: typeof fetch;
  onError?: (error: Error) => void;
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

export class CatchflySession {
  readonly id: string;
  private readonly client: Catchfly;
  private sequence = 0;
  private ended = false;

  constructor(client: Catchfly, input: StartSessionInput) {
    this.client = client;
    this.id = input.id ?? uid('ses');
    this.emit('session.started', {
      ...client.deployment,
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
  private readonly request: typeof fetch;
  private readonly onError: (error: Error) => void;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly timer: ReturnType<typeof setInterval>;
  private queue: TelemetryEvent[] = [];
  private sending: Promise<void> | null = null;

  constructor(options: CatchflyOptions) {
    this.endpoint = options.endpoint.replace(/\/$/, '');
    this.projectId = options.projectId;
    this.environmentId = options.environmentId;
    this.apiKey = options.apiKey;
    this.deployment = options.deployment;
    this.batchSize = Math.max(1, options.batchSize ?? 50);
    this.maxBufferSize = Math.max(this.batchSize, options.maxBufferSize ?? 1_000);
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
    if (this.queue.length >= this.batchSize) void this.flush();
  }

  async flush(): Promise<void> {
    if (this.sending) return this.sending;
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0, this.batchSize);
    this.sending = this.sendWithRetry(batch).catch((error: unknown) => {
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.onError(normalized);
    }).finally(() => {
      this.sending = null;
      if (this.queue.length >= this.batchSize) void this.flush();
    });
    return this.sending;
  }

  async shutdown(): Promise<void> {
    clearInterval(this.timer);
    while (this.queue.length > 0 || this.sending) {
      if (this.sending) await this.sending;
      else await this.flush();
    }
  }

  private async sendWithRetry(events: TelemetryEvent[]): Promise<void> {
    const idempotencyKey = uid('batch');
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        await this.sendOnce(events, idempotencyKey);
        return;
      } catch (error) {
        lastError = error;
        if (attempt < this.maxRetries) {
          await new Promise<void>((resolve) => setTimeout(resolve, this.retryBaseMs * (2 ** attempt)));
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async sendOnce(events: TelemetryEvent[], idempotencyKey: string): Promise<void> {
    const response = await this.request(`${this.endpoint}/api/v1/projects/${encodeURIComponent(this.projectId)}/events`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
      },
      body: JSON.stringify({ environmentId: this.environmentId, events }),
      keepalive: true,
    });
    if (!response.ok) {
      let message = `Catchfly ingest failed with ${response.status}.`;
      try {
        const body = await response.json() as { error?: unknown };
        if (typeof body.error === 'string') message = body.error;
      } catch {
        // The status remains useful when a proxy returned a non-JSON error.
      }
      throw new Error(message);
    }
  }
}

export {
  instrumentWebMCP,
  type InstrumentableContext,
  type InstrumentableTool,
} from './instrument.js';
