import { existsSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile?.();
process.env.CATCHFLY_AUTH_MODE = 'supabase';
process.env.SUPABASE_URL ??= 'https://smoke.supabase.local';
process.env.SUPABASE_JWT_SECRET ??= 'catchfly-smoke-secret';

const { SignJWT } = await import('jose');
const { isDatabaseConfigured, sql } = await import('../netlify/functions/lib/db.ts');
const meHandler = (await import('../netlify/functions/me.ts')).default;
const provisionHandler = (await import('../netlify/functions/me-provision.ts')).default;
const orgsHandler = (await import('../netlify/functions/orgs.ts')).default;
const projectsHandler = (await import('../netlify/functions/projects.ts')).default;
const sourcesHandler = (await import('../netlify/functions/sources.ts')).default;
const environmentsHandler = (await import('../netlify/functions/environments.ts')).default;
const { authMode } = await import('../netlify/functions/lib/user-auth.ts');

const DEMO = 'devpost-review-scale';
const secret = new TextEncoder().encode(process.env.SUPABASE_JWT_SECRET);

const failures: string[] = [];
function check(label: string, condition: boolean, detail = ''): void {
  const status = condition ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  ${status} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures.push(label);
}

console.log('\n\x1b[1mauth configuration\x1b[0m');
const configuredAuthMode = process.env.CATCHFLY_AUTH_MODE;
process.env.CATCHFLY_AUTH_MODE = 'supabse';
let typoRefused = false;
try { authMode(); } catch { typoRefused = true; }
check('an auth mode typo fails closed', typoRefused);
delete process.env.CATCHFLY_AUTH_MODE;
let missingRefused = false;
try { authMode(); } catch { missingRefused = true; }
check('a missing auth mode fails closed', missingRefused);
process.env.CATCHFLY_AUTH_MODE = configuredAuthMode;
const configuredSupabaseUrl = process.env.SUPABASE_URL;
delete process.env.SUPABASE_URL;
let missingSupabaseUrlRefused = false;
try { authMode(); } catch { missingSupabaseUrlRefused = true; }
check('supabase mode without its URL fails closed', missingSupabaseUrlRefused);
process.env.SUPABASE_URL = configuredSupabaseUrl;

if (!isDatabaseConfigured()) {
  if (failures.length > 0) process.exit(1);
  console.log('\n\x1b[33mNo DATABASE_URL configured — skipping the account database checks.\x1b[0m');
  process.exit(0);
}

const url = (path: string) => `http://smoke.local${path}`;

async function mint(sub: string, email: string, key: Uint8Array = secret): Promise<string> {
  return new SignJWT({ email })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(`${process.env.SUPABASE_URL}/auth/v1`)
    .setAudience('authenticated')
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(key);
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';

async function cleanup(): Promise<void> {
  await sql().query(
    `delete from projects where org_id in (select org_id from org_members where user_id in ($1::uuid, $2::uuid))`,
    [ALICE, BOB],
  );
  await sql().query(
    `delete from organizations where id in (select org_id from org_members where user_id in ($1::uuid, $2::uuid))`,
    [ALICE, BOB],
  );
  await sql().query('delete from user_profiles where user_id in ($1::uuid, $2::uuid)', [ALICE, BOB]);
}

async function main(): Promise<void> {
  await cleanup();

  console.log('\n\x1b[1manonymous access\x1b[0m');
  const anonProjects = (await (await projectsHandler(new Request(url('/api/projects')))).json()) as {
    projects: Array<{ id: string; dataOrigin: string }>;
  };
  check('anonymous sees only synthetic projects', anonProjects.projects.every((p) => p.dataOrigin === 'synthetic'));
  check('the demo project is among them', anonProjects.projects.some((p) => p.id === DEMO));

  const anonDemo = await sourcesHandler(new Request(url(`/api/projects/${DEMO}/sources`)), {
    params: { projectId: DEMO },
  });
  check('anonymous reads the demo project', anonDemo.status === 200, String(anonDemo.status));

  const anonMe = await meHandler(new Request(url('/api/me')));
  check('anonymous /api/me is 401', anonMe.status === 401);

  console.log('\n\x1b[1mtoken verification\x1b[0m');
  const forged = await mint(ALICE, 'alice@example.com', new TextEncoder().encode('wrong-secret'));
  const forgedMe = await meHandler(new Request(url('/api/me'), { headers: bearer(forged) }));
  check('a forged token is 401, not 500', forgedMe.status === 401, String(forgedMe.status));

  const alice = await mint(ALICE, 'alice@example.com');
  const me = await meHandler(new Request(url('/api/me'), { headers: bearer(alice) }));
  const meBody = (await me.json()) as { user: { id: string; email: string }; orgs: unknown[] };
  check('a valid token reads the account', me.status === 200 && meBody.user.id === ALICE);
  check('a fresh account has no orgs yet', meBody.orgs.length === 0);

  console.log('\n\x1b[1mprovisioning\x1b[0m');
  const provisioned = await provisionHandler(
    new Request(url('/api/me/provision'), { method: 'POST', headers: bearer(alice) }),
  );
  const provisionBody = (await provisioned.json()) as {
    org: { id: string };
    project: { id: string };
    ingestKey?: { scopes: string[]; secret?: string };
    created: boolean;
  };
  check('first provision creates the workspace', provisioned.status === 201 && provisionBody.created);
  check('the minted key is ingest-only', provisionBody.ingestKey?.scopes.join(',') === 'ingest');
  check('the secret is returned exactly once', Boolean(provisionBody.ingestKey?.secret));

  const again = await provisionHandler(
    new Request(url('/api/me/provision'), { method: 'POST', headers: bearer(alice) }),
  );
  const againBody = (await again.json()) as { project: { id: string }; ingestKey?: unknown; created: boolean };
  check('provision is idempotent', again.status === 200 && !againBody.created);
  check('the repeat call reveals no secret', againBody.ingestKey === undefined);
  check('both calls name the same project', againBody.project.id === provisionBody.project.id);

  const aliceProject = provisionBody.project.id;

  console.log('\n\x1b[1mtenancy\x1b[0m');
  const memberProjects = (await (
    await projectsHandler(new Request(url('/api/projects'), { headers: bearer(alice) }))
  ).json()) as { projects: Array<{ id: string }> };
  check('a member sees their project and the demo',
    memberProjects.projects.some((p) => p.id === aliceProject) && memberProjects.projects.some((p) => p.id === DEMO));

  const anonOwned = await sourcesHandler(new Request(url(`/api/projects/${aliceProject}/sources`)), {
    params: { projectId: aliceProject },
  });
  check('an owned project is not world-readable', anonOwned.status === 401, String(anonOwned.status));

  const bob = await mint(BOB, 'bob@example.com');
  const bobRead = await sourcesHandler(
    new Request(url(`/api/projects/${aliceProject}/sources`), { headers: bearer(bob) }),
    { params: { projectId: aliceProject } },
  );
  check('a stranger cannot read it either', bobRead.status === 401, String(bobRead.status));

  const bobWrite = await environmentsHandler(
    new Request(url(`/api/projects/${aliceProject}/environments`), {
      method: 'POST',
      headers: { ...bearer(bob), 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'staging', name: 'Staging', kind: 'staging' }),
    }),
    { params: { projectId: aliceProject } },
  );
  check('a stranger cannot write it', bobWrite.status === 401, String(bobWrite.status));

  const ownerWrite = await environmentsHandler(
    new Request(url(`/api/projects/${aliceProject}/environments`), {
      method: 'POST',
      headers: { ...bearer(alice), 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'staging', name: 'Staging', kind: 'staging' }),
    }),
    { params: { projectId: aliceProject } },
  );
  check('the owner writes without any admin key', ownerWrite.status === 201, String(ownerWrite.status));

  const bobRename = await orgsHandler(
    new Request(url(`/api/orgs/${provisionBody.org.id}`), {
      method: 'PATCH',
      headers: { ...bearer(bob), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'stolen' }),
    }),
    { params: { orgId: provisionBody.org.id } },
  );
  check('a stranger cannot rename the org', bobRename.status === 401);

  const rename = await orgsHandler(
    new Request(url(`/api/orgs/${provisionBody.org.id}`), {
      method: 'PATCH',
      headers: { ...bearer(alice), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Alice HQ' }),
    }),
    { params: { orgId: provisionBody.org.id } },
  );
  check('the owner renames it', rename.status === 200);

  await cleanup();
  console.log('  (smoke accounts cleaned up)');

  if (failures.length > 0) {
    console.error(`\n\x1b[31m${failures.length} check(s) failed:\x1b[0m`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log('\n\x1b[32mAll account checks passed.\x1b[0m');
  process.exit(0);
}

await main();
