/**
 * Drives the session layer end to end against a deterministic Devpost fixture: the registry,
 * the async source seam, keyset paging, and the invariants the demo rests on.
 *
 * Two things are being checked here that the unit-style checks in
 * smoke-queries.ts cannot reach. The first is the registry's asynchronous
 * behaviour — a page arriving after a project switch must be discarded, and a
 * cache must not serve one project's sessions to another. The second is that
 * the planted regression is actually discoverable by the route a person would
 * take through the UI, rather than only by the generator's own arithmetic.
 *
 * Run with: npm run smoke
 */

import {
  compareDeployments,
  toolProduction,
} from '@catchfly/core/session-queries.ts';
import type { SessionFilters } from '@catchfly/core/session-types.ts';
import { memorySessionsSource } from '@catchfly/core/sessions-memory.ts';
import {
  configureSessionsSource,
  ensureDeployments,
  ensureSession,
  ensureSessionList,
  ensureToolProduction,
  getDeployments,
  getSessionEntry,
  getSessionList,
  getToolProductionEntry,
  isSessionsAvailable,
  loadMoreSessions,
  resetSessions,
  setSessionsUnavailable,
  whenSessionsSettled,
} from '@catchfly/core/sessions-db.ts';
import { diffToolSchema, toolEvalProfile } from '@catchfly/core/schema-diff.ts';
import { createDb, setDb } from '@catchfly/core/db.ts';
import { APP_VERSIONS } from '@catchfly/devpost-world/tools.ts';
import { DEVPOST_CASES } from './devpost/eval-cases.ts';
import { generateSessions, type DeploymentPlan } from './devpost/sessions.ts';

const failures: string[] = [];
function check(label: string, condition: boolean, detail = ''): void {
  const status = condition ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  ${status} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures.push(label);
}

const heading = (text: string) => console.log(`\n\x1b[1m${text}\x1b[0m`);

