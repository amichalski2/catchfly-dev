import type { EnvironmentKind } from '@catchfly/core/product-types.ts';

import { authorizeProjectRead, authorizeProjectWrite } from './lib/user-auth.ts';
import { isDatabaseConfigured } from './lib/db.ts';
import { BadJson, BodyTooLarge, json, methodNotAllowed, readJson } from './lib/http.ts';
import { createEnvironment, listEnvironments } from './lib/product-store.ts';
import { projectExists, projectIsReadOnly } from './lib/store.ts';

export const config = { path: '/api/projects/:projectId/environments' };

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;
const KINDS: EnvironmentKind[] = ['development', 'staging', 'production'];

export default async function handler(
  req: Request,
  context: { params: { projectId: string } },
): Promise<Response> {
  if (!isDatabaseConfigured()) return json(503, { error: 'No database is configured for this deployment.' });
  const { projectId } = context.params;
  if (!(await projectExists(projectId))) return json(404, { error: `Unknown project "${projectId}".` });
  if (req.method === 'GET') {
    const readDenied = await authorizeProjectRead(req, projectId);
    if (readDenied) return json(readDenied.status, { error: readDenied.error });
    return json(200, { environments: await listEnvironments(projectId) });
  }
  if (req.method !== 'POST') return methodNotAllowed('GET or POST');
  if (await projectIsReadOnly(projectId)) return json(403, { error: 'The synthetic demo is read-only.' });
  const writeDenied = await authorizeProjectWrite(req, projectId);
  if (writeDenied) return json(writeDenied.status, { error: writeDenied.error });
  let body: Record<string, unknown>;
  try {
    body = (await readJson(req, 8 * 1024)) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof BodyTooLarge || error instanceof BadJson) return json(400, { error: error.message });
    throw error;
  }
  const id = body.id;
  const name = body.name;
  const kind = body.kind;
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) return json(400, { error: 'Invalid environment id.' });
  if (typeof name !== 'string' || name.trim() === '') return json(400, { error: 'Environment name is required.' });
  if (typeof kind !== 'string' || !KINDS.includes(kind as EnvironmentKind)) {
    return json(400, { error: `Environment kind must be one of: ${KINDS.join(', ')}.` });
  }
  try {
    return json(201, { environment: await createEnvironment(projectId, { id, name: name.trim(), kind: kind as EnvironmentKind }) });
  } catch (error) {
    if ((error as { code?: string }).code === '23505') return json(409, { error: `Environment "${id}" already exists.` });
    throw error;
  }
}
