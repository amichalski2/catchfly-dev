import { provisionFirstProject, upsertProfile } from './lib/account-store.ts';
import { isDatabaseConfigured } from './lib/db.ts';
import { BadJson, json, methodNotAllowed, readJson } from './lib/http.ts';
import { supabaseAuthEnabled, userFromRequest } from './lib/user-auth.ts';

export const config = { path: '/api/me/provision' };

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return methodNotAllowed('POST');
  if (!isDatabaseConfigured()) {
    return json(503, { error: 'No database is configured for this deployment.' });
  }
  if (!supabaseAuthEnabled()) {
    return json(503, { error: 'Account authentication is not configured on this deployment.' });
  }

  const user = await userFromRequest(req);
  if (!user) return json(401, { error: 'Sign in to provision a workspace.' });

  let body: Record<string, unknown>;
  try {
    body = req.body === null ? {} : await readJson(req, 8 * 1024) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof BadJson) return json(400, { error: error.message });
    throw error;
  }
  const rawOrigins = body.allowedOrigins;
  if (
    rawOrigins !== undefined &&
    (!Array.isArray(rawOrigins) || rawOrigins.some((origin) => typeof origin !== 'string'))
  ) {
    return json(400, { error: 'allowedOrigins must be a list of http(s) origins.' });
  }
  const allowedOrigins: string[] = [];
  for (const origin of (rawOrigins ?? []) as string[]) {
    try {
      const parsed = new URL(origin);
      if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.origin !== origin) {
        return json(400, { error: `"${origin}" is not an http(s) origin.` });
      }
      allowedOrigins.push(parsed.origin);
    } catch {
      return json(400, { error: `"${origin}" is not an http(s) origin.` });
    }
  }

  await upsertProfile(user);
  const provisioned = await provisionFirstProject(user, { allowedOrigins });
  return json(provisioned.created ? 201 : 200, provisioned);
}
