/**
 * Runs the query layer against the committed test dataset and prints what it
 * derives. Cheap end-to-end check that data + queries agree.
 *
 * The eval-side sections print; the session-side and schema-diff sections
 * assert, because those two answer the same questions as the SQL in
 * netlify/functions/lib/session-store.ts and are the specification when the
 * two disagree.
 *
 * Run with: npm run smoke
 */

import {
  compareRuns,
  compareTrajectories,
  filterCases,
  findRegressions,
  getCase,
  groupResults,
  listRuns,
} from '@catchfly/core/queries.ts';
import { diffToolSchema, knownToolNames, toolEvalProfile } from '@catchfly/core/schema-diff.ts';
import {
  compareDeployments,
  decodeCursor,
  deploymentRollups,
  filterSessions,
  pageSessions,
  percentile,
  summarizeSession,
  toolProduction,
} from '@catchfly/core/session-queries.ts';
import type { Deployment, Session } from '@catchfly/core/session-types.ts';
import {
  loadTestDb,
  TEST_RUN_BASELINE,
  TEST_RUN_CANDIDATE,
  TEST_RUN_FIXED,
} from './test-io.ts';

const db = loadTestDb();

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
const heading = (text: string) => console.log(`\n\x1b[1m${text}\x1b[0m`);

const failures: string[] = [];
function check(label: string, condition: boolean, detail = ''): void {
  const status = condition ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  ${status} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures.push(label);
}

heading('listRuns');
for (const run of listRuns(db)) {
  // Imported reports carry no cost, so say so rather than printing "$undefined".
  const cost = run.metrics.totalCostUsd === undefined ? 'not measured' : `$${run.metrics.totalCostUsd}`;
  console.log(
    `  ${run.runId.padEnd(16)} ${run.appVersionLabel.padEnd(14)} ${run.model.padEnd(18)} ` +
      `${pct(run.metrics.successRate).padStart(6)}  ${cost}`,
  );
}

const BASELINE = TEST_RUN_BASELINE;
const CANDIDATE = TEST_RUN_CANDIDATE;
const FIXED = TEST_RUN_FIXED;

heading(`compareRuns(${BASELINE}, ${CANDIDATE})`);
const comparison = compareRuns(db, BASELINE, CANDIDATE);
console.log(
  `  ${comparison.baseline.appVersionLabel} ${pct(comparison.baseline.metrics.successRate)} -> ` +
    `${comparison.candidate.appVersionLabel} ${pct(comparison.candidate.metrics.successRate)} ` +
    `(${(comparison.delta.successRate * 100).toFixed(1)} pts, cost ${comparison.delta.totalCostUsd})`,
);
for (const entry of comparison.byCategory) {
  console.log(
    `  ${entry.category.padEnd(20)} ${String(entry.baselineFailures).padStart(3)} -> ` +
      `${String(entry.candidateFailures).padStart(3)}  (${entry.delta > 0 ? '+' : ''}${entry.delta})`,
  );
}

heading(`findRegressions(${BASELINE}, ${CANDIDATE})`);
const regressions = findRegressions(db, BASELINE, CANDIDATE);
console.log(
  `  ${regressions.regressedAttempts} regressed attempts across ${regressions.affectedCases} cases; ` +
    `${regressions.fixedAttempts} fixed; net ${regressions.netAttemptDelta}`,
);
for (const entry of regressions.byCategory) {
  console.log(`  ${entry.category.padEnd(20)} ${String(entry.attempts).padStart(3)} attempts / ${entry.cases} cases`);
}

heading('filterCases — tool-selection failures in the candidate');
const toolSelection = filterCases(db, { runId: CANDIDATE, category: 'tool-selection' });
console.log(`  ${toolSelection.length} cases`);
for (const row of toolSelection.slice(0, 5)) {
  console.log(`  ${row.caseId}  ${row.passes}/${row.repeats} pass  ${row.name}`);
}

heading('groupResults — candidate failures by tool actually called');
for (const group of groupResults(filterCases(db, { runId: CANDIDATE, outcome: 'any-failure' }), 'tool').slice(0, 6)) {
  console.log(`  ${group.key.padEnd(22)} ${group.cases} cases  ${pct(group.passRate)} pass`);
}

const worst = regressions.cases[0];
heading(`getCase(${worst.caseId}) — "${worst.name}"`);
for (const entry of getCase(db, worst.caseId).runs) {
  console.log(`  ${entry.runId.padEnd(16)} ${entry.passes}/${entry.repeats} pass`);
}

heading(`compareTrajectories(${worst.caseId}, ${BASELINE}, ${CANDIDATE})`);
const trajectory = compareTrajectories(db, worst.caseId, BASELINE, CANDIDATE);
console.log(`  prompt: ${trajectory.prompt}`);
console.log(`  expected: ${trajectory.expectedTools.join(' -> ')}`);
console.log(
  `  ${trajectory.baseline.appVersionLabel}: ${trajectory.baseline.calls.map((call) => call.functionName).join(' -> ')} [${trajectory.baseline.outcome}]`,
);
console.log(
  `  ${trajectory.candidate.appVersionLabel}: ${trajectory.candidate.calls.map((call) => call.functionName).join(' -> ')} [${trajectory.candidate.outcome}]`,
);
console.log(
  `  first divergence at call ${trajectory.firstDivergenceIndex}: ` +
    `${trajectory.divergence?.baselineTool} -> ${trajectory.divergence?.candidateTool}`,
);
console.log(`  tools added in candidate: ${trajectory.toolManifestDelta.added.join(', ') || 'none'}`);

