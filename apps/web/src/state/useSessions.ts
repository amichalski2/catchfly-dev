/**
 * React's view of the session registry.
 *
 * Same arrangement as useAnalysis.ts, and for the same reason: the registry is
 * read by WebMCP tools and Node scripts as well as by components, so it stays
 * React-free and the binding lives here.
 *
 * Each hook does two things — asks the registry to fetch if it has not already,
 * and re-renders when it does. The `ensure` calls are idempotent, so calling
 * them during render is safe and keeps the component from needing an effect
 * just to say "I would like this data".
 */

import { useSyncExternalStore } from 'react';

import type { SessionFilters } from '@catchfly/core/session-types.ts';
import {
  ensureDeployments,
  ensureSession,
  ensureSessionList,
  ensureToolProduction,
  getDeployments,
  getSessionEntry,
  getSessionList,
  getToolProductionEntry,
  isSessionsAvailable,
  type Loadable,
  type SessionListValue,
} from '@catchfly/core/sessions-db.ts';
import type { DeploymentRollup, Session, ToolProduction } from '@catchfly/core/session-types.ts';
import { getSessionsVersion, subscribeSessions } from '@catchfly/core/sessions-db.ts';

/** Ties a read to the registry's change feed. */
function useSessionsVersion(): number {
  return useSyncExternalStore(subscribeSessions, getSessionsVersion, getSessionsVersion);
}

/**
 * Whether this deployment has session data at all. A dashboard without a
 * database still has an eval half, and should say so rather than spin.
 */
export function useSessionsAvailable(): boolean {
  void useSessionsVersion();
  return isSessionsAvailable();
}

export function useDeployments(): Loadable<DeploymentRollup[]> | null {
  void useSessionsVersion();
  ensureDeployments();
  return getDeployments();
}

/** One filtered list, accumulating pages as the reader asks for more. */
export function useSessionList(filters: SessionFilters, pageSize = 50): Loadable<SessionListValue> | null {
  void useSessionsVersion();
  ensureSessionList(filters, pageSize);
  return getSessionList(filters);
}

export function useSession(sessionId: string | null): Loadable<Session> | null {
  void useSessionsVersion();
  if (sessionId) ensureSession(sessionId);
  return sessionId ? getSessionEntry(sessionId) : null;
}

export function useToolProduction(toolName: string | null): Loadable<ToolProduction> | null {
  void useSessionsVersion();
  if (toolName) ensureToolProduction(toolName);
  return toolName ? getToolProductionEntry(toolName) : null;
}
