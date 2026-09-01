import { isDatabaseConfigured } from './lib/db.ts';
import { authorizeProjectRead } from './lib/user-auth.ts';
import { json, methodNotAllowed } from './lib/http.ts';
import { loadProjectOverview } from './lib/overview-store.ts';
import { projectExists } from './lib/store.ts';

export const config = { path: '/api/projects/:projectId/overview' };

export default async function handler(req: Request, context: { params: { projectId: string } }): Promise<Response> {
  if (req.method !== 'GET') return methodNotAllowed('GET');
  const denied = await authorizeProjectRead(req, context.params.projectId);
  if (denied) return json(denied.status, { error: denied.error });
  if (!isDatabaseConfigured()) return json(503, { error: 'No database is configured for this deployment.' });
  const { projectId } = context.params;
  if (!(await projectExists(projectId))) return json(404, { error: `Unknown project "${projectId}".` });
  return json(200, { overview: await loadProjectOverview(projectId) });
}
