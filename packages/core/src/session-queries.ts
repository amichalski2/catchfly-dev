/**
 * Deterministic query primitives over production sessions.
 *
 * The counterpart to queries.ts, and pure for the same reason: the browser
 * reads sessions over HTTP, but the smoke suite and the seed generator read the
 * very same functions in-process. That is not only convenience — the SQL in
 * netlify/functions/lib/session-store.ts has to answer identically to the code
 * here, and the session smoke suite checks exactly that. When the two disagree,
 * this file is the specification.
 */

import type {
  Deployment,
  DeploymentComparison,
  DeploymentRollup,
  Session,
  SessionFilters,
  SessionPage,
  SessionSummary,
  ToolProduction,
} from './session-types.ts';
import type { FailureCategory } from './types.ts';

// --- ordering and cursors ----------------------------------------------
//
// Sessions are listed newest first. The tiebreaker is the id, so that two
// sessions sharing a timestamp still have one defined order — without it a
// keyset cursor could skip or repeat a row.

function byRecency(a: { startedAt: string; id: string }, b: { startedAt: string; id: string }): number {
  return b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id);
}

/**
 * Opaque to callers; base64url so a cursor cannot be mistaken for an id and
 * hand-edited. Built on btoa/atob rather than Buffer because this module runs
 * in the browser as well as in Node.
 */
const TOTAL_PREFIX = 'v2|';

/**
 * `total` describes the whole filtered set, so it does not change from page to
 * page. Carrying it lets a paged reader count once rather than once per page —
 * which over 25k sessions is a full count-with-join every time. The prefixed
 * form is only used when a total is known; without one the cursor stays exactly
 * what it was, so cursors handed out before this existed still decode.
 */
