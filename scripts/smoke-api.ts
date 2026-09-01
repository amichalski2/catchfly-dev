/**
 * Drives the HTTP handlers directly against the configured database.
 *
 * No dev server: the handlers are plain functions from Request to Response, so
 * calling them is both faster and a truer test of our code than testing the
 * platform's routing. What this asserts is the contract the dashboard and the
 * CLI depend on — status codes, shapes, and that writes are refused without a
 * key.
 *
 * Skips itself when no database is configured, so a clean clone can still run
 * the rest of the suite.
 *
 * Run with: npm run smoke:api
 */

import { readFileSync } from 'node:fs';

import type {
  DeploymentRollup,
  Session,
  SessionPage,
  ToolProduction,
} from '@catchfly/core/session-types.ts';
import type { CatchflyDataset, IncidentOverview } from '@catchfly/core/types.ts';

import casesHandler from '../netlify/functions/cases.ts';
import datasetHandler from '../netlify/functions/dataset.ts';
import deploymentsHandler from '../netlify/functions/deployments.ts';
import evalCasesHandler from '../netlify/functions/eval-cases.ts';
import evalSuiteHandler from '../netlify/functions/eval-suite.ts';
import incidentOverviewHandler from '../netlify/functions/incident-overview.ts';
import dataPolicyHandler from '../netlify/functions/data-policy.ts';
import environmentsHandler from '../netlify/functions/environments.ts';
import incidentHandler from '../netlify/functions/incident.ts';
import incidentsHandler from '../netlify/functions/incidents.ts';
import projectKeyHandler from '../netlify/functions/project-key.ts';
import projectKeysHandler from '../netlify/functions/project-keys.ts';
import projectOverviewHandler from '../netlify/functions/project-overview.ts';
import sourcesHandler from '../netlify/functions/sources.ts';
import telemetryHandler from '../netlify/functions/telemetry.ts';
import { isDatabaseConfigured, sql } from '../netlify/functions/lib/db.ts';
import { loadDataset } from '../netlify/functions/lib/store.ts';
import projectsHandler from '../netlify/functions/projects.ts';
import runsHandler from '../netlify/functions/runs.ts';
import sessionDetailHandler from '../netlify/functions/session-detail.ts';
import sessionsHandler from '../netlify/functions/sessions.ts';
import toolProfileHandler from '../netlify/functions/tool-profile.ts';
import { CHROME_REPORT_PATH } from './test-io.ts';

process.loadEnvFile?.();

if (!isDatabaseConfigured()) {
  console.log('\n\x1b[33mNo DATABASE_URL configured — skipping the API checks.\x1b[0m\n');
  process.exit(0);
}

const KEY = process.env.CATCHFLY_ADMIN_KEY;
const failures: string[] = [];
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

const url = (path: string) => `https://catchfly.dev${path}`;
const params = (projectId: string) => ({ params: { projectId } });

/** A project this suite owns, so a rerun never disturbs real data. */
const TEST_PROJECT = 'api-smoke-test';

console.log('\n\x1b[1mGET /api/projects\x1b[0m');
const listed = await projectsHandler(new Request(url('/api/projects')));
check('answers 200', listed.status === 200);
const registry = (await listed.json()) as { projects: Array<{ id: string; runCount: number }> };
check(
  'lists only the canonical demo project',
  registry.projects.length === 1 && registry.projects[0]?.id === 'devpost-review-scale',
  registry.projects.map((project) => `${project.id}(${project.runCount})`).join(', '),
);


console.log('\n\x1b[1mwrites need the key\x1b[0m');
const noKey = await projectsHandler(
  new Request(url('/api/projects'), { method: 'POST', body: JSON.stringify({ id: 'x', name: 'X' }) }),
);
check('POST without a key is refused', noKey.status === 401 || noKey.status === 503, String(noKey.status));

const badMethod = await datasetHandler(
  new Request(url('/api/projects/devpost-review-scale/dataset'), { method: 'DELETE' }),
  params('devpost-review-scale'),
);
check('DELETE on a read endpoint is refused', badMethod.status === 405);