heading(`findRegressions(${CANDIDATE}, ${FIXED}) — did the last version clear it?`);
const fixedReport = findRegressions(db, CANDIDATE, FIXED);
console.log(
  `  ${fixedReport.fixedAttempts} attempts recovered, ${fixedReport.regressedAttempts} new losses, ` +
    `net ${fixedReport.netAttemptDelta >= 0 ? '+' : ''}${fixedReport.netAttemptDelta}`,
);
const stillBroken = findRegressions(db, BASELINE, FIXED).byCategory.find(
  (entry) => entry.category === 'tool-selection',
);
console.log(`  tool-selection regressions left vs ${BASELINE}: ${stillBroken?.attempts ?? 0}`);

// --- schema history and diffs ------------------------------------------
//
// The test fixture blurs tool_alpha and tool_gamma at v2 and restores them at
// v3, which is exactly the shape a tool profile has to make visible.

heading('diffToolSchema / toolEvalProfile');
const alpha = toolEvalProfile(db, 'tool_alpha');
const v1v2 = alpha.schemaDiffs[0];
const v2v3 = alpha.schemaDiffs[1];
check('history covers every app version', alpha.schemaByVersion.length === 3);
check('v1 -> v2 sees the blurred description', v1v2?.diff.descriptionChanged === true, v1v2?.diff.after);
check('v1 -> v2 keeps the same arguments', (v1v2?.diff.addedProps.length ?? -1) === 0 && (v1v2?.diff.removedProps.length ?? -1) === 0);
check('v2 -> v3 restores it', v2v3?.diff.after === v1v2?.diff.before);
check(
  'cases are selected by expectation, not by actual calls',
  alpha.caseIds.length > 0 && alpha.caseIds.every((caseId) => db.casesById.has(caseId)),
  `${alpha.caseIds.length} cases`,
);
check(
  'pass rates are reported per version',
  alpha.passRateByVersion.length === 3 && alpha.passRateByVersion.every((entry) => entry.attempts > 0),
);

const epsilon = toolEvalProfile(db, 'tool_epsilon');
check(
  'a tool absent from early manifests diffs against null',
  epsilon.schemaDiffs[1]?.diff.before === undefined && epsilon.schemaDiffs[1]?.diff.after !== undefined,
);
check('knownToolNames unions every manifest', knownToolNames(db).length === 5, knownToolNames(db).join(', '));
check(
  'an unchanged tool reports no diff',
  diffToolSchema(
    db.versionsById.get('app-v1')?.toolManifest.find((tool) => tool.name === 'tool_beta') ?? null,
    db.versionsById.get('app-v2')?.toolManifest.find((tool) => tool.name === 'tool_beta') ?? null,
  ).descriptionChanged === false,
);

// --- production sessions -----------------------------------------------
//
// A hand-written fixture rather than the pilot seed: these checks are about the
// semantics of the primitives, and a fixture small enough to verify by eye is
// what makes a failure here readable.

heading('session-queries');

const DEPLOYMENTS: Deployment[] = [
  { id: 'deploy-1', appVersionId: 'app-v1', environment: 'production', deployedAt: '2026-08-01T00:00:00.000Z' },
  { id: 'deploy-2', appVersionId: 'app-v2', environment: 'production', deployedAt: '2026-08-10T00:00:00.000Z' },
];

function session(
  id: string,
  deploymentId: string,
  startedAt: string,
  outcome: Session['outcome'],
  calls: Array<[string, number, 'success' | 'error']>,
  extra: Partial<Session> = {},
): Session {
  return {
    id,
    deploymentId,
    environment: 'production',
    startedAt,
    outcome,
    toolCalls: calls.map(([toolName, durationMs, status], index) => ({
      timestamp: new Date(Date.parse(startedAt) + index * 1000).toISOString(),
      toolName,
      durationMs,
      status,
      ...(status === 'error' ? { errorType: 'invalid_argument' } : {}),
    })),
    ...extra,
  };
}