export function encodeCursor(startedAt: string, id: string, total?: number): string {
  const body =
    total === undefined ? `${startedAt}|${id}` : `${TOTAL_PREFIX}${total}|${startedAt}|${id}`;
  const raw = btoa(encodeURIComponent(body));
  return raw.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export type DecodedCursor = { startedAt: string; id: string; total?: number };

/** Returns null for anything unparseable — callers answer 400, never 500. */
export function decodeCursor(cursor: string): DecodedCursor | null {
  let decoded: string;
  try {
    const padded = cursor.replace(/-/g, '+').replace(/_/g, '/');
    decoded = decodeURIComponent(atob(padded + '='.repeat((4 - (padded.length % 4)) % 4)));
  } catch {
    return null;
  }

  let total: number | undefined;
  if (decoded.startsWith(TOTAL_PREFIX)) {
    const rest = decoded.slice(TOTAL_PREFIX.length);
    const end = rest.indexOf('|');
    if (end <= 0) return null;
    const parsed = Number(rest.slice(0, end));
    if (!Number.isInteger(parsed) || parsed < 0) return null;
    total = parsed;
    decoded = rest.slice(end + 1);
  }

  const separator = decoded.lastIndexOf('|');
  if (separator <= 0 || separator === decoded.length - 1) return null;
  const startedAt = decoded.slice(0, separator);
  // A timestamp we cannot compare is a cursor we cannot honour.
  if (Number.isNaN(Date.parse(startedAt))) return null;
  return { startedAt, id: decoded.slice(separator + 1), ...(total === undefined ? {} : { total }) };
}

// --- filtering ---------------------------------------------------------

/** True when the session failed the person, whatever the individual calls returned. */
function isFailure(session: Session): boolean {
  return session.outcome === 'failed' || session.outcome === 'abandoned';
}

export function filterSessions(
  sessions: Session[],
  filters: SessionFilters = {},
): Session[] {
  const needle = filters.search?.trim().toLowerCase();

  return sessions.filter((session) => {
    if (filters.deploymentId && session.deploymentId !== filters.deploymentId) return false;
    if (filters.environment && session.environment !== filters.environment) return false;
    if (filters.outcome === 'any-failure' && !isFailure(session)) return false;
    if (filters.outcome && filters.outcome !== 'any-failure' && session.outcome !== filters.outcome) {
      return false;
    }
    if (filters.category && session.failureCategory !== filters.category) return false;
    if (filters.toolCalled && !session.toolCalls.some((call) => call.toolName === filters.toolCalled)) {
      return false;
    }
    if (filters.from && session.startedAt < filters.from) return false;
    if (filters.to && session.startedAt > filters.to) return false;
    if (needle) {
      const haystack = [session.intent ?? '', ...session.toolCalls.map((call) => call.toolName)]
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });
}

// --- summaries and pages -----------------------------------------------

export function summarizeSession(session: Session, deployments: Deployment[]): SessionSummary {
  const deployment = deployments.find((candidate) => candidate.id === session.deploymentId);
  let errorCallCount = 0;
  let totalDurationMs = 0;
  for (const call of session.toolCalls) {
    if (call.status === 'error') errorCallCount += 1;
    totalDurationMs += call.durationMs;
  }

  return {
    id: session.id,
    deploymentId: session.deploymentId,
    appVersionId: deployment?.appVersionId ?? '',
    environment: session.environment,
    startedAt: session.startedAt,
    ...(session.agent === undefined ? {} : { agent: session.agent }),
    ...(session.model === undefined ? {} : { model: session.model }),
    ...(session.intent === undefined ? {} : { intent: session.intent }),
    outcome: session.outcome,
    ...(session.failureCategory === undefined ? {} : { failureCategory: session.failureCategory }),
    ...(session.failureTool === undefined ? {} : { failureTool: session.failureTool }),
    toolCallCount: session.toolCalls.length,
    errorCallCount,
    totalDurationMs: Math.round(totalDurationMs),
  };
}

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

/**
 * One keyset page, newest first. Keyset rather than offset because sessions are
 * appended continuously: an offset page shifts under the reader, a keyset page
 * does not.
 */
export function pageSessions(
  summaries: SessionSummary[],
  cursor?: string | null,
  limit: number = DEFAULT_PAGE_SIZE,
): SessionPage {
  const size = Math.min(Math.max(Math.trunc(limit) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const ordered = [...summaries].sort(byRecency);

  let start = 0;
  if (cursor) {
    const decoded = decodeCursor(cursor);
    if (!decoded) throw new CursorError(cursor);
    start = ordered.findIndex((summary) => byRecency(summary, decoded) > 0);
    // A cursor past the end of the list is an empty last page, not an error.
    if (start < 0) start = ordered.length;
  }

  const page = ordered.slice(start, start + size);
  const last = page[page.length - 1];
  const more = start + page.length < ordered.length;

  return {
    sessions: page,
    total: ordered.length,
    nextCursor: more && last ? encodeCursor(last.startedAt, last.id, ordered.length) : null,
  };
}

/** Thrown for a cursor that cannot be decoded; the API turns it into a 400. */
export class CursorError extends Error {
  constructor(cursor: string) {
    super(`Cursor is not readable: ${cursor}`);
    this.name = 'CursorError';
  }
}

// --- deployments -------------------------------------------------------

export function deploymentRollups(deployments: Deployment[], sessions: Session[]): DeploymentRollup[] {
  return deployments
    .map((deployment) => {
      const own = sessions.filter((session) => session.deploymentId === deployment.id);
      let toolCallCount = 0;
      let errorCallCount = 0;
      for (const session of own) {
        toolCallCount += session.toolCalls.length;
        errorCallCount += session.toolCalls.filter((call) => call.status === 'error').length;
      }
      return {
        ...deployment,
        sessionCount: own.length,
        failedCount: own.filter(isFailure).length,
        toolCallCount,
        errorCallCount,
      };
    })
    .sort((a, b) => a.deployedAt.localeCompare(b.deployedAt) || a.id.localeCompare(b.id));
}

// --- tools -------------------------------------------------------------

/**
 * Matches PostgreSQL's `percentile_cont`: linear interpolation between the two
 * ranks straddling the requested position. Copied in behaviour, not in code, by
 * the SQL side — the session smoke suite asserts they agree.
 */
export function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const position = fraction * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

export function toolProduction(
  sessions: Session[],
  deployments: Deployment[],
  toolName: string,
): ToolProduction {
  const durations: number[] = [];
  const errorTypeCounts = new Map<string, number>();
  const perDeployment = new Map<string, { calls: number; errorCalls: number }>();
  let calls = 0;
  let errorCalls = 0;

  for (const session of sessions) {
    for (const call of session.toolCalls) {
      if (call.toolName !== toolName) continue;
      calls += 1;
      durations.push(call.durationMs);

      const bucket = perDeployment.get(session.deploymentId) ?? { calls: 0, errorCalls: 0 };
      bucket.calls += 1;

      if (call.status === 'error') {
        errorCalls += 1;
        bucket.errorCalls += 1;
        const type = call.errorType ?? 'unknown';
        errorTypeCounts.set(type, (errorTypeCounts.get(type) ?? 0) + 1);
      }
      perDeployment.set(session.deploymentId, bucket);
    }
  }

  durations.sort((a, b) => a - b);

  const byDeployment = deployments
    .filter((deployment) => perDeployment.has(deployment.id))
    .sort((a, b) => a.deployedAt.localeCompare(b.deployedAt) || a.id.localeCompare(b.id))
    .map((deployment) => {
      const bucket = perDeployment.get(deployment.id) ?? { calls: 0, errorCalls: 0 };
      return {
        deploymentId: deployment.id,
        appVersionId: deployment.appVersionId,
        calls: bucket.calls,
        errorCalls: bucket.errorCalls,
        successRate: bucket.calls === 0 ? 0 : round((bucket.calls - bucket.errorCalls) / bucket.calls),
      };
    });

  return {
    toolName,
    calls,
    errorCalls,
    successRate: calls === 0 ? 0 : round((calls - errorCalls) / calls),
    p50DurationMs: round(percentile(durations, 0.5)),
    p95DurationMs: round(percentile(durations, 0.95)),
    errorTypes: [...errorTypeCounts]
      .map(([errorType, count]) => ({ errorType, count }))
      .sort((a, b) => b.count - a.count || a.errorType.localeCompare(b.errorType)),
    byDeployment,
  };
}

/** Every tool name that appears in this set of sessions, sorted. */
export function toolNamesIn(sessions: Session[]): string[] {
  const names = new Set<string>();
  for (const session of sessions) {
    for (const call of session.toolCalls) names.add(call.toolName);
  }
  return [...names].sort();
}

// --- comparison --------------------------------------------------------

/**
 * The production-side "what changed?": per-tool execution success and failure
 * mix between two deployments. Interpretation is the caller's job, per the PRD
 * rule that Catchfly exposes primitives.
 */
export function compareDeployments(
  sessions: Session[],
  deployments: Deployment[],
  baselineDeploymentId: string,
  candidateDeploymentId: string,
): DeploymentComparison {
  const rollups = deploymentRollups(deployments, sessions);
  const baseline = rollups.find((rollup) => rollup.id === baselineDeploymentId);
  const candidate = rollups.find((rollup) => rollup.id === candidateDeploymentId);
  if (!baseline) throw new Error(`Unknown deployment: ${baselineDeploymentId}`);
  if (!candidate) throw new Error(`Unknown deployment: ${candidateDeploymentId}`);

  const baselineSessions = sessions.filter((session) => session.deploymentId === baselineDeploymentId);
  const candidateSessions = sessions.filter((session) => session.deploymentId === candidateDeploymentId);

  const names = new Set([...toolNamesIn(baselineSessions), ...toolNamesIn(candidateSessions)]);
  const tools = [...names]
    .map((toolName) => {
      const before = toolProduction(baselineSessions, deployments, toolName);
      const after = toolProduction(candidateSessions, deployments, toolName);
      return {
        toolName,
        baselineCalls: before.calls,
        candidateCalls: after.calls,
        baselineSuccessRate: before.successRate,
        candidateSuccessRate: after.successRate,
        successRateDelta: round(after.successRate - before.successRate),
      };
    })
    .sort((a, b) => a.successRateDelta - b.successRateDelta || a.toolName.localeCompare(b.toolName));

  const countCategories = (subset: Session[]): Map<FailureCategory, number> => {
    const counts = new Map<FailureCategory, number>();
    for (const session of subset) {
      if (!session.failureCategory) continue;
      counts.set(session.failureCategory, (counts.get(session.failureCategory) ?? 0) + 1);
    }
    return counts;
  };

  const before = countCategories(baselineSessions);
  const after = countCategories(candidateSessions);
  const categories = [...new Set([...before.keys(), ...after.keys()])]
    .map((category) => {
      const baselineCount = before.get(category) ?? 0;
      const candidateCount = after.get(category) ?? 0;
      return { category, baseline: baselineCount, candidate: candidateCount, delta: candidateCount - baselineCount };
    })
    .sort((a, b) => b.delta - a.delta || a.category.localeCompare(b.category));

  return { baseline, candidate, tools, categories };
}
