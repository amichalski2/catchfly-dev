/**
 * Applies pending SQL migrations, in filename order, once each.
 *
 * Deliberately not an ORM's migration tool: the schema is plain PostgreSQL so
 * that self-hosting Catchfly means running these files against any Postgres.
 *
 * Run with: npm run migrate
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Client } from 'pg';

import { directClient, sql } from '../netlify/functions/lib/db.ts';

process.loadEnvFile?.();

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../db/migrations');

/**
 * Managed Postgres often exposes the direct endpoint over IPv6 only, which a
 * host without an IPv6 route cannot reach. The pooled endpoint runs this DDL
 * perfectly well, so fall back rather than making a network detail a blocker.
 */
async function connect(): Promise<{ query: Client['query']; done: () => Promise<void> }> {
  const direct = directClient();
  try {
    await direct.connect();
    return { query: direct.query.bind(direct), done: () => direct.end() };
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== 'ENETUNREACH' && code !== 'ENOTFOUND' && code !== 'ETIMEDOUT') throw error;
    console.warn(`! direct connection unreachable (${code}); using the pooled endpoint`);
    const pool = sql();
    return { query: pool.query.bind(pool) as Client['query'], done: () => pool.end() };
  }
}

const db = await connect();
try {
  await db.query(
    `create table if not exists schema_migrations (
       name text primary key,
       applied_at timestamptz not null default now()
     )`,
  );

  const applied = new Set(
    (await db.query<{ name: string }>('select name from schema_migrations')).rows.map((r) => r.name),
  );
  const files = readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .sort();

  let ran = 0;
  for (const name of files) {
    if (applied.has(name)) {
      console.log(`  = ${name}`);
      continue;
    }
    const statements = readFileSync(resolve(MIGRATIONS, name), 'utf8');
    // One transaction per migration: a half-applied schema is worse than none.
    await db.query('begin');
    try {
      await db.query(statements);
      await db.query('insert into schema_migrations (name) values ($1)', [name]);
      await db.query('commit');
    } catch (error) {
      await db.query('rollback');
      throw new Error(`Migration ${name} failed: ${String(error)}`);
    }
    console.log(`  + ${name}`);
    ran += 1;
  }

  console.log(ran === 0 ? '\nSchema already up to date.' : `\nApplied ${ran} migration(s).`);
} finally {
  await db.done();
}
