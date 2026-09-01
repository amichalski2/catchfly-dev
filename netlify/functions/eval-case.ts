/** GET /api/projects/:projectId/eval-cases/:caseId — one full case definition. */

import { isDatabaseConfigured } from './lib/db.ts';
import { authorizeProjectRead } from './lib/user-auth.ts';
import { getEvalCase } from './lib/eval-read-store.ts';
import { json, methodNotAllowed, projectJson } from './lib/http.ts';
import { projectExists } from './lib/store.ts';

export const config = { path: '/api/projects/:projectId/eval-cases/:caseId' };

export default async function handler(
  req: Request,
  context: { params: { projectId: string; caseId: string } },
): Promise<Response> {
  if (req.method !== 'GET') return methodNotAllowed('GET');
  const denied = await authorizeProjectRead(req, context.params.projectId);
  if (denied) return json(denied.status, { error: denied.error });
  if (!isDatabaseConfigured()) return json(503, { error: 'No database is configured for this deployment.' });
  const { projectId, caseId } = context.params;
  if (!(await projectExists(projectId))) return json(404, { error: `Unknown project "${projectId}".` });
  const evalCase = await getEvalCase(projectId, caseId);
  if (!evalCase) return json(404, { error: `Unknown eval case "${caseId}".` });
  return projectJson(context.params.projectId, 200, { case: evalCase }, 60);
}
