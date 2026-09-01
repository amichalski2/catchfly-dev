import type { IncidentRecord } from '@catchfly/core/product-types.ts';

import { authorizeProjectRead, authorizeProjectWrite } from './lib/user-auth.ts';
import { isDatabaseConfigured } from './lib/db.ts';
import { BadJson, json, methodNotAllowed, readJson } from './lib/http.ts';
import { createIncidentRecord, listIncidentRecords } from './lib/incident-record-store.ts';
import { projectExists, projectIsReadOnly } from './lib/store.ts';

export const config = { path: '/api/projects/:projectId/incidents' };
const SEVERITIES: IncidentRecord['severity'][] = ['info', 'warning', 'critical'];

export default async function handler(req: Request, context: { params: { projectId: string } }): Promise<Response> {
  if (!isDatabaseConfigured()) return json(503, { error: 'No database is configured for this deployment.' });
  const { projectId } = context.params;
  if (!(await projectExists(projectId))) return json(404, { error: `Unknown project "${projectId}".` });
  if (req.method === 'GET') {
    const denied = await authorizeProjectRead(req, projectId); if (denied) return json(denied.status, { error: denied.error });
    return json(200, { incidents: await listIncidentRecords(projectId) });
  }
  if (req.method !== 'POST') return methodNotAllowed('GET or POST');
  if (await projectIsReadOnly(projectId)) return json(403, { error: 'The synthetic demo is read-only.' });
  const writeDenied = await authorizeProjectWrite(req, projectId); if (writeDenied) return json(writeDenied.status, { error: writeDenied.error });
  let body: Record<string, unknown>;
  try { body = await readJson(req, 64 * 1024) as Record<string, unknown>; }
  catch (error) { if (error instanceof BadJson) return json(400, { error: error.message }); throw error; }
  if (typeof body.title !== 'string' || !body.title.trim()) return json(400, { error: 'title is required.' });
  if (typeof body.severity !== 'string' || !SEVERITIES.includes(body.severity as IncidentRecord['severity'])) return json(400, { error: 'severity is invalid.' });
  try {
    const incident = await createIncidentRecord(projectId, {
      title: body.title.trim(), severity: body.severity as IncidentRecord['severity'],
      ...(typeof body.findingId === 'string' ? { findingId: body.findingId } : {}),
      ...(typeof body.owner === 'string' ? { owner: body.owner } : {}),
      ...(body.evidence && typeof body.evidence === 'object' ? { evidence: body.evidence as Record<string, unknown> } : {}),
    });
    return json(201, { incident });
  } catch (error) {
    if ((error as { code?: string }).code === '23505') return json(409, { error: 'This finding already has an open incident.' });
    throw error;
  }
}
