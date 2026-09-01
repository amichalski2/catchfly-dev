import { authorizeProjectWrite } from './lib/user-auth.ts';
import { isDatabaseConfigured } from './lib/db.ts';
import { json, methodNotAllowed } from './lib/http.ts';
import { revokeProjectKey } from './lib/product-store.ts';
import { projectIsReadOnly } from './lib/store.ts';

export const config = { path: '/api/projects/:projectId/keys/:keyId' };

export default async function handler(
  req: Request,
  context: { params: { projectId: string; keyId: string } },
): Promise<Response> {
  if (req.method !== 'DELETE') return methodNotAllowed('DELETE');
  if (!isDatabaseConfigured()) return json(503, { error: 'No database is configured for this deployment.' });
  if (await projectIsReadOnly(context.params.projectId)) return json(403, { error: 'The synthetic demo is read-only.' });
  const grant = await authorizeProjectWrite(req, context.params.projectId);
  if (grant) return json(grant.status, { error: grant.error });
  const revoked = await revokeProjectKey(context.params.projectId, context.params.keyId);
  return revoked ? json(200, { revoked: true }) : json(404, { error: 'Unknown project key.' });
}