console.log('\n\x1b[1mGET /api/projects/:id/dataset\x1b[0m');
const missing = await datasetHandler(
  new Request(url('/api/projects/nope/dataset'), {
    ...(KEY ? { headers: { 'x-catchfly-key': KEY } } : {}),
  }),
  params('nope'),
);
check('unknown project is a 404', missing.status === 404);

console.log('\n\x1b[1mGET /api/projects/:id/incident-overview\x1b[0m');
const incidentResponse = await incidentOverviewHandler(
  new Request(url('/api/projects/devpost-review-scale/incident-overview')),
  params('devpost-review-scale'),
);
check('answers 200 for the investigation lab', incidentResponse.status === 200);
check(
  'public synthetic reads may use the durable CDN cache',
  incidentResponse.headers.get('netlify-cdn-cache-control')?.includes('public') === true,
);
const incidentBody = (await incidentResponse.json()) as { overview: IncidentOverview };
check(
  'summarises the full world without result bodies',
  incidentBody.overview.evalAttempts === 27_000 && incidentBody.overview.productionSessions === 25_000,
  `${incidentBody.overview.evalAttempts} attempts, ${incidentBody.overview.productionSessions} sessions`,
);
check(
  'keeps the release history and ranked findings compact',
  incidentBody.overview.timeline.length === 18 && incidentBody.overview.incidents.length === 8,
  `${incidentBody.overview.timeline.length} releases, ${incidentBody.overview.incidents.length} findings`,
);
check(
  'separates regressions from the latency false lead',
  incidentBody.overview.incidentPatterns === 6 &&
    incidentBody.overview.incidents.some((incident) => incident.kind === 'decoy'),
  `${incidentBody.overview.incidentPatterns} regressions`,
);

