/**
 * GET /api/projects/:projectId/sessions — one keyset page of sessions.
 *
 * The first endpoint in Catchfly that does not answer with everything it has.
 * Sessions accumulate without bound, so they are read a page at a time with an
 * opaque cursor rather than an offset: traffic arrives while a reviewer reads,
 * and an offset page would shift under them.
 *
 * Filters are validated here rather than trusted, and an unrecognised value is
 * answered with the set that would have worked — the same courtesy the WebMCP
 * tools extend to an agent.
 */

import type { SessionFilters } from '@catchfly/core/session-types.ts';
import type { FailureCategory } from '@catchfly/core/types.ts';

import { isDatabaseConfigured } from './lib/db.ts';
import { authorizeProjectRead } from './lib/user-auth.ts';
import { json, methodNotAllowed } from './lib/http.ts';
import { BadCursor, searchSessions } from './lib/session-store.ts';
import { projectExists } from './lib/store.ts';

export const config = { path: '/api/projects/:projectId/sessions' };

const OUTCOMES = ['completed', 'failed', 'abandoned', 'unknown', 'any-failure'] as const;
const FAILURE_CATEGORIES: FailureCategory[] = [
  'tool-selection',
  'structured-output',
  'argument-errors',
  'hallucinated-tool',
  'sequencing',
  'error',
];

/** An ISO timestamp we cannot compare is a filter we cannot honour. */
const isTimestamp = (value: string) => !Number.isNaN(Date.parse(value));

export default async function handler(
  req: Request,
  context: { params: { projectId: string } },
): Promise<Response> {
  if (req.method !== 'GET') return methodNotAllowed('GET');
  const denied = await authorizeProjectRead(req, context.params.projectId);
  if (denied) return json(denied.status, { error: denied.error });
  if (!isDatabaseConfigured()) {
    return json(503, { error: 'No database is configured for this deployment.' });
  }

  const { projectId } = context.params;
  if (!(await projectExists(projectId))) {
    return json(404, { error: `Unknown project "${projectId}".` });
  }

  const query = new URL(req.url).searchParams;
  const filters: SessionFilters = {};

  const deploymentId = query.get('deploymentId');
  if (deploymentId) filters.deploymentId = deploymentId;

  const environment = query.get('environment');
  if (environment) filters.environment = environment;

  const outcome = query.get('outcome');
  if (outcome) {
    if (!OUTCOMES.includes(outcome as (typeof OUTCOMES)[number])) {
      return json(400, { error: `Unknown outcome "${outcome}". Expected one of: ${OUTCOMES.join(', ')}.` });
    }
    filters.outcome = outcome as SessionFilters['outcome'];
  }

  const category = query.get('category');
  if (category) {
    if (!FAILURE_CATEGORIES.includes(category as FailureCategory)) {
      return json(400, {
        error: `Unknown category "${category}". Expected one of: ${FAILURE_CATEGORIES.join(', ')}.`,
      });
    }
    filters.category = category as FailureCategory;
  }

  const toolCalled = query.get('toolCalled');
  if (toolCalled) filters.toolCalled = toolCalled;

  const search = query.get('search');
  if (search) filters.search = search;

  for (const bound of ['from', 'to'] as const) {
    const value = query.get(bound);
    if (!value) continue;
    if (!isTimestamp(value)) {
      return json(400, { error: `"${bound}" is not a timestamp: ${value}` });
    }
    filters[bound] = value;
  }

  const rawLimit = query.get('limit');
  const limit = rawLimit === null ? undefined : Number.parseInt(rawLimit, 10);
  if (limit !== undefined && (Number.isNaN(limit) || limit < 1)) {
    return json(400, { error: `"limit" must be a positive integer, got ${rawLimit}.` });
  }

  try {
    return json(200, await searchSessions(projectId, filters, query.get('cursor'), limit));
  } catch (error) {
    // A cursor the store cannot resume from is the caller's problem to fix by
    // starting over, not an internal failure.
    if (error instanceof BadCursor) {
      return json(400, { error: error.message });
    }
    throw error;
  }
}
