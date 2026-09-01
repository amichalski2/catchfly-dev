import type { ApiKeyScope } from '@catchfly/core/product-types.ts';

import { authorizeProjectWrite } from './lib/user-auth.ts';
import { isDatabaseConfigured } from './lib/db.ts';
import { BadJson, BodyTooLarge, json, methodNotAllowed, readJson } from './lib/http.ts';
import { createProjectKey, listProjectKeys } from './lib/product-store.ts';
import { projectExists, projectIsReadOnly } from './lib/store.ts';

export const config = { path: '/api/projects/:projectId/keys' };
const SCOPES: ApiKeyScope[] = ['ingest', 'evals:write', 'admin'];

export default async function handler(
  req: Request,
  context: { params: { projectId: string } },
): Promise<Response> {
  if (!isDatabaseConfigured()) return json(503, { error: 'No database is configured for this deployment.' });
  const { projectId } = context.params;
  if (!(await projectExists(projectId))) return json(404, { error: `Unknown project "${projectId}".` });
  const grant = await authorizeProjectWrite(req, projectId);
  if (grant) return json(grant.status, { error: grant.error });
  if (req.method === 'GET') return json(200, { keys: await listProjectKeys(projectId) });
  if (req.method !== 'POST') return methodNotAllowed('GET or POST');
  if (await projectIsReadOnly(projectId)) return json(403, { error: 'The synthetic demo is read-only.' });
  let body: Record<string, unknown>;
  try {
    body = (await readJson(req, 8 * 1024)) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof BodyTooLarge || error instanceof BadJson) return json(400, { error: error.message });
    throw error;
  }
  const environmentId = body.environmentId;
  const name = body.name;
  const rawScopes = body.scopes ?? ['ingest'];
  if (typeof environmentId !== 'string' || environmentId === '') return json(400, { error: 'environmentId is required.' });
  if (typeof name !== 'string' || name.trim() === '') return json(400, { error: 'Key name is required.' });
  if (!Array.isArray(rawScopes) || rawScopes.length === 0 || rawScopes.some((scope) => !SCOPES.includes(scope as ApiKeyScope))) {
    return json(400, { error: `Scopes must use: ${SCOPES.join(', ')}.` });
  }
  const expiresAt = body.expiresAt;
  if (expiresAt !== undefined && (typeof expiresAt !== 'string' || Number.isNaN(Date.parse(expiresAt)))) {
    return json(400, { error: 'expiresAt must be an ISO timestamp.' });
  }
  const allowedOrigins = body.allowedOrigins;
  if (
    allowedOrigins !== undefined &&
    (!Array.isArray(allowedOrigins) ||
      allowedOrigins.some((origin) => typeof origin !== 'string' || !/^https?:\/\//.test(origin)))
  ) {
    return json(400, { error: 'allowedOrigins must be a list of http(s) origins.' });
  }
  try {
    return json(201, await createProjectKey(projectId, {
      environmentId,
      name: name.trim(),
      scopes: rawScopes as ApiKeyScope[],
      ...(typeof expiresAt === 'string' ? { expiresAt } : {}),
      ...(Array.isArray(allowedOrigins) ? { allowedOrigins: allowedOrigins as string[] } : {}),
    }));
  } catch (error) {
    if ((error as { code?: string }).code === '23503') return json(404, { error: `Unknown environment "${environmentId}".` });
    throw error;
  }
}