if (!KEY) {
  console.log('\n\x1b[33mCATCHFLY_ADMIN_KEY not set — skipping the write path.\x1b[0m');
} else {
  const demoMutation = await environmentsHandler(
    new Request(url('/api/projects/devpost-review-scale/environments'), {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-catchfly-key': KEY },
      body: JSON.stringify({ id: 'should-not-exist', name: 'Blocked', kind: 'staging' }),
    }),
    params('devpost-review-scale'),
  );
  check('the synthetic demo refuses new product configuration', demoMutation.status === 403);

  console.log('\n\x1b[1mPOST /api/projects\x1b[0m');
  const created = await projectsHandler(
    new Request(url('/api/projects'), {
      method: 'POST',
      headers: { 'x-catchfly-key': KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ id: TEST_PROJECT, name: 'API smoke test' }),
    }),
  );
  check('creates or reports a conflict', created.status === 201 || created.status === 409, String(created.status));

  const badId = await projectsHandler(
    new Request(url('/api/projects'), {
      method: 'POST',
      headers: { 'x-catchfly-key': KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'Not A Valid Id', name: 'X' }),
    }),
  );
  check('rejects an unusable id', badId.status === 400);

  console.log('\n\x1b[1mPOST /api/projects/:id/runs\x1b[0m');
  const report = JSON.parse(readFileSync(CHROME_REPORT_PATH, 'utf8')) as unknown;

  const unauthorised = await runsHandler(
    new Request(url(`/api/projects/${TEST_PROJECT}/runs`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ report, appVersion: { id: 'v1' } }),
    }),
    params(TEST_PROJECT),
  );
  check('import without a key is refused', unauthorised.status === 401);

  const junk = await runsHandler(
    new Request(url(`/api/projects/${TEST_PROJECT}/runs`), {
      method: 'POST',
      headers: { 'x-catchfly-key': KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ report: { nothing: true }, appVersion: { id: 'v1' } }),
    }),
    params(TEST_PROJECT),
  );
  check(
    'a file that is not a report is explained, not accepted',
    junk.status === 422,
    ((await junk.json()) as { error: string }).error.slice(0, 60),
  );

  const importOnce = () =>
    runsHandler(
      new Request(url(`/api/projects/${TEST_PROJECT}/runs`), {
        method: 'POST',
        headers: { 'x-catchfly-key': KEY, 'content-type': 'application/json' },
        body: JSON.stringify({ report, appVersion: { id: 'v1', label: 'v1' } }),
      }),
      params(TEST_PROJECT),
    );

  const imported = await importOnce();
  check('imports a real report', imported.status === 201, String(imported.status));
  const { run } = (await imported.json()) as { run: { id: string; metrics: { testCount: number } } };
  check('reports the run it stored', run.metrics.testCount > 0, `${run.id}, ${run.metrics.testCount} attempts`);

  // The point of persistence: read it back through the other endpoint.
  const readBack = (await (
    await datasetHandler(
      new Request(url(`/api/projects/${TEST_PROJECT}/dataset`), {
        headers: { 'x-catchfly-key': KEY },
      }),
      params(TEST_PROJECT),
    )
  ).json()) as CatchflyDataset;
  check(
    'the imported run is queryable afterwards',
    readBack.runs.some((stored) => stored.id === run.id),
    `${readBack.runs.length} run(s)`,
  );

  await importOnce();
  const again = (await (
    await datasetHandler(
      new Request(url(`/api/projects/${TEST_PROJECT}/dataset`), {
        headers: { 'x-catchfly-key': KEY },
      }),
      params(TEST_PROJECT),
    )
  ).json()) as CatchflyDataset;
  check(
    're-import replaces rather than duplicates',
    again.runs.length === readBack.runs.length,
    `${again.runs.length} run(s)`,
  );

  // Kept until the session-to-eval checks below: the canonical synthetic demo
  // is deliberately read-only, so durable writes are exercised on this
  // measured smoke project instead.

  console.log('\n\x1b[1mproject key + telemetry ingest\x1b[0m');
  if (!KEY) {
    console.log('  \x1b[33m(no CATCHFLY_ADMIN_KEY or compatibility key — skipping project-key ingest checks)\x1b[0m');
  } else {
    const adminHeaders = { 'content-type': 'application/json', 'x-catchfly-key': KEY };
    const keyResponse = await projectKeysHandler(
      new Request(url(`/api/projects/${TEST_PROJECT}/keys`), {
        method: 'POST', headers: adminHeaders,
        body: JSON.stringify({ environmentId: 'production', name: 'Smoke SDK', scopes: ['ingest'] }),
      }),
      params(TEST_PROJECT),
    );
    check('creates an environment-scoped key', keyResponse.status === 201, String(keyResponse.status));
    const keyBody = (await keyResponse.json()) as { secret: string; key: { id: string } };
    check('returns the secret once', keyBody.secret?.startsWith(`cfly_${TEST_PROJECT.slice(0, 12)}.`));

    const policyResponse = await dataPolicyHandler(
      new Request(url(`/api/projects/${TEST_PROJECT}/environments/production/policy`), {
        method: 'PUT', headers: adminHeaders,
        body: JSON.stringify({
          redactionRules: [{ path: 'payload.arguments.email', action: 'mask' }],
          samplingRate: 1,
          retentionDays: 30,
        }),
      }),
      { params: { projectId: TEST_PROJECT, environmentId: 'production' } },
    );
    check('saves a server-side redaction policy', policyResponse.status === 200, String(policyResponse.status));

    const sessionId = 'session-api-smoke';
    const at = '2026-09-01T12:00:00.000Z';
    const events = [
      { schemaVersion: '1', eventId: 'evt-api-1', sessionId, sequence: 0, type: 'session.started', occurredAt: at,
        payload: { deploymentId: 'deploy-api-smoke', appVersionId: 'app-api-smoke', intent: 'Verify ingest' } },
      { schemaVersion: '1', eventId: 'evt-api-2', sessionId, sequence: 1, type: 'tool.called', occurredAt: at,
        payload: { callId: 'call-1', toolName: 'lookup', arguments: { email: 'person@example.test', authorization: 'Bearer secret' } } },
      { schemaVersion: '1', eventId: 'evt-api-3', sessionId, sequence: 2, type: 'tool.completed', occurredAt: at,
        payload: { callId: 'call-1', toolName: 'lookup', result: { found: true }, durationMs: 4 } },
      { schemaVersion: '1', eventId: 'evt-api-4', sessionId, sequence: 3, type: 'task.completed', occurredAt: at, payload: {} },
    ];
    const ingestRequest = (idempotencyKey?: string) => new Request(url(`/api/v1/projects/${TEST_PROJECT}/events`), {
      method: 'POST',
      headers: {
        'content-type': 'application/json', authorization: `Bearer ${keyBody.secret}`,
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      },
      body: JSON.stringify({ environmentId: 'production', events }),
    });
    const ingested = await telemetryHandler(ingestRequest('smoke-batch'), params(TEST_PROJECT));
    const ingestBody = (await ingested.json()) as { accepted: number; duplicates: number };
    check('accepts a complete telemetry trace', ingested.status === 202 && ingestBody.accepted === 4, `${ingested.status}, ${ingestBody.accepted}`);

    const idempotentRetry = await telemetryHandler(ingestRequest('smoke-batch'), params(TEST_PROJECT));
    const idempotentBody = (await idempotentRetry.json()) as { accepted: number; duplicates: number };
    check('returns the original result for a retried batch', idempotentRetry.status === 202 && idempotentBody.accepted === 4 && idempotentBody.duplicates === 0);
    const duplicate = await telemetryHandler(ingestRequest(), params(TEST_PROJECT));
    const duplicateBody = (await duplicate.json()) as { duplicates: number };
    check('deduplicates retried event ids without a batch key', duplicate.status === 202 && duplicateBody.duplicates === 4, String(duplicateBody.duplicates));

    const projected = await sessionDetailHandler(
      new Request(url(`/api/projects/${TEST_PROJECT}/sessions/${sessionId}`), { headers: adminHeaders }),
      { params: { projectId: TEST_PROJECT, sessionId } },
    );
    const projectedBody = (await projected.json()) as { session: Session };
    check('projects telemetry into the session read model', projected.status === 200 && projectedBody.session.toolCalls.length === 1);
    check('redacts before projection', projectedBody.session.toolCalls[0]?.arguments?.email === '[REDACTED]' &&
      !('authorization' in (projectedBody.session.toolCalls[0]?.arguments ?? {})));

    const health = await sourcesHandler(
      new Request(url(`/api/projects/${TEST_PROJECT}/sources`), { headers: adminHeaders }),
      params(TEST_PROJECT),
    );
    const healthBody = (await health.json()) as { sources: { environments: Array<{ acceptedEvents: number }> } };
    check('reports source health from ingest batches', health.status === 200 && healthBody.sources.environments[0]?.acceptedEvents >= 4);

    const overview = await projectOverviewHandler(
      new Request(url(`/api/projects/${TEST_PROJECT}/overview`), { headers: adminHeaders }),
      params(TEST_PROJECT),
    );
    const overviewBody = (await overview.json()) as { overview: { sessions: { total: number }; findings: unknown[] } };
    check('builds a measured operational overview', overview.status === 200 && overviewBody.overview.sessions.total >= 1);

    const adminKeyResponse = await projectKeysHandler(
      new Request(url(`/api/projects/${TEST_PROJECT}/keys`), {
        method: 'POST', headers: adminHeaders,
        body: JSON.stringify({ environmentId: 'production', name: 'Smoke project admin', scopes: ['admin'] }),
      }),
      params(TEST_PROJECT),
    );
    const projectAdmin = (await adminKeyResponse.json()) as { secret: string };
    const projectAdminHeaders = { 'content-type': 'application/json', authorization: `Bearer ${projectAdmin.secret}` };
    check('creates a project-scoped admin key', adminKeyResponse.status === 201 && projectAdmin.secret.startsWith('cfly_'));

    const staging = await environmentsHandler(
      new Request(url(`/api/projects/${TEST_PROJECT}/environments`), {
        method: 'POST', headers: projectAdminHeaders,
        body: JSON.stringify({ id: 'staging', name: 'Staging', kind: 'staging' }),
      }),
      params(TEST_PROJECT),
    );
    check('creates an additional environment', staging.status === 201, String(staging.status));

    const findingId = 'smoke-finding';
    const incident = await incidentsHandler(
      new Request(url(`/api/projects/${TEST_PROJECT}/incidents`), {
        method: 'POST', headers: projectAdminHeaders,
        body: JSON.stringify({ findingId, title: 'Smoke finding', severity: 'warning', evidence: { source: 'smoke' } }),
      }),
      params(TEST_PROJECT),
    );
    const incidentBody = (await incident.json()) as { incident: { id: string } };
    check('promotes a finding to an incident', incident.status === 201 && Boolean(incidentBody.incident.id));
    const duplicateIncident = await incidentsHandler(
      new Request(url(`/api/projects/${TEST_PROJECT}/incidents`), {
        method: 'POST', headers: projectAdminHeaders,
        body: JSON.stringify({ findingId, title: 'Duplicate', severity: 'warning' }),
      }),
      params(TEST_PROJECT),
    );
    check('keeps one active incident per finding', duplicateIncident.status === 409);
    const resolved = await incidentHandler(
      new Request(url(`/api/projects/${TEST_PROJECT}/incidents/${incidentBody.incident.id}`), {
        method: 'PATCH', headers: projectAdminHeaders,
        body: JSON.stringify({ status: 'resolved', resolution: 'Smoke verified.' }),
      }),
      { params: { projectId: TEST_PROJECT, incidentId: incidentBody.incident.id } },
    );
    check('resolves an incident with an audit-worthy transition', resolved.status === 200);

    const listedKeys = await projectKeysHandler(
      new Request(url(`/api/projects/${TEST_PROJECT}/keys`), { headers: projectAdminHeaders }),
      params(TEST_PROJECT),
    );
    const listedKeyBody = (await listedKeys.json()) as { keys: Array<{ id: string; secret?: string }> };
    check('lists key metadata without secrets', listedKeys.status === 200 && listedKeyBody.keys.every((entry) => entry.secret === undefined));
    const ingestKeyId = keyBody.key.id;
    const revoked = ingestKeyId ? await projectKeyHandler(
      new Request(url(`/api/projects/${TEST_PROJECT}/keys/${ingestKeyId}`), {
        method: 'DELETE', headers: projectAdminHeaders,
      }),
      { params: { projectId: TEST_PROJECT, keyId: ingestKeyId } },
    ) : null;
    check('revokes a project key', revoked?.status === 200);
    const afterRevoke = await telemetryHandler(ingestRequest(), params(TEST_PROJECT));
    check('rejects telemetry after key revocation', afterRevoke.status === 401);
  }
}

