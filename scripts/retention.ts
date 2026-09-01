/** Deletes measured telemetry past each environment's configured retention. */

import { existsSync } from 'node:fs';

import { sql } from '../netlify/functions/lib/db.ts';

if (existsSync('.env')) process.loadEnvFile?.();

const removedEvents = await sql().query(
  `delete from telemetry_events t
    using data_policies p
    where p.project_id = t.project_id and p.environment_id = t.environment_id
      and t.occurred_at < now() - make_interval(days => p.retention_days)`,
);
const removedBatches = await sql().query(
  `delete from ingest_batches b
    using data_policies p
    where p.project_id = b.project_id and p.environment_id = b.environment_id
      and b.received_at < now() - make_interval(days => p.retention_days)`,
);
const removedSessions = await sql().query(
  `delete from sessions s
    using data_policies p
    where p.project_id = s.project_id and p.environment_id = s.environment_id
      and s.data_origin = 'measured'
      and s.started_at < now() - make_interval(days => p.retention_days)`,
);
console.log(`Retention removed ${removedEvents.rowCount ?? 0} telemetry events, ${removedBatches.rowCount ?? 0} ingest batches and ${removedSessions.rowCount ?? 0} sessions.`);
await sql().end();
