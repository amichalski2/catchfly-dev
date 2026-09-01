import { checkWriteKey } from './lib/auth.ts';
import { isDatabaseConfigured, sql } from './lib/db.ts';
import { json, methodNotAllowed } from './lib/http.ts';

export const config = { path: '/api/system' };

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'GET') return methodNotAllowed('GET');
  if (!isDatabaseConfigured()) return json(503, { error: 'No database is configured for this deployment.' });
  const denied = checkWriteKey(req);
  if (denied) return json(denied.status, { error: denied.error });
  const { rows } = await sql().query<{
    projects: string; sessions: string; events: string; rejected: string; database_bytes: string; latest_migration: string | null;
  }>(
    `select (select count(*) from projects) as projects,
            (select count(*) from sessions) as sessions,
            (select count(*) from telemetry_events) as events,
            (select coalesce(sum(rejected_count), 0) from ingest_batches) as rejected,
            pg_database_size(current_database()) as database_bytes,
            (select max(name) from schema_migrations) as latest_migration`,
  );
  const row = rows[0];
  return json(200, {
    status: 'ready',
    database: {
      bytes: Number(row.database_bytes),
      latestMigration: row.latest_migration,
    },
    counts: {
      projects: Number(row.projects), sessions: Number(row.sessions), events: Number(row.events), rejectedEvents: Number(row.rejected),
    },
    runtime: { node: process.version, version: process.env.npm_package_version ?? 'development' },
  });
}
