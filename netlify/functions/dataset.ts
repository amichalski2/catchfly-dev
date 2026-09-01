/**
 * GET /api/projects/:projectId/dataset — the whole project, as the client's
 * in-memory index expects it.
 *
 * This answers with the complete dataset because everything downstream — the
 * query layer, the selectors, the WebMCP tools — is built on a full index.
 * That is fine at the current scale (single-digit MB) and explicitly not fine
 * forever: a serverless response is capped around 6 MB, so the first project
 * that outgrows it needs pagination here rather than a bigger payload.
 */

import { isDatabaseConfigured } from './lib/db.ts';
import { authorizeProjectRead } from './lib/user-auth.ts';
import { json, methodNotAllowed } from './lib/http.ts';
import { loadDataset } from './lib/store.ts';

export const config = { path: '/api/projects/:projectId/dataset' };

/** Warn well before the platform limit, while there is still room to act. */
const PAYLOAD_WARN_BYTES = 4 * 1024 * 1024;

export default async function handler(req: Request, context: { params: { projectId: string } }): Promise<Response> {
  if (req.method !== 'GET') return methodNotAllowed('GET');
  const denied = await authorizeProjectRead(req, context.params.projectId);
  if (denied) return json(denied.status, { error: denied.error });
  if (!isDatabaseConfigured()) {
    return json(503, { error: 'No database is configured for this deployment.' });
  }

  const { projectId } = context.params;
  const dataset = await loadDataset(projectId);
  if (!dataset) return json(404, { error: `Unknown project "${projectId}".` });

  const body = JSON.stringify(dataset);
  if (body.length > PAYLOAD_WARN_BYTES) {
    console.warn(
      `dataset ${projectId} is ${(body.length / 1024 / 1024).toFixed(1)} MB — approaching the response limit`,
    );
  }

  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
