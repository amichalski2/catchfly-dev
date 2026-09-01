/** GET /api/projects/:projectId/eval-suite — export cases in webmcp-evals format. */

import { isDatabaseConfigured } from './lib/db.ts';
import { searchEvalCases } from './lib/eval-read-store.ts';
import { json, methodNotAllowed } from './lib/http.ts';
import { projectExists } from './lib/store.ts';
import { authorizeProjectWrite } from './lib/user-auth.ts';

export const config = { path: '/api/projects/:projectId/eval-suite' };

export default async function handler(
  req: Request,
  context: { params: { projectId: string } },
): Promise<Response> {
  if (req.method !== 'GET') return methodNotAllowed('GET');
  if (!isDatabaseConfigured()) return json(503, { error: 'No database is configured for this deployment.' });
  const { projectId } = context.params;
  const denied = await authorizeProjectWrite(req, projectId, 'evals:write');
  if (denied) return json(denied.status, { error: denied.error });
  if (!(await projectExists(projectId))) return json(404, { error: `Unknown project "${projectId}".` });

  const cases = [];
  let cursor: string | null = null;
  do {
    const page = await searchEvalCases(projectId, undefined, cursor, 200);
    cases.push(...page.cases);
    cursor = page.nextCursor;
  } while (cursor);

  return json(200, {
    evals: cases.map((entry) => ({
      name: entry.name,
      messages: [{ role: 'user', type: 'message', content: entry.prompt }],
      expectedCall: entry.expectedCall,
    })),
  });
}
