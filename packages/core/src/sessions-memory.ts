/**
 * The reference `SessionsSource`: sessions held in an array.
 *
 * This is what the SQL in netlify/functions/lib/session-store.ts has to agree
 * with. Keeping it in core rather than in the test scripts is deliberate — it
 * is the executable statement of what a source is supposed to answer, it is
 * what the session smoke suite compares the database against, and it is what an
 * embedder with a dataset already in memory would use.
 */

import {
  compareDeployments,
  deploymentRollups,
  filterSessions,
  pageSessions,
  summarizeSession,
  toolProduction,
} from './session-queries.ts';
import type { Deployment, Session, SessionFilters, SessionPage, ToolProduction } from './session-types.ts';
import type { SessionsSource } from './sessions-db.ts';

export function memorySessionsSource(deployments: Deployment[], sessions: Session[]): SessionsSource {
  const byId = new Map(sessions.map((session) => [session.id, session]));

  return {
    listDeployments: async () => deploymentRollups(deployments, sessions),

    compareDeployments: async (baselineDeploymentId: string, candidateDeploymentId: string) =>
      compareDeployments(sessions, deployments, baselineDeploymentId, candidateDeploymentId),

    searchSessions: async (filters: SessionFilters, cursor?: string | null, limit?: number): Promise<SessionPage> =>
      pageSessions(
        filterSessions(sessions, filters).map((session) => summarizeSession(session, deployments)),
        cursor,
        limit,
      ),

    getSession: async (sessionId: string): Promise<Session | null> => byId.get(sessionId) ?? null,

    getToolProduction: async (toolName: string): Promise<ToolProduction | null> => {
      const production = toolProduction(sessions, deployments, toolName);
      // A tool nobody has called is not an error, but it is worth distinguishing
      // from one with traffic — the caller decides how to say so.
      return production.calls === 0 ? null : production;
    },
  };
}
