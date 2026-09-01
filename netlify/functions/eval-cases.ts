/** GET /api/projects/:projectId/eval-cases — paginated case summaries. */

import { isDatabaseConfigured } from './lib/db.ts';
import { authorizeProjectRead } from './lib/user-auth.ts';
import { EvalCursorError, searchEvalCases } from './lib/eval-read-store.ts';
import { cachedJson, json, methodNotAllowed } from './lib/http.ts';
import { projectExists } from './lib/store.ts';

export const config = { path: '/api/projects/:projectId/eval-cases' };

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
  const rawLimit = query.get('limit');
  const limit = rawLimit === null ? undefined : Number.parseInt(rawLimit, 10);
  if (limit !== undefined && (Number.isNaN(limit) || limit < 1)) {
    return json(400, { error: `"limit" must be a positive integer, got ${rawLimit}.` });
  }
  try {
    return cachedJson(200, await searchEvalCases(projectId, query.get('search') ?? undefined, query.get('cursor'), limit), 60);
  } catch (error) {
    if (error instanceof EvalCursorError) return json(400, { error: error.message });
    throw error;
  }
}
