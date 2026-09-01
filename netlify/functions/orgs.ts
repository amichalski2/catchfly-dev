import { orgRole, renameOrg } from './lib/account-store.ts';
import { isDatabaseConfigured } from './lib/db.ts';
import { BadJson, BodyTooLarge, json, methodNotAllowed, readJson } from './lib/http.ts';
import { supabaseAuthEnabled, userFromRequest } from './lib/user-auth.ts';

export const config = { path: '/api/orgs/:orgId' };

export default async function handler(
  req: Request,
  context: { params: { orgId: string } },
): Promise<Response> {
  if (req.method !== 'PATCH') return methodNotAllowed('PATCH');
  if (!isDatabaseConfigured()) {
    return json(503, { error: 'No database is configured for this deployment.' });
  }
  if (!supabaseAuthEnabled()) {
    return json(503, { error: 'Account authentication is not configured on this deployment.' });
  }

  const user = await userFromRequest(req);
  if (!user) return json(401, { error: 'Sign in to change this organization.' });

  const { orgId } = context.params;
  const role = await orgRole(orgId, user.userId);
  if (role !== 'owner' && role !== 'admin') {
    return json(401, { error: 'Only an organization owner or admin can rename it.' });
  }

  let body: Record<string, unknown>;
  try {
    body = (await readJson(req, 4 * 1024)) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof BodyTooLarge || error instanceof BadJson) {
      return json(400, { error: error.message });
    }
    throw error;
  }
  const name = body.name;
  if (typeof name !== 'string' || name.trim() === '') {
    return json(400, { error: '"name" is required.' });
  }

  await renameOrg(orgId, name.trim());
  return json(200, { org: { id: orgId, name: name.trim() } });
}