/** Lets the registry's in-flight promises settle before reading the cache. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const plans: DeploymentPlan[] = APP_VERSIONS.map((version, index) => ({
  deployment: {
    id: `deploy-${index + 1}`,
    appVersionId: version.id,
    environment: 'production',
    deployedAt: `2026-08-${String(10 + index * 7).padStart(2, '0')}T09:00:00.000Z`,
    dataOrigin: 'synthetic',
  },
  sessionCount: 180,
  windowStart: `2026-08-${String(10 + index * 7).padStart(2, '0')}T09:00:00.000Z`,
  windowEnd: `2026-08-${String(17 + index * 7).padStart(2, '0')}T09:00:00.000Z`,
}));
const deployments = plans.map((plan) => plan.deployment);
const sessions = generateSessions(plans, 20260827);
const db = setDb(createDb({
  project: {
    id: 'session-smoke',
    name: 'Session smoke fixture',
    appVersions: APP_VERSIONS,
    dataOrigin: 'synthetic',
  },
  cases: DEVPOST_CASES,
  runs: [],
}));

// --- the registry before it is wired up --------------------------------

heading('registry lifecycle');
check('nothing is available before a source is configured', !isSessionsAvailable());
ensureDeployments();
check('a read before wiring is a no-op, not a crash', getDeployments() === null);

configureSessionsSource(memorySessionsSource(deployments, sessions));
check('a configured source is available', isSessionsAvailable());
await whenSessionsSettled();
check('settling does not hang once a source exists', true);

// --- deployments -------------------------------------------------------

heading('deployments');
ensureDeployments();
await flush();
const rollups = getDeployments();
check('deployments load', rollups?.status === 'ready', rollups?.status);
const rows = rollups?.status === 'ready' ? rollups.value : [];
check('every deployment is reported', rows.length === deployments.length);
check('rollups are in release order', rows[0]?.id === 'deploy-1' && rows[2]?.id === 'deploy-3');
check(
  'each rollup counts its own sessions',
  rows.reduce((sum, row) => sum + row.sessionCount, 0) === sessions.length,
  `${sessions.length} sessions`,
);

// --- paging ------------------------------------------------------------

heading('paging');
const ALL: SessionFilters = {};
ensureSessionList(ALL, 25);
await flush();
let list = getSessionList(ALL);
check('the first page loads', list?.status === 'ready');
const firstBatch = list?.status === 'ready' ? [...list.value.sessions] : [];
check('the page honours the requested size', firstBatch.length === 25, `${firstBatch.length} rows`);
check('the total counts every session, not just the page', list?.status === 'ready' && list.value.total === sessions.length);
check('the newest session comes first', firstBatch[0]?.startedAt > firstBatch[24]?.startedAt);

loadMoreSessions(ALL, 25);
await flush();
list = getSessionList(ALL);
const afterMore = list?.status === 'ready' ? list.value.sessions : [];
check('load more appends rather than replaces', afterMore.length === 50, `${afterMore.length} rows`);
check(
  'the appended page does not repeat a session',
  new Set(afterMore.map((session) => session.id)).size === afterMore.length,
);
check(
  'the appended page continues the ordering',
  afterMore.every((session, index) => index === 0 || session.startedAt <= afterMore[index - 1].startedAt),
);

// Walk the whole list to the end, the way a reviewer scrolling would.
let guard = 0;
while (guard < 40) {
  const current = getSessionList(ALL);
  if (current?.status !== 'ready' || current.value.nextCursor === null) break;
  loadMoreSessions(ALL, 25);
  await flush();
  guard += 1;
}
const walked = getSessionList(ALL);
check(
  'walking the cursor reaches every session exactly once',
  walked?.status === 'ready' && walked.value.sessions.length === sessions.length,
  walked?.status === 'ready' ? `${walked.value.sessions.length} of ${sessions.length}` : walked?.status,
);
check('the walk terminates', walked?.status === 'ready' && walked.value.nextCursor === null);

// --- filters -----------------------------------------------------------

heading('filters');
const FAILURES: SessionFilters = { deploymentId: 'deploy-2', outcome: 'any-failure' };
ensureSessionList(FAILURES, 200);
await flush();
const failing = getSessionList(FAILURES);
const failingRows = failing?.status === 'ready' ? failing.value.sessions : [];
check('filtered lists are cached separately from unfiltered ones', failingRows.length > 0);
check(
  'every row matches the filter',
  failingRows.every((row) => row.deploymentId === 'deploy-2' && row.outcome !== 'completed'),
);
check(
  'the filtered total is the filtered count, not the global one',
  failing?.status === 'ready' && failing.value.total === failingRows.length && failing.value.total < sessions.length,
  `${failingRows.length} failing sessions on deploy-2`,
);

// --- one session -------------------------------------------------------

heading('one session');
const target = failingRows[0]!;
ensureSession(target.id);
await flush();
const detail = getSessionEntry(target.id);
check('a session loads by id', detail?.status === 'ready');
const session = detail?.status === 'ready' ? detail.value : null;
check('the detail carries the calls the summary only counted', session?.toolCalls.length === target.toolCallCount);
check(
  'call timestamps are ordered within the session',
  (session?.toolCalls ?? []).every(
    (entry, index) => index === 0 || Date.parse(entry.timestamp) >= Date.parse(session!.toolCalls[index - 1].timestamp),
  ),
);
check('a failed session names a category', session?.failureCategory !== undefined, session?.failureCategory);
ensureSession('s-does-not-exist');
await flush();
check('an unknown session is an error, not an empty session', getSessionEntry('s-does-not-exist')?.status === 'error');

// --- tool profile ------------------------------------------------------

heading('tool profile');
ensureToolProduction('score_submission');
await flush();
const profile = getToolProductionEntry('score_submission');
check('a tool profile loads', profile?.status === 'ready');
const production = profile?.status === 'ready' ? profile.value : null;
check('the profile counts calls across every deployment', (production?.byDeployment.length ?? 0) === 3);
check('p95 is at or above p50', (production?.p95DurationMs ?? 0) >= (production?.p50DurationMs ?? 0));
check(
  'the profile agrees with the pure query',
  production?.calls === toolProduction(sessions, deployments, 'score_submission').calls,
);

ensureToolProduction('get_review_queue');
await flush();
const unused = getToolProductionEntry('get_review_queue');
check(
  'a tool with no production traffic answers zero rather than failing',
  unused?.status === 'ready' && unused.value.calls === 0,
);

// --- the finding the demo depends on -----------------------------------
//
// Not "the generator wrote the right number", but "the route a person takes
// through the UI arrives at the tool and then at the sentence that changed".

heading('discoverability');
const drift = compareDeployments(sessions, deployments, 'deploy-1', 'deploy-2');

// An earlier version of this check looked only for a tool whose calls started
// being rejected. That assumption did not survive contact with the eval matrix:
// what a vaguer manifest actually causes is agents reaching for a *different*
// tool, and the different tool answers perfectly. Execution telemetry stays
// flat while tasks fail. So the tool to follow is the one agents stopped
// choosing — their own votes — not the one with the showiest error rate.
const totalCalls = (side: 'baseline' | 'candidate') =>
  drift.tools.reduce((sum, entry) => sum + entry[`${side}Calls`], 0);
const abandoned = drift.tools
  .map((tool) => ({
    tool,
    move: tool.candidateCalls / totalCalls('candidate') - tool.baselineCalls / totalCalls('baseline'),
  }))
  .filter((row) => row.tool.baselineCalls >= 10)
  .sort((a, b) => a.move - b.move);

const headline = abandoned[0]?.tool;
check(
  'a tool with real volume loses call share on the vaguer manifest',
  headline !== undefined && abandoned[0].move <= -0.02,
  headline && `${headline.toolName}: ${headline.baselineCalls} → ${headline.candidateCalls} calls, ${(abandoned[0].move * 100).toFixed(1)} pts of the mix`,
);
check(
  'the failure mix shifts towards tool selection',
  (drift.categories.find((entry) => entry.category === 'tool-selection')?.delta ?? 0) > 0,
  drift.categories
    .filter((entry) => entry.delta !== 0)
    .map((entry) => `${entry.category} ${entry.delta > 0 ? '+' : ''}${entry.delta}`)
    .join(', '),
);

const evalProfile = toolEvalProfile(db, headline?.toolName ?? 'verify_technology_claim');
const v1v2 = evalProfile.schemaDiffs[0];
check(
  'the tool profile explains the drop with a schema change',
  v1v2?.diff.descriptionChanged === true || v1v2?.diff.changedProps.length > 0,
  v1v2 ? `changed: ${v1v2.diff.changedProps.join(', ') || 'description'}` : 'no diff',
);
check(
  'the third version restores what the second one changed',
  (() => {
    const versions = evalProfile.schemaByVersion;
    const restored = diffToolSchema(versions[0]?.schema ?? null, versions[2]?.schema ?? null);
    return !restored.descriptionChanged && restored.changedProps.length === 0;
  })(),
);
check(
  'the regression did not spread across every tool',
  abandoned.filter((row) => row.move <= -0.01).length <= 6,
  `${abandoned.filter((row) => row.move <= -0.01).length} of ${drift.tools.length} tools lost call share`,
);

// --- switching projects ------------------------------------------------

heading('project switch');
resetSessions();
check('a reset clears the cached list', getSessionList(ALL) === null);
check('a reset clears cached deployments', getDeployments() === null);
check('a reset keeps the source configured', isSessionsAvailable());

setSessionsUnavailable();
check('a deployment without a database reports sessions as unavailable', !isSessionsAvailable());
ensureSessionList(ALL);
await flush();
check('reads after that are refused quietly, not left pending', getSessionList(ALL) === null);

console.log();
if (failures.length > 0) {
  console.error(`\x1b[31m${failures.length} check(s) failed:\x1b[0m`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('\x1b[32mAll session checks passed.\x1b[0m\n');
