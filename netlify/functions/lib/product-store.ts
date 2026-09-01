import type {
  ApiKeyScope,
  DataPolicy,
  EnvironmentKind,
  ProjectApiKey,
  ProjectEnvironment,
  RedactionRule,
  SourceHealth,
} from '@catchfly/core/product-types.ts';

import { apiKeyPayload, mintProjectKey } from './auth.ts';
import { sql } from './db.ts';

export async function listEnvironments(projectId: string): Promise<ProjectEnvironment[]> {
  const { rows } = await sql().query<{
    id: string;
    name: string;
    kind: EnvironmentKind;
    created_at: Date;
  }>('select id, name, kind, created_at from environments where project_id = $1 order by created_at, id', [projectId]);
  return rows.map((row) => ({
    id: row.id,
    projectId,
    name: row.name,
    kind: row.kind,
    createdAt: row.created_at.toISOString(),
  }));
}

export async function createEnvironment(
  projectId: string,
  input: { id: string; name: string; kind: EnvironmentKind },
): Promise<ProjectEnvironment> {
  const { rows } = await sql().query<{ created_at: Date }>(
    `insert into environments (project_id, id, name, kind) values ($1, $2, $3, $4)
     returning created_at`,
    [projectId, input.id, input.name, input.kind],
  );
  await sql().query(
    `insert into data_policies (project_id, environment_id) values ($1, $2)
     on conflict do nothing`,
    [projectId, input.id],
  );
  return { ...input, projectId, createdAt: rows[0].created_at.toISOString() };
}

type KeyRow = {
  id: string;
  project_id: string;
  environment_id: string;
  name: string;
  key_prefix: string;
  scopes: ApiKeyScope[];
  allowed_origins: string[] | null;
  created_at: Date;
  last_used_at: Date | null;
  expires_at: Date | null;
  revoked_at: Date | null;
};

export async function listProjectKeys(projectId: string): Promise<ProjectApiKey[]> {
  const { rows } = await sql().query<KeyRow>(
    `select id, project_id, environment_id, name, key_prefix, scopes, allowed_origins,
            created_at, last_used_at, expires_at, revoked_at
       from project_api_keys where project_id = $1 order by created_at desc`,
    [projectId],
  );
  return rows.map(apiKeyPayload);
}

export async function createProjectKey(
  projectId: string,
  input: {
    environmentId: string;
    name: string;
    scopes: ApiKeyScope[];
    expiresAt?: string;
    allowedOrigins?: string[];
  },
): Promise<{ key: ProjectApiKey; secret: string }> {
  const minted = mintProjectKey(projectId);
  const { rows } = await sql().query<KeyRow>(
    `insert into project_api_keys
       (project_id, id, environment_id, name, key_prefix, key_hash, scopes, expires_at, allowed_origins)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     returning id, project_id, environment_id, name, key_prefix, scopes, allowed_origins,
               created_at, last_used_at, expires_at, revoked_at`,
    [projectId, minted.id, input.environmentId, input.name, minted.prefix, minted.hash, input.scopes, input.expiresAt ?? null, input.allowedOrigins ?? null],
  );
  await recordAudit(projectId, 'admin', null, 'api-key.created', minted.id, {
    environmentId: input.environmentId,
    scopes: input.scopes,
    allowedOrigins: input.allowedOrigins ?? null,
  });
  return { key: apiKeyPayload(rows[0]), secret: minted.secret };
}

export async function revokeProjectKey(projectId: string, keyId: string): Promise<boolean> {
  const result = await sql().query(
    `update project_api_keys set revoked_at = coalesce(revoked_at, now())
      where project_id = $1 and id = $2`,
    [projectId, keyId],
  );
  if ((result.rowCount ?? 0) > 0) await recordAudit(projectId, 'admin', null, 'api-key.revoked', keyId);
  return (result.rowCount ?? 0) > 0;
}

export async function getDataPolicy(projectId: string, environmentId: string): Promise<DataPolicy | null> {
  const { rows } = await sql().query<{
    redaction_rules: RedactionRule[];
    sampling_rate: number;
    retention_days: number;
    updated_at: Date;
  }>(
    `select redaction_rules, sampling_rate, retention_days, updated_at
       from data_policies where project_id = $1 and environment_id = $2`,
    [projectId, environmentId],
  );
  const row = rows[0];
  return row
    ? {
        projectId,
        environmentId,
        redactionRules: row.redaction_rules,
        samplingRate: row.sampling_rate,
        retentionDays: row.retention_days,
        updatedAt: row.updated_at.toISOString(),
      }
    : null;
}

