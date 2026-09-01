/** GET /api/projects/:projectId/deployment-comparison — complete SQL-side comparison. */

import { isDatabaseConfigured } from './lib/db.ts';
import { authorizeProjectRead } from './lib/user-auth.ts';
import { compareDeploymentRows } from './lib/session-store.ts';
import { json, methodNotAllowed, projectJson } from './lib/http.ts';
import { projectExists } from './lib/store.ts';

export const config = { path: '/api/projects/:projectId/deployment-comparison' };

export default async function handler(
  req: Request,
  context: { params: { projectId: string } },
): Promise<Response> {
  if (req.method !== 'GET') return methodNotAllowed('GET');
  const denied = await authorizeProjectRead(req, context.params.projectId);
  if (denied) return json(denied.status, { error: denied.error });
  if (!isDatabaseConfigured()) return json(503, { error: 'No database is configured for this deployment.' });
  const { projectId } = context.params;
  if (!(await projectExists(projectId))) return json(404, { error: `Unknown project "${projectId}".` });
  const query = new URL(req.url).searchParams;
  const baseline = query.get('baselineDeploymentId');
  const candidate = query.get('candidateDeploymentId');
  if (!baseline || !candidate) {
    return json(400, { error: 'baselineDeploymentId and candidateDeploymentId are required.' });
  }
  try {
    return projectJson(
      projectId,
      200,
      { comparison: await compareDeploymentRows(projectId, baseline, candidate) },
      60,
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Unknown deployment:')) {
      return json(404, { error: error.message });
    }
    throw error;
  }
}
