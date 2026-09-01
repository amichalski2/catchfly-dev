/**
 * GET  /api/projects — the registry the dashboard boots from.
 * POST /api/projects — create one. Requires the installation admin key.
 */

import { listProjectsVisibleTo, orgsForUser } from './lib/account-store.ts';
import { checkWriteKey } from './lib/auth.ts';
import { isDatabaseConfigured } from './lib/db.ts';
import { BadJson, BodyTooLarge, json, methodNotAllowed, readJson } from './lib/http.ts';
import { createProject, listProjects, projectExists } from './lib/store.ts';
import { supabaseAuthEnabled, userFromRequest } from './lib/user-auth.ts';

export const config = { path: '/api/projects' };

const MAX_BODY_BYTES = 4 * 1024;
/** Project ids travel in URLs and WebMCP tool arguments; keep them boring. */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;

export default async function handler(req: Request): Promise<Response> {
  if (!isDatabaseConfigured()) {
    return json(503, { error: 'No database is configured for this deployment.' });
  }

  if (req.method === 'GET') {
    if (!supabaseAuthEnabled() || checkWriteKey(req) === null) {
      return json(200, { projects: await listProjects() });
    }
    const user = await userFromRequest(req);
    return json(200, { projects: await listProjectsVisibleTo(user?.userId ?? null) });
  }

  if (req.method !== 'POST') return methodNotAllowed('GET or POST');

  let org: { id: string } | null = null;
  if (checkWriteKey(req) !== null) {
    if (!supabaseAuthEnabled()) {
      const denied = checkWriteKey(req)!;
      return json(denied.status, { error: denied.error });
    }
    const user = await userFromRequest(req);
    if (!user) return json(401, { error: 'Sign in, or supply the installation admin key.' });
    org = (await orgsForUser(user.userId))[0] ?? null;
    if (!org) {
      return json(401, { error: 'Your account has no organization yet — call /api/me/provision first.' });
    }
  }

  let body: unknown;
  try {
    body = await readJson(req, MAX_BODY_BYTES);
  } catch (error) {
    if (error instanceof BodyTooLarge) return json(413, { error: error.message });
    if (error instanceof BadJson) return json(400, { error: error.message });
    throw error;
  }

  const input = body as { id?: unknown; name?: unknown; description?: unknown };
  if (typeof input.id !== 'string' || !ID_PATTERN.test(input.id)) {
    return json(400, {
      error: '"id" must be lowercase letters, digits and hyphens, 2–63 characters.',
    });
  }
  if (typeof input.name !== 'string' || input.name.trim().length === 0) {
    return json(400, { error: '"name" is required.' });
  }
  if (input.description !== undefined && typeof input.description !== 'string') {
    return json(400, { error: '"description" must be a string.' });
  }

  if (await projectExists(input.id)) {
    return json(409, { error: `Project "${input.id}" already exists.` });
  }

  const project = await createProject({
    id: input.id,
    name: input.name.trim(),
    description: input.description ?? '',
    ...(org ? { orgId: org.id } : {}),
  });
  return json(201, { project });
}
