import { randomUUID } from 'node:crypto';

import type { IncidentRecord } from '@catchfly/core/product-types.ts';

import { sql } from './db.ts';
import { recordAudit } from './product-store.ts';

type Row = {
  id: string; project_id: string; finding_id: string | null; title: string;
  status: IncidentRecord['status']; severity: IncidentRecord['severity']; owner: string | null;
  evidence: Record<string, unknown>; resolution: string | null; created_at: Date; updated_at: Date; resolved_at: Date | null;
};

const payload = (row: Row): IncidentRecord => ({
  id: row.id, projectId: row.project_id, title: row.title, status: row.status, severity: row.severity,
  evidence: row.evidence, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
  ...(row.finding_id ? { findingId: row.finding_id } : {}), ...(row.owner ? { owner: row.owner } : {}),
  ...(row.resolution ? { resolution: row.resolution } : {}), ...(row.resolved_at ? { resolvedAt: row.resolved_at.toISOString() } : {}),
});

export async function listIncidentRecords(projectId: string): Promise<IncidentRecord[]> {
  const { rows } = await sql().query<Row>(
    `select * from incidents where project_id = $1
     order by case status when 'open' then 0 when 'investigating' then 1 else 2 end, updated_at desc`, [projectId],
  );
  return rows.map(payload);
}

export async function createIncidentRecord(projectId: string, input: {
  findingId?: string; title: string; severity: IncidentRecord['severity']; owner?: string; evidence?: Record<string, unknown>;
}): Promise<IncidentRecord> {
  const id = `inc_${randomUUID()}`;
  const { rows } = await sql().query<Row>(
    `insert into incidents (project_id, id, finding_id, title, severity, owner, evidence)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb) returning *`,
    [projectId, id, input.findingId ?? null, input.title, input.severity, input.owner ?? null, JSON.stringify(input.evidence ?? {})],
  );
  await recordAudit(projectId, 'admin', null, 'incident.created', id, { findingId: input.findingId ?? null });
  return payload(rows[0]);
}

export async function updateIncidentRecord(projectId: string, incidentId: string, input: {
  status?: IncidentRecord['status']; owner?: string | null; resolution?: string | null;
}): Promise<IncidentRecord | null> {
  const { rows } = await sql().query<Row>(
    `update incidents set
       status = coalesce($3, status), owner = case when $4 then $5 else owner end,
       resolution = case when $6 then $7 else resolution end,
       resolved_at = case when $3 = 'resolved' then now() when $3 is not null then null else resolved_at end,
       updated_at = now()
     where project_id = $1 and id = $2 returning *`,
    [projectId, incidentId, input.status ?? null, input.owner !== undefined, input.owner ?? null, input.resolution !== undefined, input.resolution ?? null],
  );
  if (!rows[0]) return null;
  await recordAudit(projectId, 'admin', null, 'incident.updated', incidentId, input);
  return payload(rows[0]);
}
