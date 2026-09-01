import type { IncidentRecord } from '@catchfly/core/product-types.ts';

import { authorizeProjectWrite } from './lib/user-auth.ts';
import { isDatabaseConfigured } from './lib/db.ts';
import { BadJson, json, methodNotAllowed, readJson } from './lib/http.ts';
import { updateIncidentRecord } from './lib/incident-record-store.ts';
import { projectIsReadOnly } from './lib/store.ts';

export const config = { path: '/api/projects/:projectId/incidents/:incidentId' };
const STATUSES: IncidentRecord['status'][] = ['open', 'investigating', 'resolved'];

export default async function handler(req: Request, context: { params: { projectId: string; incidentId: string } }): Promise<Response> {
  if (req.method !== 'PATCH') return methodNotAllowed('PATCH');
  if (!isDatabaseConfigured()) return json(503, { error: 'No database is configured for this deployment.' });
  if (await projectIsReadOnly(context.params.projectId)) return json(403, { error: 'The synthetic demo is read-only.' });
  const denied = await authorizeProjectWrite(req, context.params.projectId); if (denied) return json(denied.status, { error: denied.error });
  let body: Record<string, unknown>;
  try { body = await readJson(req, 32 * 1024) as Record<string, unknown>; }
  catch (error) { if (error instanceof BadJson) return json(400, { error: error.message }); throw error; }
  if (body.status !== undefined && (typeof body.status !== 'string' || !STATUSES.includes(body.status as IncidentRecord['status']))) return json(400, { error: 'status is invalid.' });
  const incident = await updateIncidentRecord(context.params.projectId, context.params.incidentId, {
    ...(typeof body.status === 'string' ? { status: body.status as IncidentRecord['status'] } : {}),
    ...(body.owner === null || typeof body.owner === 'string' ? { owner: body.owner } : {}),
    ...(body.resolution === null || typeof body.resolution === 'string' ? { resolution: body.resolution } : {}),
  });
  return incident ? json(200, { incident }) : json(404, { error: 'Unknown incident.' });
}
