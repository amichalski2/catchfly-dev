import { isDatabaseConfigured, sql } from './lib/db.ts';
import { json, methodNotAllowed } from './lib/http.ts';
import { authMode, AuthConfigurationError } from './lib/user-auth.ts';

export const config = { path: '/health/ready' };

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'GET') return methodNotAllowed('GET');
  try {
    authMode();
  } catch (error) {
    if (error instanceof AuthConfigurationError) {
      return json(503, { status: 'not-ready', configuration: error.message });
    }
    throw error;
  }
  if (!isDatabaseConfigured()) return json(503, { status: 'not-ready', database: 'unconfigured' });
  try {
    const migrations = await sql().query<{ latest: string | null }>('select max(name) as latest from schema_migrations');
    return json(200, { status: 'ready', database: 'connected', latestMigration: migrations.rows[0]?.latest ?? null });
  } catch {
    return json(503, { status: 'not-ready', database: 'unreachable' });
  }
}
