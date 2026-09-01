/** GET /api/projects/:projectId/eval-runs/:runId/results — paginated attempt summaries. */

import type { EvalResultFilters, FailureCategory, Outcome } from '@catchfly/core/types.ts';

import { isDatabaseConfigured } from './lib/db.ts';
import { authorizeProjectRead } from './lib/user-auth.ts';
import { EvalCursorError, searchEvalResults } from './lib/eval-read-store.ts';
import { json, methodNotAllowed, projectJson } from './lib/http.ts';
import { projectExists } from './lib/store.ts';

export const config = { path: '/api/projects/:projectId/eval-runs/:runId/results' };

const OUTCOMES: Outcome[] = ['pass', 'fail', 'error'];
const FAILURE_CATEGORIES: FailureCategory[] = [
  'tool-selection',
  'structured-output',
  'argument-errors',
  'hallucinated-tool',
  'sequencing',
  'error',
];

export default async function handler(
  req: Request,
  context: { params: { projectId: string; runId: string } },
): Promise<Response> {
  if (req.method !== 'GET') return methodNotAllowed('GET');
  const denied = await authorizeProjectRead(req, context.params.projectId);
  if (denied) return json(denied.status, { error: denied.error });
  if (!isDatabaseConfigured()) return json(503, { error: 'No database is configured for this deployment.' });
  const { projectId, runId } = context.params;
  if (!(await projectExists(projectId))) return json(404, { error: `Unknown project "${projectId}".` });

  const query = new URL(req.url).searchParams;
  const outcome = query.get('outcome');
  if (outcome && !OUTCOMES.includes(outcome as Outcome)) {
    return json(400, { error: `Unknown outcome "${outcome}".` });
  }
  const category = query.get('category');
  if (category && !FAILURE_CATEGORIES.includes(category as FailureCategory)) {
    return json(400, { error: `Unknown category "${category}".` });
  }
  const rawLimit = query.get('limit');
  const limit = rawLimit === null ? undefined : Number.parseInt(rawLimit, 10);
  if (limit !== undefined && (Number.isNaN(limit) || limit < 1)) {
    return json(400, { error: `"limit" must be a positive integer, got ${rawLimit}.` });
  }
  const filters: EvalResultFilters = {
    ...(outcome ? { outcome: outcome as Outcome } : {}),
    ...(category ? { category: category as FailureCategory } : {}),
    ...(query.get('caseId') ? { caseId: query.get('caseId')! } : {}),
  };
  try {
    return projectJson(
      projectId,
      200,
      await searchEvalResults(projectId, runId, filters, query.get('cursor'), limit),
      60,
    );
  } catch (error) {
    if (error instanceof EvalCursorError) return json(400, { error: error.message });
    throw error;
  }
}
