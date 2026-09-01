import { createHash, randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';
import {
  TELEMETRY_EVENT_TYPES,
  type DataPolicy,
  type RedactionRule,
  type TelemetryEvent,
} from '@catchfly/core/product-types.ts';
import type { FailureCategory, TrajectoryStep } from '@catchfly/core/types.ts';

import { transaction } from './db.ts';
import { getDataPolicy, recordAudit } from './product-store.ts';

const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const FAILURE_CATEGORIES: FailureCategory[] = [
  'tool-selection', 'structured-output', 'argument-errors',
  'hallucinated-tool', 'sequencing', 'error',
];

export type EventRejection = { index: number; error: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const validOptionalId = (value: unknown): boolean => value === undefined || (typeof value === 'string' && ID.test(value));

export function parseTelemetryEvent(value: unknown, index: number): TelemetryEvent | EventRejection {
  if (!isRecord(value)) return { index, error: 'Event must be an object.' };
  const input = value as Record<string, unknown>;
  if (input.schemaVersion !== '1') return { index, error: 'schemaVersion must be "1".' };
  if (typeof input.eventId !== 'string' || !ID.test(input.eventId)) return { index, error: 'Invalid eventId.' };
  if (typeof input.sessionId !== 'string' || !ID.test(input.sessionId)) return { index, error: 'Invalid sessionId.' };
  if (!Number.isInteger(input.sequence) || Number(input.sequence) < 0) return { index, error: 'sequence must be a non-negative integer.' };
  if (typeof input.type !== 'string' || !TELEMETRY_EVENT_TYPES.includes(input.type as TelemetryEvent['type'])) {
    return { index, error: `Unknown event type "${String(input.type)}".` };
  }
  if (typeof input.occurredAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(input.occurredAt) || Number.isNaN(Date.parse(input.occurredAt))) {
    return { index, error: 'occurredAt must be an ISO timestamp.' };
  }
  if (!isRecord(input.payload)) {
    return { index, error: 'payload must be an object.' };
  }
  const payload = input.payload as TelemetryEvent['payload'];
  if (input.type === 'session.started' || input.type === 'deployment.registered' || input.type === 'manifest.observed') {
    if (!payload.deploymentId || !payload.appVersionId || !validOptionalId(payload.deploymentId) || !validOptionalId(payload.appVersionId)) {
      return { index, error: `${input.type} requires valid payload.deploymentId and payload.appVersionId.` };
    }
  }
  if (input.type.startsWith('tool.') &&
      (typeof payload.toolName !== 'string' || !ID.test(payload.toolName) || typeof payload.callId !== 'string' || !ID.test(payload.callId))) {
    return { index, error: `${input.type} requires valid payload.toolName and payload.callId.` };
  }
  if (!validOptionalId(payload.deploymentId) || !validOptionalId(payload.appVersionId) || !validOptionalId(payload.callId)) {
    return { index, error: 'Payload identifiers are invalid.' };
  }
  if (payload.arguments !== undefined && !isRecord(payload.arguments)) return { index, error: 'payload.arguments must be an object.' };
  if (payload.metadata !== undefined && !isRecord(payload.metadata)) return { index, error: 'payload.metadata must be an object.' };
  if (payload.transcript !== undefined && !Array.isArray(payload.transcript)) return { index, error: 'payload.transcript must be an array.' };
  if (payload.toolManifest !== undefined && !Array.isArray(payload.toolManifest)) return { index, error: 'payload.toolManifest must be an array.' };
  if (payload.durationMs !== undefined && (!Number.isFinite(payload.durationMs) || payload.durationMs < 0)) {
    return { index, error: 'payload.durationMs must be a non-negative number.' };
  }
  if (payload.failureCategory && !FAILURE_CATEGORIES.includes(payload.failureCategory)) {
    return { index, error: 'payload.failureCategory is invalid.' };
  }
  return input as unknown as TelemetryEvent;
}

function pathParts(path: string): string[] {
  return path.split('.').filter(Boolean);
}

function applyRule(root: Record<string, unknown>, rule: RedactionRule): void {
  const parts = pathParts(rule.path);
  let parent: Record<string, unknown> = root;
  for (const part of parts.slice(0, -1)) {
    const next = parent[part];
    if (!next || typeof next !== 'object' || Array.isArray(next)) return;
    parent = next as Record<string, unknown>;
  }
  const key = parts.at(-1);
  if (!key || !(key in parent)) return;
  const current = parent[key];
  if (rule.action === 'remove') delete parent[key];
  else if (rule.action === 'mask') parent[key] = '[REDACTED]';
  else if (rule.action === 'hash') {
    parent[key] = `sha256:${createHash('sha256').update(JSON.stringify(current)).digest('hex')}`;
  } else if (rule.action === 'truncate') {
    const text = typeof current === 'string' ? current : JSON.stringify(current);
    parent[key] = text.slice(0, rule.maxLength ?? 256);
  }
}

const SENSITIVE_KEY = /^(authorization|proxy-authorization|cookie|set-cookie|password|passwd|secret|api[-_]?key|access[-_]?token|refresh[-_]?token)$/i;

function maskNestedSecrets(value: unknown, seen = new WeakSet<object>()): void {
  if (!value || typeof value !== 'object' || seen.has(value as object)) return;
  seen.add(value as object);
  if (Array.isArray(value)) {
    for (const item of value) maskNestedSecrets(item, seen);
    return;
  }
  const record = value as Record<string, unknown>;
  for (const [key, item] of Object.entries(record)) {
    if (SENSITIVE_KEY.test(key)) record[key] = '[REDACTED]';
    else maskNestedSecrets(item, seen);
  }
}

export function redactEvent(event: TelemetryEvent, rules: RedactionRule[]): TelemetryEvent {
  const copy = structuredClone(event) as unknown as Record<string, unknown>;
  maskNestedSecrets(copy);
  // Safe defaults apply even before an administrator writes a policy.
  for (const rule of [
    { path: 'payload.arguments.authorization', action: 'remove' },
    { path: 'payload.arguments.apiKey', action: 'mask' },
    { path: 'payload.result.accessToken', action: 'mask' },
    ...rules,
  ] as RedactionRule[]) applyRule(copy, rule);
  return copy as unknown as TelemetryEvent;
}

function sampledIn(sessionId: string, rate: number): boolean {
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  const value = Number.parseInt(createHash('sha256').update(sessionId).digest('hex').slice(0, 8), 16) / 0xffffffff;
  return value < rate;
}

type StoredEvent = TelemetryEvent & { environmentId: string };

async function ensureDeployment(
  client: PoolClient,
  projectId: string,
  environmentId: string,
  environmentName: string,
  event: StoredEvent,
): Promise<void> {
  const payload = event.payload;
  const appVersionId = payload.appVersionId!;
  const deploymentId = payload.deploymentId!;
  await client.query(
    `insert into app_versions (project_id, id, label, released_at, note, tool_manifest)
     values ($1, $2, $3, $4, null, $5::jsonb)
     on conflict (project_id, id) do update
       set label = excluded.label,
           tool_manifest = case when jsonb_array_length(excluded.tool_manifest) > 0
                                then excluded.tool_manifest else app_versions.tool_manifest end`,
    [
      projectId,
      appVersionId,
      payload.appVersionLabel ?? appVersionId,
      payload.deployedAt ?? event.occurredAt,
      JSON.stringify(payload.toolManifest ?? []),
    ],
  );
  await client.query(
    `insert into deployments
       (project_id, id, app_version_id, environment, environment_id, deployed_at, commit_sha)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (project_id, id) do update
       set app_version_id = excluded.app_version_id,
           environment = excluded.environment,
           environment_id = excluded.environment_id,
           deployed_at = excluded.deployed_at,
           commit_sha = coalesce(excluded.commit_sha, deployments.commit_sha)`,
    [projectId, deploymentId, appVersionId, environmentName, environmentId, payload.deployedAt ?? event.occurredAt, payload.commitSha ?? null],
  );
}

async function foldSession(client: PoolClient, projectId: string, environmentId: string, sessionId: string): Promise<void> {
  const environment = await client.query<{ name: string }>(
    'select name from environments where project_id = $1 and id = $2',
    [projectId, environmentId],
  );
  const rows = await client.query<{
    event_id: string;
    event_type: TelemetryEvent['type'];
    sequence: number;
    occurred_at: Date;
    payload: TelemetryEvent['payload'];
  }>(
    `select event_id, event_type, sequence, occurred_at, payload
       from telemetry_events
      where project_id = $1 and session_id = $2
      order by sequence, occurred_at, event_id`,
    [projectId, sessionId],
  );
  const events: StoredEvent[] = rows.rows.map((row) => ({
    schemaVersion: '1',
    eventId: row.event_id,
    sessionId,
    sequence: row.sequence,
    type: row.event_type,
    occurredAt: row.occurred_at.toISOString(),
    payload: row.payload,
    environmentId,
  }));
  const deploymentEvents = events.filter((event) =>
    event.type === 'session.started' || event.type === 'deployment.registered' || event.type === 'manifest.observed');
  for (const deploymentEvent of deploymentEvents) {
    if (deploymentEvent.payload.deploymentId && deploymentEvent.payload.appVersionId) {
      await ensureDeployment(client, projectId, environmentId, environment.rows[0]?.name ?? environmentId, deploymentEvent);
    }
  }
  const started = events.find((event) => event.type === 'session.started');
  if (!started || !started.payload.deploymentId || !started.payload.appVersionId) return;

  let outcome: 'completed' | 'failed' | 'abandoned' | 'unknown' = 'unknown';
  let endedAt: string | null = null;
  let failureCategory: FailureCategory | null = null;
  let failureTool: string | null = null;
  const called = new Map<string, StoredEvent>();
  const finished: StoredEvent[] = [];
  for (const event of events) {
    const key = event.payload.callId ?? `${event.payload.toolName ?? 'tool'}:${event.sequence}`;
    if (event.type === 'tool.called') called.set(key, event);
    if (event.type === 'tool.completed' || event.type === 'tool.failed') finished.push(event);
    if (event.type === 'task.completed') { outcome = 'completed'; endedAt = event.occurredAt; }
    if (event.type === 'task.failed') {
      outcome = 'failed'; endedAt = event.occurredAt;
      failureCategory = event.payload.failureCategory ?? null;
      failureTool = event.payload.failureTool ?? null;
    }
    if (event.type === 'session.abandoned') { outcome = 'abandoned'; endedAt = event.occurredAt; }
  }

  await client.query('delete from sessions where project_id = $1 and id = $2', [projectId, sessionId]);
  await client.query(
    `insert into sessions
       (project_id, id, deployment_id, environment, environment_id, started_at, ended_at,
        agent, model, intent, outcome, failure_category, failure_tool, data_origin, transcript, metadata)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'measured', $14::jsonb, $15::jsonb)`,
    [
      projectId, sessionId, started.payload.deploymentId,
      environment.rows[0]?.name ?? environmentId, environmentId, started.occurredAt, endedAt,
      started.payload.agent ?? null, started.payload.model ?? null, started.payload.intent ?? null,
      outcome, failureCategory, failureTool,
      started.payload.transcript ? JSON.stringify(started.payload.transcript as TrajectoryStep[]) : null,
      started.payload.metadata ? JSON.stringify(started.payload.metadata) : null,
    ],
  );
  for (const [ordinal, event] of finished.entries()) {
    const key = event.payload.callId ?? `${event.payload.toolName ?? 'tool'}:${event.sequence}`;
    const origin = called.get(key);
    await client.query(
      `insert into session_tool_calls
         (project_id, session_id, ordinal, ts, tool_name, tool_schema_version,
          arguments, result, status, duration_ms, error_type, error_message)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, $12)`,
      [
        projectId, sessionId, ordinal, origin?.occurredAt ?? event.occurredAt,
        event.payload.toolName, event.payload.toolSchemaVersion ?? origin?.payload.toolSchemaVersion ?? null,
        event.payload.arguments || origin?.payload.arguments ? JSON.stringify(event.payload.arguments ?? origin?.payload.arguments) : null,
        event.payload.result === undefined ? null : JSON.stringify(event.payload.result),
        event.type === 'tool.failed' ? 'error' : 'success', event.payload.durationMs ?? 0,
        event.payload.errorType ?? null, event.payload.errorMessage ?? null,
      ],
    );
  }
}

export async function ingestTelemetry(input: {
  projectId: string;
  environmentId: string;
  actorKeyId: string;
  idempotencyKey?: string;
  events: TelemetryEvent[];
  rejected: EventRejection[];
}): Promise<{
  batchId: string;
  accepted: number;
  duplicates: number;
  sampledOut: number;
  rejected: EventRejection[];
}> {
  const policy: DataPolicy | null = await getDataPolicy(input.projectId, input.environmentId);
  if (!policy) throw new Error(`Unknown environment "${input.environmentId}".`);
  const batchId: string = randomUUID();
  let accepted = 0;
  let duplicates = 0;
  let sampledOut = 0;
  let resultBatchId = batchId;
  let reusedBatch = false;
  const sessions = new Set<string>();

  await transaction(async (client) => {
    if (input.idempotencyKey) {
      const existing = await client.query<{
        id: string; accepted_count: number; duplicate_count: number; sampled_count: number; rejected_count: number;
      }>(
        `select id, accepted_count, duplicate_count, sampled_count, rejected_count
           from ingest_batches where project_id = $1 and idempotency_key = $2`,
        [input.projectId, input.idempotencyKey],
      );
      if (existing.rows[0]) {
        reusedBatch = true;
        resultBatchId = existing.rows[0].id;
        accepted = existing.rows[0].accepted_count;
        duplicates = existing.rows[0].duplicate_count;
        sampledOut = existing.rows[0].sampled_count;
        return;
      }
    }
    const insertedBatch = await client.query(
      `insert into ingest_batches (project_id, id, environment_id, idempotency_key, rejected_count)
       values ($1, $2, $3, $4, $5)
       on conflict (project_id, idempotency_key) do nothing returning id`,
      [input.projectId, batchId, input.environmentId, input.idempotencyKey ?? null, input.rejected.length],
    );
    if (input.idempotencyKey && (insertedBatch.rowCount ?? 0) === 0) {
      const existing = await client.query<{
        id: string; accepted_count: number; duplicate_count: number; sampled_count: number;
      }>(
        `select id, accepted_count, duplicate_count, sampled_count from ingest_batches
          where project_id = $1 and idempotency_key = $2`,
        [input.projectId, input.idempotencyKey],
      );
      if (existing.rows[0]) {
        reusedBatch = true;
        resultBatchId = existing.rows[0].id;
        accepted = existing.rows[0].accepted_count;
        duplicates = existing.rows[0].duplicate_count;
        sampledOut = existing.rows[0].sampled_count;
        return;
      }
    }
    for (const raw of input.events) {
      if (!sampledIn(raw.sessionId, policy.samplingRate)) { sampledOut += 1; continue; }
      const event = redactEvent(raw, policy.redactionRules);
      const inserted = await client.query(
        `insert into telemetry_events
           (project_id, event_id, environment_id, batch_id, session_id, sequence, event_type, occurred_at, payload)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
         on conflict do nothing returning event_id`,
        [input.projectId, event.eventId, input.environmentId, batchId, event.sessionId, event.sequence, event.type, event.occurredAt, JSON.stringify(event.payload)],
      );
      if ((inserted.rowCount ?? 0) > 0) { accepted += 1; sessions.add(event.sessionId); }
      else duplicates += 1;
    }
    for (const sessionId of sessions) await foldSession(client, input.projectId, input.environmentId, sessionId);
    await client.query(
      `update ingest_batches
          set accepted_count = $3, duplicate_count = $4, sampled_count = $5
        where project_id = $1 and id = $2`,
      [input.projectId, batchId, accepted, duplicates, sampledOut],
    );
  });
  if (!reusedBatch) {
    await recordAudit(input.projectId, 'api-key', input.actorKeyId, 'telemetry.ingested', batchId, {
      accepted, duplicates, sampledOut, rejected: input.rejected.length,
    });
  }
  return { batchId: resultBatchId, accepted, duplicates, sampledOut, rejected: reusedBatch ? [] : input.rejected };
}
