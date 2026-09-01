/** GET /api/projects/:projectId/bootstrap — compact first payload for a large project. */

import { isDatabaseConfigured } from './lib/db.ts';
import { authorizeProjectRead } from './lib/user-auth.ts';
import { loadEvalBootstrap } from './lib/eval-read-store.ts';
import { cachedJson, json, methodNotAllowed } from './lib/http.ts';

export const config = { path: '/api/projects/:projectId/bootstrap' };

export default async function handler(
  req: Request,
  context: { params: { projectId: string } },
): Promise<Response> {
  if (req.method !== 'GET') return methodNotAllowed('GET');
  const denied = await authorizeProjectRead(req, context.params.projectId);
  if (denied) return json(denied.status, { error: denied.error });
  if (!isDatabaseConfigured()) return json(503, { error: 'No database is configured for this deployment.' });
  const bootstrap = await loadEvalBootstrap(context.params.projectId);
  if (!bootstrap) return json(404, { error: `Unknown project "${context.params.projectId}".` });
  return cachedJson(200, { bootstrap }, 60);
}
