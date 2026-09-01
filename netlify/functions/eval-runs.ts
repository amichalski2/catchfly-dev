/** GET /api/projects/:projectId/eval-runs — paginated eval run summaries. */

import type { EvalRunFilters } from '@catchfly/core/types.ts';

import { isDatabaseConfigured } from './lib/db.ts';
import { authorizeProjectRead } from './lib/user-auth.ts';
import { EvalCursorError, searchEvalRuns } from './lib/eval-read-store.ts';
import { cachedJson, json, methodNotAllowed } from './lib/http.ts';
import { projectExists } from './lib/store.ts';

export const config = { path: '/api/projects/:projectId/eval-runs' };

function timestamp(value: string | null, name: string): string | Response | undefined {
  if (!value) return undefined;
  if (Number.isNaN(Date.parse(value))) return json(400, { error: `"${name}" is not a timestamp: ${value}` });
  return value;
}

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
  const from = timestamp(query.get('from'), 'from');
  if (from instanceof Response) return from;
  const to = timestamp(query.get('to'), 'to');
  if (to instanceof Response) return to;
  const rawLimit = query.get('limit');
  const limit = rawLimit === null ? undefined : Number.parseInt(rawLimit, 10);
  if (limit !== undefined && (Number.isNaN(limit) || limit < 1)) {
    return json(400, { error: `"limit" must be a positive integer, got ${rawLimit}.` });
  }
  const filters: EvalRunFilters = {
    ...(query.get('appVersionId') ? { appVersionId: query.get('appVersionId')! } : {}),
    ...(query.get('model') ? { model: query.get('model')! } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  };
  try {
    return cachedJson(200, await searchEvalRuns(projectId, filters, query.get('cursor'), limit), 60);
  } catch (error) {
    if (error instanceof EvalCursorError) return json(400, { error: error.message });
    throw error;
  }
}
