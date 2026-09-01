/**
 * GET /api/projects/:projectId/tools/:toolName/profile — how one tool behaves
 * in production.
 *
 * Only the production half. The schema history and the eval scores come from
 * the dataset the client already holds, so sending them again would be a second
 * copy that can disagree with the first.
 */

import { isDatabaseConfigured } from './lib/db.ts';
import { authorizeProjectRead } from './lib/user-auth.ts';
import { json, methodNotAllowed } from './lib/http.ts';
import { getToolProduction } from './lib/session-store.ts';
import { projectExists } from './lib/store.ts';

export const config = { path: '/api/projects/:projectId/tools/:toolName/profile' };

export default async function handler(
  req: Request,
  context: { params: { projectId: string; toolName: string } },
): Promise<Response> {
  if (req.method !== 'GET') return methodNotAllowed('GET');
  const denied = await authorizeProjectRead(req, context.params.projectId);
  if (denied) return json(denied.status, { error: denied.error });
  if (!isDatabaseConfigured()) {
    return json(503, { error: 'No database is configured for this deployment.' });
  }

  const { projectId, toolName } = context.params;
  if (!(await projectExists(projectId))) {
    return json(404, { error: `Unknown project "${projectId}".` });
  }

  const production = await getToolProduction(projectId, toolName);
  if (!production) {
    // A declared tool nobody has called is a real, useful answer — it is how a
    // reviewer discovers that agents stopped reaching for it.
    return json(200, {
      production: {
        toolName,
        calls: 0,
        errorCalls: 0,
        successRate: 0,
        p50DurationMs: 0,
        p95DurationMs: 0,
        errorTypes: [],
        byDeployment: [],
      },
    });
  }

  return json(200, { production });
}
