# Self-hosting Catchfly

Catchfly is a single-organization application backed by PostgreSQL. The Docker
image serves the dashboard and API from one process; PostgreSQL remains the
durable system of record.

## Production checklist

1. Generate a random `CATCHFLY_ADMIN_KEY` of at least 32 bytes. For accounts,
   set `CATCHFLY_AUTH_MODE=supabase` plus `SUPABASE_URL` (and
   `SUPABASE_JWT_SECRET` on a self-hosted Supabase); `none` keeps the dashboard
   open and admin-key-gated for writes.
2. Put TLS in front of port 8888. Neither project keys nor bearer tokens
   should cross an unencrypted network.
3. Use a managed PostgreSQL service or back up the `catchfly-data` volume.
4. Run `npm run retention` daily. Each environment's policy controls how long
   measured telemetry and its session projection remain.
5. Monitor `/health/live` and `/health/ready`. Readiness includes a database
   query and reports the latest applied migration.
6. Keep runtime SDK keys separate from CI eval keys. Rotate or revoke them from
   Sources when an integration is retired.

The Compose configuration requires an installation admin secret and explicitly defaults to
`CATCHFLY_AUTH_MODE=none`. Set `CATCHFLY_AUTH_MODE=supabase` for any Internet-facing deployment;
Catchfly refuses to start when the mode is missing, misspelled, or lacks its required Supabase
configuration.

## Upgrade and rollback

Before upgrading, take a PostgreSQL backup. The container applies forward-only
SQL migrations before starting the server. Deploy the new image, wait for
`/health/ready`, then check System in the dashboard. Roll application code back
only if the new migration remains backward-compatible; otherwise restore the
database backup together with the previous image.

## Backups

For the bundled database, create logical backups from the Compose service:

```bash
docker compose exec -T db pg_dump -U catchfly -d catchfly -Fc > catchfly.dump
```

Restore into an empty database with `pg_restore`. Test restore procedures on a
schedule; an untested backup is not a recovery plan.

## Data and security boundaries

- The installation admin key creates projects and can administer every project.
- Project keys are stored only as SHA-256 digests, scoped to an environment and
  one or more of `ingest`, `evals:write`, and `admin`.
- Dashboard token mode creates a 12-hour, HttpOnly, SameSite=Strict session.
- Telemetry is capped at 500 events and 2 MiB per ingest request. The standalone
  server rejects any request body above 3 MiB before routing it.
- Known secret-shaped fields are masked recursively and project redaction rules
  run before an event is stored. Redaction is defense in depth, not permission
  to send credentials; instrumented applications should omit secrets at source.
- The synthetic Investigation Lab is read-only at the API layer.
- Audit records cover key, policy, telemetry and incident administration.

Catchfly currently assumes one trusted organization per installation. It does
not provide multi-tenant user accounts, SSO, per-user roles, object storage, or
high-availability job scheduling. Put it behind your organization's access
proxy when those controls are required.

## Operational jobs

Run this command daily from cron, Kubernetes CronJob, or your scheduler:

```bash
docker compose exec -T catchfly npm run retention
```

The job removes expired raw telemetry, ingest batch metadata and measured
session projections. Eval history, incidents and audit records are retained.

## Key rotation

Create a replacement key in Sources, deploy it to the producer, verify a new
trace arrives, then revoke the old key. Secrets are shown exactly once. Key
metadata includes prefix, scope, creation, last-use, expiry and revocation
timestamps without returning the secret.
