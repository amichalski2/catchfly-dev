/**
 * The browser's `SessionsSource`: the same seam the smoke suite fills with an
 * in-memory array, filled here with HTTP.
 *
 * Its counterpart is `memorySessionsSource` in core, and the two are held to
 * the same answers in the session smoke suite. Nothing above this line knows which
 * one it is talking to.
 *
 * A deployment with no database answers 503 on these routes. That is not an
 * error to retry — it is a smaller product, and saying so once is better than
 * a spinner that never resolves.
 */

import type { SessionFilters } from '@catchfly/core/session-types.ts';
import { configureSessionsSource, resetSessions, setSessionsUnavailable } from '@catchfly/core/sessions-db.ts';

import {
  ApiError,
  fetchDeploymentComparison,
  fetchDeployments,
  fetchSession,
  fetchSessions,
  fetchToolProduction,
} from './api.ts';

/** Set once the API has said it has no session data, so we stop asking. */
let unavailable = false;

function handle(error: unknown): never {
  if (error instanceof ApiError && (error.status === 503 || error.status === 404)) {
    unavailable = true;
    setSessionsUnavailable();
  }
  throw error;
}

/** Points the session layer at one project's endpoints. */
export function connectSessions(projectId: string): void {
  if (unavailable) {
    setSessionsUnavailable();
    return;
  }

  resetSessions();
  configureSessionsSource({
    listDeployments: () => fetchDeployments(projectId).catch(handle),
    compareDeployments: (baselineDeploymentId, candidateDeploymentId) =>
      fetchDeploymentComparison(projectId, baselineDeploymentId, candidateDeploymentId).catch(handle),
    searchSessions: (filters: SessionFilters, cursor?: string | null, limit?: number) =>
      fetchSessions(projectId, filters, cursor, limit).catch(handle),
    getSession: (sessionId: string) => fetchSession(projectId, sessionId).catch(handle),
    getToolProduction: (toolName: string) => fetchToolProduction(projectId, toolName).catch(handle),
  });
}

/**
 * Probes once at boot so the dashboard knows whether it has a session half at
 * all, rather than discovering it when someone opens the tab.
 */
export async function probeSessions(projectId: string): Promise<boolean> {
  try {
    await fetchDeployments(projectId);
    return true;
  } catch (error) {
    if (error instanceof ApiError && (error.status === 503 || error.status === 404)) {
      unavailable = true;
      setSessionsUnavailable();
      return false;
    }
    // A transient network failure is not a verdict on the deployment.
    return true;
  }
}
