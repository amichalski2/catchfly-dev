/**
 * GET /api/projects/:projectId/sessions/:sessionId — one session, with every
 * call it made.
 *
 * Separate from the list because the two carry different weight: a list row is
 * counts, a detail row is arguments, results and narration. Loading the second
 * shape for a page of fifty would be most of a megabyte nobody reads.
 */

import { isDatabaseConfigured } from './lib/db.ts';
import { authorizeProjectRead } from './lib/user-auth.ts';
import { json, methodNotAllowed } from './lib/http.ts';
import { getSession } from './lib/session-store.ts';

export const config = { path: '/api/projects/:projectId/sessions/:sessionId' };

export default async function handler(
  req: Request,
  context: { params: { projectId: string; sessionId: string } },
): Promise<Response> {
  if (req.method !== 'GET') return methodNotAllowed('GET');
  const denied = await authorizeProjectRead(req, context.params.projectId);
  if (denied) return json(denied.status, { error: denied.error });
  if (!isDatabaseConfigured()) {
    return json(503, { error: 'No database is configured for this deployment.' });
  }

  const { projectId, sessionId } = context.params;
  const session = await getSession(projectId, sessionId);
  if (!session) return json(404, { error: `Unknown session "${sessionId}".` });

  return json(200, { session });
}
