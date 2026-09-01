import { listProjectsVisibleTo, orgsForUser, upsertProfile } from './lib/account-store.ts';
import { isDatabaseConfigured } from './lib/db.ts';
import { json, methodNotAllowed } from './lib/http.ts';
import { supabaseAuthEnabled, userFromRequest } from './lib/user-auth.ts';

export const config = { path: '/api/me' };

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'GET') return methodNotAllowed('GET');
  if (!isDatabaseConfigured()) {
    return json(503, { error: 'No database is configured for this deployment.' });
  }
  if (!supabaseAuthEnabled()) {
    return json(503, { error: 'Account authentication is not configured on this deployment.' });
  }

  const user = await userFromRequest(req);
  if (!user) return json(401, { error: 'Sign in to read your account.' });

  await upsertProfile(user);
  const orgs = await orgsForUser(user.userId);
  const projects = await listProjectsVisibleTo(user.userId);
  return json(200, {
    user: { id: user.userId, email: user.email },
    orgs,
    projects,
  });
}