// --- session endpoints -------------------------------------------------
//
// These read the canonical investigation world rather than a project this script creates: the
// point is the paging and filtering contract, which needs more rows than a
// fixture would carry.

const PROJECT = 'devpost-review-scale';
const scaleSeeded =
  ((await sql().query('select 1 from sessions where project_id = $1 limit 1', [PROJECT])).rowCount ?? 0) > 0;

if (!scaleSeeded) {
  console.log('\n\x1b[33mNo investigation sessions seeded — skipping the session endpoint checks.\x1b[0m');
} else {
  console.log('\n\x1b[1mGET /api/projects/:id/deployments\x1b[0m');
  const deployed = await deploymentsHandler(new Request(url(`/api/projects/${PROJECT}/deployments`)), params(PROJECT));
  check('answers 200', deployed.status === 200);
  const rollups = (await deployed.json()) as { deployments: DeploymentRollup[] };
  check('lists every deployment', rollups.deployments.length === 18, `${rollups.deployments.length} releases`);
  check('carries the session counts the strip needs', rollups.deployments.every((d) => d.sessionCount > 0));
  check('covers both incident cycles', rollups.deployments[0]?.id === 'scale-deploy-01' && rollups.deployments[17]?.id === 'scale-deploy-18');

  const unknownProject = await deploymentsHandler(
    new Request(url('/api/projects/nope/deployments'), {
      ...(KEY ? { headers: { 'x-catchfly-key': KEY } } : {}),
    }),
    params('nope'),
  );
  check('an unknown project is 404', unknownProject.status === 404);

  console.log('\n\x1b[1mGET /api/projects/:id/sessions\x1b[0m');
  const firstPage = await sessionsHandler(new Request(url(`/api/projects/${PROJECT}/sessions?limit=25`)), params(PROJECT));
  check('answers 200', firstPage.status === 200);
  const page = (await firstPage.json()) as SessionPage;
  check('honours the limit', page.sessions.length === 25);
  check('reports the total, not the page size', page.total > page.sessions.length, `${page.total} sessions`);
  check('hands out a cursor', typeof page.nextCursor === 'string');
  check('orders newest first', page.sessions[0].startedAt > page.sessions[24].startedAt);

  const second = (await (
    await sessionsHandler(
      new Request(url(`/api/projects/${PROJECT}/sessions?limit=25&cursor=${encodeURIComponent(page.nextCursor!)}`)),
      params(PROJECT),
    )
  ).json()) as SessionPage;
  check('the cursor continues without repeating', !second.sessions.some((s) => page.sessions.some((p) => p.id === s.id)));
  check('the total is stable across pages', second.total === page.total);

  const filtered = (await (
    await sessionsHandler(
      new Request(url(`/api/projects/${PROJECT}/sessions?deploymentId=scale-deploy-02&outcome=any-failure&limit=200`)),
      params(PROJECT),
    )
  ).json()) as SessionPage;
  check('filters narrow the total too', filtered.total < page.total && filtered.total > 0, `${filtered.total} matches`);
  check(
    'every row matches the filter',
    filtered.sessions.every((s) => s.deploymentId === 'scale-deploy-02' && s.outcome !== 'completed'),
  );

  const badOutcome = await sessionsHandler(
    new Request(url(`/api/projects/${PROJECT}/sessions?outcome=exploded`)),
    params(PROJECT),
  );
  check('an unknown outcome is 400, and says what would work', badOutcome.status === 400);
  check(
    'the error names the allowed values',
    ((await badOutcome.json()) as { error: string }).error.includes('any-failure'),
  );

  const badCursor = await sessionsHandler(
    new Request(url(`/api/projects/${PROJECT}/sessions?cursor=%21%21%21not-a-cursor`)),
    params(PROJECT),
  );
  check('an unreadable cursor is 400, not 500', badCursor.status === 400);

  console.log('\n\x1b[1mGET /api/projects/:id/sessions/:sessionId\x1b[0m');
  const target = filtered.sessions[0];
  const detail = await sessionDetailHandler(
    new Request(url(`/api/projects/${PROJECT}/sessions/${target.id}`)),
    { params: { projectId: PROJECT, sessionId: target.id } },
  );
  check('answers 200', detail.status === 200);
  const { session } = (await detail.json()) as { session: Session };
  check('carries the calls the list only counted', session.toolCalls.length === target.toolCallCount);
  check('calls carry arguments and status', session.toolCalls.every((c) => typeof c.status === 'string'));
  check(
    'an unknown session is 404',
    (
      await sessionDetailHandler(new Request(url(`/api/projects/${PROJECT}/sessions/s-nope`)), {
        params: { projectId: PROJECT, sessionId: 's-nope' },
      })
    ).status === 404,
  );

  console.log('\n\x1b[1mGET /api/projects/:id/tools/:toolName/profile\x1b[0m');
  const profile = await toolProfileHandler(
    new Request(url(`/api/projects/${PROJECT}/tools/score_submission/profile`)),
    { params: { projectId: PROJECT, toolName: 'score_submission' } },
  );
  check('answers 200', profile.status === 200);
  const { production } = (await profile.json()) as { production: ToolProduction };
  check('counts calls across deployments', production.byDeployment.length === 18);
  check('p95 is at or above p50', production.p95DurationMs >= production.p50DurationMs);

  const untouched = await toolProfileHandler(
    new Request(url(`/api/projects/${PROJECT}/tools/get_review_queue/profile`)),
    { params: { projectId: PROJECT, toolName: 'get_review_queue' } },
  );
  check('a tool with no traffic answers 200 with zeroes', untouched.status === 200);

  console.log('\n\x1b[1mPOST /api/projects/:id/cases\x1b[0m');
  const minted = {
    caseId: `case-smoke-${target.id}`,
    name: 'Minted by the smoke suite',
    prompt: target.intent ?? 'Replay this session.',
    expectedCall: session.toolCalls.map((call) => ({ functionName: call.toolName })),
    sourceSessionId: target.id,
  };
  const casesUrl = url(`/api/projects/${TEST_PROJECT}/cases`);

  const refused = await casesHandler(
    new Request(casesUrl, { method: 'POST', body: JSON.stringify({ case: minted }) }),
    params(PROJECT),
  );
  check('a write without the key is refused', refused.status === 401 || refused.status === 403, `${refused.status}`);

  if (!KEY) {
    console.log('  \x1b[33m(no installation admin key — skipping the write path)\x1b[0m');
  } else {
    const headers = { 'content-type': 'application/json', 'x-catchfly-key': KEY };
    await sql().query('delete from eval_cases where project_id = $1 and case_id = $2', [TEST_PROJECT, minted.caseId]);

    const created = await casesHandler(
      new Request(casesUrl, { method: 'POST', headers, body: JSON.stringify({ case: minted }) }),
      params(TEST_PROJECT),
    );
    check('a valid case is created', created.status === 201, `${created.status}`);

    const privateCases = await evalCasesHandler(
      new Request(url(`/api/projects/${TEST_PROJECT}/eval-cases`), { headers }),
      params(TEST_PROJECT),
    );
    check('private project reads are never cached publicly', privateCases.headers.get('cache-control') === 'no-store');
    check('private project reads set no durable CDN cache header', !privateCases.headers.has('netlify-cdn-cache-control'));

    const suiteWithoutKey = await evalSuiteHandler(
      new Request(url(`/api/projects/${TEST_PROJECT}/eval-suite`)),
      params(TEST_PROJECT),
    );
    check('pulling a private eval suite requires credentials', suiteWithoutKey.status === 401);

    const suiteResponse = await evalSuiteHandler(
      new Request(url(`/api/projects/${TEST_PROJECT}/eval-suite`), { headers }),
      params(TEST_PROJECT),
    );
    const suite = (await suiteResponse.json()) as { evals: Array<{ name: string; messages: unknown[]; expectedCall: unknown[] }> };
    check('exports the reviewed project suite', suiteResponse.status === 200 && suite.evals.some((entry) => entry.name === minted.name));
    check('exports Chrome-compatible prompts and expectations', suite.evals.every((entry) => entry.messages.length > 0 && entry.expectedCall.length > 0));

    const stored = await loadDataset(TEST_PROJECT);
    const readBackCase = stored?.cases.find((entry) => entry.caseId === minted.caseId);
    check('the case appears in the dataset', readBackCase !== undefined);
    check(
      'provenance survives the round trip',
      readBackCase?.sourceSessionId === target.id,
      readBackCase?.sourceSessionId,
    );

    const duplicate = await casesHandler(
      new Request(casesUrl, { method: 'POST', headers, body: JSON.stringify({ case: minted }) }),
      params(TEST_PROJECT),
    );
    check('a duplicate id is 409 rather than a silent overwrite', duplicate.status === 409);

    const overwritten = await casesHandler(
      new Request(casesUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ case: { ...minted, name: 'Renamed' }, overwrite: true }),
      }),
      params(TEST_PROJECT),
    );
    check('overwrite replaces it', overwritten.status === 201);

    const promptless = await casesHandler(
      new Request(casesUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ case: { ...minted, caseId: 'case-smoke-empty', prompt: '  ' } }),
      }),
      params(TEST_PROJECT),
    );
    check('a case with no prompt is refused', promptless.status === 400);

    const expectationless = await casesHandler(
      new Request(casesUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ case: { ...minted, caseId: 'case-smoke-empty', expectedCall: [] } }),
      }),
      params(TEST_PROJECT),
    );
    check('a case with no expectation is refused', expectationless.status === 400);

    await sql().query('delete from eval_cases where project_id = $1 and case_id = $2', [TEST_PROJECT, minted.caseId]);
    console.log('  (minted case removed)');
  }
}

// Leave the measured smoke project behind for no longer than this process.
await sql().query('delete from projects where id = $1', [TEST_PROJECT]);
console.log('  (test project removed)');

await sql().end();
console.log();
if (failures.length > 0) {
  console.error(`\x1b[31m${failures.length} check(s) failed:\x1b[0m`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('\x1b[32mAll API checks passed.\x1b[0m\n');
