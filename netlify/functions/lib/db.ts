/**
 * The Postgres connection, for functions and scripts alike.
 *
 * Plain `pg` against a connection string rather than a vendor SDK: Catchfly
 * Core has to run on any Postgres — Supabase, Neon, a container, someone's own
 * server — and a driver that only speaks to one host would put the open-source
 * half at the mercy of the hosted half.
 *
 * Two URLs, because managed Postgres separates them:
 *   DATABASE_URL           pooled (pgbouncer). What serverless functions use;
 *                          a Lambda that opens a direct connection per
 *                          invocation exhausts the server's slots.
 *   DATABASE_URL_UNPOOLED  direct. For migrations and bulk seeding.
 *
 * NETLIFY_DATABASE_URL is accepted as a fallback so a Netlify DB (Neon) site
 * works with no configuration.
 */

import pg from 'pg';

export type Sql = pg.Pool;

function urlFor(kind: 'pooled' | 'direct'): string {
  const direct = process.env.DATABASE_URL_UNPOOLED ?? process.env.NETLIFY_DATABASE_URL_UNPOOLED;
  const pooled = process.env.DATABASE_URL ?? process.env.NETLIFY_DATABASE_URL;
  const chosen = kind === 'direct' ? (direct ?? pooled) : (pooled ?? direct);
  if (!chosen) {
    throw new Error(
      'No database configured. Set DATABASE_URL (and DATABASE_URL_UNPOOLED for migrations).',
    );
  }
  return chosen;
}

/**
 * Managed Postgres terminates TLS with a certificate chain Node does not carry.
 * The connection is still encrypted; what is skipped is chain verification,
 * which is the standard trade for these providers' pooled endpoints.
 */
function sslFor(connectionString: string): false | { rejectUnauthorized: false } {
  if (process.env.DATABASE_SSL === 'disable') return false;
  try {
    const host = new URL(connectionString).hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host === 'db') return false;
  } catch {
    // pg will report an invalid connection string with better context.
  }
  return { rejectUnauthorized: false };
}

let pool: pg.Pool | null = null;

function poolMax(): number {
  const configured = Number(process.env.DATABASE_POOL_MAX);
  return Number.isFinite(configured) && configured > 0 ? Math.trunc(configured) : 10;
}

function poolIdleMillis(): number {
  const configured = Number(process.env.DATABASE_POOL_IDLE_MS);
  return Number.isFinite(configured) && configured >= 0 ? Math.trunc(configured) : 60_000;
}

/** The shared pool. Module-scoped, so a warm function reuses its connections. */
export function sql(): Sql {
  if (!pool) {
    const connectionString = urlFor('pooled');
    pool = new pg.Pool({
      connectionString,
      ssl: sslFor(connectionString),
      max: poolMax(),
      idleTimeoutMillis: poolIdleMillis(),
      connectionTimeoutMillis: 10_000,
      // A pooled connection sits idle between requests, and both pgbouncer and
      // the NAT in front of it will drop a silent socket. Keepalives make the
      // connection visibly alive rather than silently dead.
      keepAlive: true,
      keepAliveInitialDelayMillis: 5_000,
    });
    // An 'error' on an idle client is emitted on the pool, and a pool with no
    // listener rethrows it as an uncaught exception — which takes the dev
    // server down instead of failing one request.
    pool.on('error', (error) => {
      console.warn(`idle postgres client dropped: ${error.message}`);
    });
  }
  return pool;
}

/**
 * True for the errors that mean "this socket is gone", not "this query is
 * wrong": a dropped pooled connection, a pooler restart, a NAT timeout. They
 * are worth one retry on a fresh client; a syntax error or a constraint
 * violation is not.
 */
function isConnectionError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  // 08006 connection_failure · 08003 connection_does_not_exist
  // 57P01 admin_shutdown  · 57P03 cannot_connect_now
  if (code && ['ECONNRESET', 'EPIPE', 'ETIMEDOUT', '08006', '08003', '57P01', '57P03'].includes(code)) {
    return true;
  }
  const message = (error as { message?: string } | null)?.message ?? '';
  return /connection terminated|socket hang up|server closed the connection/i.test(message);
}

/**
 * Runs `work` on a pooled client, once more on a fresh one if the first client
 * turned out to be dead. Read paths only: a retry is safe here because nothing
 * was written, and a dead socket is otherwise indistinguishable to the caller
 * from a real failure — which is what surfaced as "Could not load the eval
 * dataset" after the app had been sitting idle.
 */
export async function withClient<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const client = await sql().connect();
    try {
      const result = await work(client);
      client.release();
      return result;
    } catch (error) {
      const dead = isConnectionError(error);
      // Passing the error destroys the client instead of returning a socket
      // the pool would hand to the next caller.
      client.release(dead ? (error as Error) : undefined);
      if (!dead || attempt === 1) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

/** A single-use client on the direct endpoint, for migrations and seeding. */
export function directClient(): pg.Client {
  const connectionString = urlFor('direct');
  return new pg.Client({ connectionString, ssl: sslFor(connectionString), connectionTimeoutMillis: 15_000 });
}

/** Runs `work` inside one transaction, rolling back if it throws. */
export async function transaction<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await sql().connect();
  try {
    await client.query('begin');
    const result = await work(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export function isDatabaseConfigured(): boolean {
  return Boolean(
    process.env.DATABASE_URL ??
      process.env.NETLIFY_DATABASE_URL ??
      process.env.DATABASE_URL_UNPOOLED ??
      process.env.NETLIFY_DATABASE_URL_UNPOOLED,
  );
}