const SESSIONS: Session[] = [
  session('s-01', 'deploy-1', '2026-08-02T10:00:00.000Z', 'completed', [['tool_alpha', 100, 'success']], {
    intent: 'Find the blue widget',
  }),
  session('s-02', 'deploy-1', '2026-08-03T10:00:00.000Z', 'completed', [['tool_alpha', 200, 'success'], ['tool_gamma', 150, 'success']]),
  session('s-03', 'deploy-1', '2026-08-04T10:00:00.000Z', 'failed', [['tool_alpha', 300, 'error']], {
    failureCategory: 'argument-errors',
    failureTool: 'tool_alpha',
  }),
  session('s-04', 'deploy-2', '2026-08-11T10:00:00.000Z', 'failed', [['tool_alpha', 400, 'error']], {
    failureCategory: 'argument-errors',
    failureTool: 'tool_alpha',
    agent: 'demo-agent',
    model: 'some-model',
  }),
  session('s-05', 'deploy-2', '2026-08-12T10:00:00.000Z', 'failed', [['tool_alpha', 250, 'error'], ['tool_gamma', 120, 'success']], {
    failureCategory: 'tool-selection',
    failureTool: 'tool_alpha',
  }),
  session('s-06', 'deploy-2', '2026-08-13T10:00:00.000Z', 'abandoned', [['tool_gamma', 110, 'success']]),
  session('s-07', 'deploy-2', '2026-08-14T10:00:00.000Z', 'completed', [['tool_alpha', 180, 'success']], {
    intent: 'Record the item',
  }),
];

check('filter by deployment', filterSessions(SESSIONS, { deploymentId: 'deploy-2' }).length === 4);
check(
  'any-failure covers abandoned sessions too',
  filterSessions(SESSIONS, { outcome: 'any-failure' }).length === 4,
  'three failed + one abandoned',
);
check('filter by category', filterSessions(SESSIONS, { category: 'tool-selection' }).length === 1);
check('filter by tool called', filterSessions(SESSIONS, { toolCalled: 'tool_gamma' }).length === 3);
check('free text searches intent and tool names', filterSessions(SESSIONS, { search: 'blue widget' }).length === 1);
check(
  'time bounds are inclusive on startedAt',
  filterSessions(SESSIONS, { from: '2026-08-11T00:00:00.000Z' }).length === 4,
);

const summary = summarizeSession(SESSIONS[4], DEPLOYMENTS);
check('summary counts calls and errors', summary.toolCallCount === 2 && summary.errorCallCount === 1);
check('summary resolves the app version through the deployment', summary.appVersionId === 'app-v2');
check('summary omits absent optional fields', !('agent' in summary), 'agent stays absent, never null');

const summaries = SESSIONS.map((entry) => summarizeSession(entry, DEPLOYMENTS));
const firstPage = pageSessions(summaries, null, 3);
const secondPage = pageSessions(summaries, firstPage.nextCursor, 3);
const thirdPage = pageSessions(summaries, secondPage.nextCursor, 3);
check('page is newest first', firstPage.sessions[0]?.id === 's-07', firstPage.sessions.map((s) => s.id).join(','));
check('total counts every match, not just the page', firstPage.total === 7);
check('the next page continues where the last ended', secondPage.sessions[0]?.id === 's-04');
check(
  'paging visits every session exactly once',
  new Set([...firstPage.sessions, ...secondPage.sessions, ...thirdPage.sessions].map((s) => s.id)).size === 7,
);
check('the last page ends the walk', thirdPage.nextCursor === null, `${thirdPage.sessions.length} on the last page`);
check('a cursor round-trips', decodeCursor(firstPage.nextCursor ?? '')?.id === 's-05');
check('an unreadable cursor is rejected, not guessed', decodeCursor('not-a-cursor!!') === null);

const rollups = deploymentRollups(DEPLOYMENTS, SESSIONS);
check('rollups are ordered by release', rollups[0]?.id === 'deploy-1');
check('rollups count sessions and failures', rollups[1]?.sessionCount === 4 && rollups[1]?.failedCount === 3);
check('rollups count calls and errored calls', rollups[1]?.toolCallCount === 5 && rollups[1]?.errorCallCount === 2);

check('percentile interpolates like percentile_cont', percentile([100, 200, 300, 400], 0.5) === 250);
check('percentile of a single value is that value', percentile([42], 0.95) === 42);

const alphaProduction = toolProduction(SESSIONS, DEPLOYMENTS, 'tool_alpha');
check('tool production counts every call of the tool', alphaProduction.calls === 6);
check('tool production separates execution errors', alphaProduction.errorCalls === 3);
check('tool production reports success rate', alphaProduction.successRate === 0.5);
check('tool production groups error types', alphaProduction.errorTypes[0]?.errorType === 'invalid_argument');
check('tool production breaks down by deployment', alphaProduction.byDeployment.length === 2);

const drift = compareDeployments(SESSIONS, DEPLOYMENTS, 'deploy-1', 'deploy-2');
const worstTool = drift.tools[0];
check('comparison ranks the worst-hit tool first', worstTool?.toolName === 'tool_alpha', `${worstTool?.successRateDelta}`);
check('comparison sees the regression', (worstTool?.successRateDelta ?? 0) < 0);
check(
  'comparison reports the failure-category mix',
  drift.categories.some((entry) => entry.category === 'tool-selection' && entry.delta === 1),
);
check('an unknown deployment is refused', (() => {
  try {
    compareDeployments(SESSIONS, DEPLOYMENTS, 'deploy-1', 'nope');
    return false;
  } catch {
    return true;
  }
})());

console.log();
if (failures.length > 0) {
  console.error(`\x1b[31m${failures.length} check(s) failed:\x1b[0m`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('\x1b[32mAll query checks passed.\x1b[0m\n');