export async function saveDataPolicy(
  projectId: string,
  environmentId: string,
  input: Pick<DataPolicy, 'redactionRules' | 'samplingRate' | 'retentionDays'>,
): Promise<DataPolicy> {
  const { rows } = await sql().query<{ updated_at: Date }>(
    `insert into data_policies
       (project_id, environment_id, redaction_rules, sampling_rate, retention_days, updated_at)
     values ($1, $2, $3::jsonb, $4, $5, now())
     on conflict (project_id, environment_id) do update
       set redaction_rules = excluded.redaction_rules,
           sampling_rate = excluded.sampling_rate,
           retention_days = excluded.retention_days,
           updated_at = now()
     returning updated_at`,
    [projectId, environmentId, JSON.stringify(input.redactionRules), input.samplingRate, input.retentionDays],
  );
  await recordAudit(projectId, 'admin', null, 'data-policy.updated', environmentId, {
    samplingRate: input.samplingRate,
    retentionDays: input.retentionDays,
    redactionRuleCount: input.redactionRules.length,
  });
  return { projectId, environmentId, ...input, updatedAt: rows[0].updated_at.toISOString() };
}

export async function sourceHealth(projectId: string): Promise<SourceHealth> {
  const { rows } = await sql().query<{
    id: string;
    name: string;
    kind: EnvironmentKind;
    created_at: Date;
    last_event_at: Date | null;
    last_batch_at: Date | null;
    accepted_events: string;
    duplicate_events: string;
    rejected_events: string;
    active_keys: string;
  }>(
    `with batch_rollup as (
       select project_id, environment_id, max(received_at) as last_batch_at,
              sum(accepted_count) as accepted_events,
              sum(duplicate_count) as duplicate_events,
              sum(rejected_count) as rejected_events
         from ingest_batches where project_id = $1 group by project_id, environment_id
     ), event_rollup as (
       select project_id, environment_id, max(received_at) as last_event_at
         from telemetry_events where project_id = $1 group by project_id, environment_id
     )
     select e.id, e.name, e.kind, e.created_at,
            t.last_event_at,
            b.last_batch_at,
            coalesce(b.accepted_events, 0) as accepted_events,
            coalesce(b.duplicate_events, 0) as duplicate_events,
            coalesce(b.rejected_events, 0) as rejected_events,
            (select count(*) from project_api_keys k
              where k.project_id = e.project_id and k.environment_id = e.id
                and k.revoked_at is null and (k.expires_at is null or k.expires_at > now())) as active_keys
       from environments e
       left join batch_rollup b on b.project_id = e.project_id and b.environment_id = e.id
       left join event_rollup t on t.project_id = e.project_id and t.environment_id = e.id
      where e.project_id = $1
      order by e.created_at, e.id`,
    [projectId],
  );
  return {
    projectId,
    environments: rows.map((row) => ({
      environment: {
        id: row.id,
        projectId,
        name: row.name,
        kind: row.kind,
        createdAt: row.created_at.toISOString(),
      },
      lastEventAt: row.last_event_at?.toISOString() ?? null,
      lastBatchAt: row.last_batch_at?.toISOString() ?? null,
      acceptedEvents: Number(row.accepted_events),
      duplicateEvents: Number(row.duplicate_events),
      rejectedEvents: Number(row.rejected_events),
      activeKeys: Number(row.active_keys),
    })),
  };
}

export async function recordAudit(
  projectId: string | null,
  actorType: 'system' | 'admin' | 'api-key' | 'agent',
  actorId: string | null,
  action: string,
  target?: string | null,
  detail: Record<string, unknown> = {},
): Promise<void> {
  await sql().query(
    `insert into audit_log (project_id, actor_type, actor_id, action, target, detail)
     values ($1, $2, $3, $4, $5, $6::jsonb)`,
    [projectId, actorType, actorId, action, target ?? null, JSON.stringify(detail)],
  );
}
