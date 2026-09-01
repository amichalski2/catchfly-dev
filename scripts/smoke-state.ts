/**
 * Exercises the shared store and the selectors the way both operators do —
 * a human clicking, and an agent calling a tool — and asserts the contract that
 * the WebMCP layer will rely on:
 *
 *   - actions taken by either source land in the same state,
 *   - selectors recompute from that state and keep stable references,
 *   - the human can undo whatever the agent just did.
 *
 * Run with: npm run smoke
 */

import { activeRegressions, agentBusy, pendingCall, selectedTrajectory, visibleCases, visibleGroups } from '../apps/web/src/state/selectors.ts';
import { useCatchflyStore } from '../apps/web/src/state/store.ts';
import {
  loadTestDb,
  TEST_PROJECT_ID,
  TEST_RUN_BASELINE,
  TEST_RUN_CANDIDATE,
  TEST_RUN_FIXED,
} from './test-io.ts';

const db = loadTestDb();
const store = useCatchflyStore;

const failures: string[] = [];
function check(label: string, condition: boolean, detail = ''): void {
  const status = condition ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  ${status} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures.push(label);
}

const BASELINE = TEST_RUN_BASELINE;
const CANDIDATE = TEST_RUN_CANDIDATE;

console.log('\n\x1b[1mboot\x1b[0m');
check('dataset registered', db.dataset.runs.length === 4, `${db.dataset.runs.length} runs`);
check('no state before boot', store.getState().ready === false);

store.getState().markReady({ baselineRunId: BASELINE, candidateRunId: CANDIDATE }, TEST_PROJECT_ID);
check('ready after markReady', store.getState().ready);

const regressions = activeRegressions(store.getState());
check(
  'default comparison resolves the regression',
  regressions?.regressedAttempts === 23 && regressions.affectedCases === 13,
  `${regressions?.regressedAttempts} attempts / ${regressions?.affectedCases} cases`,
);

console.log('\n\x1b[1mselector memoisation\x1b[0m');
const first = visibleCases(store.getState());
const second = visibleCases(store.getState());
check('same state returns the identical array', first === second, `${first.length} rows`);
check('unfiltered view spans every run', first.length === 80, `${first.length} rows`);

console.log('\n\x1b[1magent narrows the shared view\x1b[0m');
store.getState().setFilters({ runId: CANDIDATE, category: 'tool-selection' }, 'agent');
const narrowed = visibleCases(store.getState());
check('filters recomputed', narrowed.length === 3, `${narrowed.length} cases`);
check('state changed identity', narrowed !== first);
check(
  'action attributed to the agent',
  store.getState().lastAction?.source === 'agent',
  store.getState().lastAction?.summary,
);
check(
  'every visible case really failed on tool selection',
  narrowed.every((row) => row.categories.includes('tool-selection')),
);

const groups = visibleGroups('tool')(store.getState());
check(
  'grouping by tool surfaces the tool that was wrongly chosen',
  groups.some((group) => group.key === 'tool_gamma'),
  groups.map((group) => group.key).join(', '),
);

console.log('\n\x1b[1mhuman continues from the agent state\x1b[0m');
const target = narrowed[0].caseId;
store.getState().openCase(target, 'human');
check('view followed the selection', store.getState().view === 'case-detail');
check('case detail is filled in', store.getState().selectedCaseId === target, target);

const trajectory = selectedTrajectory(store.getState());
check(
  'trajectory comparison diverges on a real call',
  trajectory !== null && trajectory.firstDivergenceIndex >= 0,
  trajectory
    ? `${trajectory.divergence?.baselineTool} -> ${trajectory.divergence?.candidateTool}`
    : 'none',
);
// v2 only reworded its descriptions, so nothing was added or removed.
check(
  'a manifest that only changed wording reports no delta',
  trajectory?.toolManifestDelta.added.length === 0 && trajectory?.toolManifestDelta.removed.length === 0,
);

store.getState().setComparison({ baselineRunId: CANDIDATE, candidateRunId: TEST_RUN_FIXED }, 'agent');
check(
  'switching the comparison surfaces the tool the next version added',
  selectedTrajectory(store.getState())?.toolManifestDelta.added.includes('tool_epsilon') === true,
);
store.getState().setComparison({ baselineRunId: BASELINE, candidateRunId: CANDIDATE }, 'human');

console.log('\n\x1b[1mundo\x1b[0m');
store.getState().createSegment('Tool-selection regressions', undefined, 'agent');
check('segment saved', store.getState().segments.length === 1, store.getState().segments[0]?.name);
check('segment records its author', store.getState().segments[0]?.createdBy === 'agent');

check('undo reports success', store.getState().undoLast('human') === true);
check('segment reverted', store.getState().segments.length === 0);
check('undo is attributed too', store.getState().lastAction?.source === 'human');

store.getState().resetFilters('human');
check('filters cleared', Object.keys(store.getState().filters).length === 0);
check('full view is back', visibleCases(store.getState()).length === 80);

// --- the session half ---------------------------------------------------
//
// The session views carry their own selection and filters, and they have to
// behave like the eval ones in every respect that matters: attributed to whoever
// acted, undoable, and reflected in the shared state an agent reads back.

// Captured before touching anything on the session side, so "the eval half was
// left alone" is checked against what it actually was.
const evalSideBefore = {
  filters: JSON.stringify(store.getState().filters),
  selectedCaseId: store.getState().selectedCaseId,
  comparison: JSON.stringify(store.getState().comparison),
};

console.log('\n\x1b[1msession navigation\x1b[0m');
store.getState().openSession('s-0042', 'agent');
check('opening a session switches the view', store.getState().view === 'session-detail');
check('the session is recorded as selected', store.getState().selectedSessionId === 's-0042');
check('the agent is credited', store.getState().lastAction?.source === 'agent');

store.getState().openTool('score_submission', 'human');
check('opening a tool switches the view', store.getState().view === 'tool-profile');
check('the tool is recorded as selected', store.getState().selectedToolName === 'score_submission');
check(
  'opening a tool leaves the session selected, so back returns to it',
  store.getState().selectedSessionId === 's-0042',
);

check('undo reverts the tool profile', store.getState().undoLast('human') === true);
check('the session is on screen again', store.getState().view === 'session-detail');
check('the tool selection is gone', store.getState().selectedToolName === null);

store.getState().closeSession('human');
check('closing returns to the list', store.getState().view === 'sessions');
check('nothing stays selected', store.getState().selectedSessionId === null);

console.log('\n\x1b[1mrelease comparison\x1b[0m');
const evalPairBefore = JSON.stringify(store.getState().comparison);
store.getState().setReleaseComparison(
  { baselineDeploymentId: 'deploy-6', candidateDeploymentId: 'deploy-7' },
  'agent',
);
check('comparing releases switches the view', store.getState().view === 'releases');
check(
  'the pair is recorded',
  store.getState().releaseComparison?.baselineDeploymentId === 'deploy-6' &&
    store.getState().releaseComparison?.candidateDeploymentId === 'deploy-7',
);
check('the agent is credited', store.getState().lastAction?.source === 'agent');
check(
  'the eval comparison is untouched — the two halves are independent',
  JSON.stringify(store.getState().comparison) === evalPairBefore,
);
check('undo reports success', store.getState().undoLast('human') === true);
check('the release pair is gone', store.getState().releaseComparison === null);

console.log('\n\x1b[1magent trace\x1b[0m');
const undoBefore = store.getState().undoStack.length;
const actionsBefore = store.getState().actionLog.length;
const lastBefore = store.getState().lastAction;
for (let i = 0; i < 5; i += 1) {
  store.getState().beginToolCall({
    id: `read-${i}`,
    tool: 'find_regressions',
    title: 'Find regressions',
    kind: 'read',
    summary: '{"baselineRunId":"run-a"}',
    at: new Date(Date.now() + i).toISOString(),
    status: 'pending',
  });
  store.getState().finishToolCall(`read-${i}`, { status: 'ok', durationMs: 12 });
}
check('reads are logged', store.getState().agentTrace.length === 5);
check(
  'a read pushes no undo point',
  store.getState().undoStack.length === undoBefore,
  `${store.getState().undoStack.length} vs ${undoBefore}`,
);
check('a read writes no action', store.getState().actionLog.length === actionsBefore);
check(
  'a read leaves lastAction alone, so the panels do not flash',
  store.getState().lastAction === lastBefore,
);
store.getState().setView('cases', 'agent');
check('a write still pushes an undo point', store.getState().undoStack.length === undoBefore + 1);
check('and still moves lastAction', store.getState().lastAction !== lastBefore);
for (let i = 0; i < 60; i += 1) {
  store.getState().beginToolCall({
    id: `view-${i}`,
    tool: 'get_current_view',
    title: 'Read the shared screen',
    kind: 'read',
    summary: '',
    at: new Date().toISOString(),
    status: 'ok',
  });
}
check('the trace is capped', store.getState().agentTrace.length === 50);
check('newest first', store.getState().agentTrace[0].tool === 'get_current_view');
store.getState().undoLast('human');

console.log('\n\x1b[1mthe page can show the agent working\x1b[0m');
store.getState().beginToolCall({
  id: 'slow-call',
  tool: 'create_eval_from_session',
  title: 'Create an eval case',
  kind: 'write',
  summary: '{"confirmed":true}',
  at: new Date().toISOString(),
  status: 'pending',
});
check('an unfinished call is visible while it runs', agentBusy(store.getState()));
check(
  'and the strip can name what is running',
  pendingCall(store.getState())?.title === 'Create an eval case',
);
const orderBefore = store.getState().agentTrace.map((entry) => entry.id).join(',');
store.getState().finishToolCall('slow-call', { status: 'ok', durationMs: 1240, kind: 'durable' });
check('finishing clears the working state', !agentBusy(store.getState()));
check(
  'the entry is patched in place, not reordered',
  store.getState().agentTrace.map((entry) => entry.id).join(',') === orderBefore,
);
const durable = store.getState().agentTrace[0];
check(
  'a persisted write is recorded as one, with how long it took',
  durable.kind === 'durable' && durable.status === 'ok' && durable.durationMs === 1240,
);
store.getState().beginToolCall({
  id: 'bad-call',
  tool: 'open_case',
  title: 'Open a case',
  kind: 'write',
  summary: '{"caseId":"case-999"}',
  at: new Date().toISOString(),
  status: 'pending',
});
store.getState().finishToolCall('bad-call', {
  status: 'failed',
  durationMs: 3,
  error: 'Unknown case "case-999".',
});
check(
  'a refused call keeps its reason',
  store.getState().agentTrace[0].status === 'failed' &&
    (store.getState().agentTrace[0].error ?? '').includes('case-999'),
);

console.log('\n\x1b[1msession filters\x1b[0m');
store.getState().setSessionFilters({ deploymentId: 'deploy-2', outcome: 'any-failure' }, 'agent');
check('filters are stored', store.getState().sessionFilters.deploymentId === 'deploy-2');
check('setting a session filter shows the list', store.getState().view === 'sessions');
store.getState().setSessionFilters({ deploymentId: undefined }, 'human');
check(
  'an explicit undefined clears one filter without clearing the rest',
  !('deploymentId' in store.getState().sessionFilters) &&
    store.getState().sessionFilters.outcome === 'any-failure',
);
store.getState().resetSessionFilters('human');
check('reset clears them all', Object.keys(store.getState().sessionFilters).length === 0);
check(
  'the eval filters and comparison were left exactly as they were',
  JSON.stringify(store.getState().filters) === evalSideBefore.filters &&
    JSON.stringify(store.getState().comparison) === evalSideBefore.comparison,
);
check(
  'but navigating to the session half released the case selection',
  evalSideBefore.selectedCaseId !== null && store.getState().selectedCaseId === null,
);

console.log('\n\x1b[1mselection follows the view\x1b[0m');
store.getState().openCase('case-1', 'human');
store.getState().setView('overview', 'human');
check('leaving the detail view drops the case', store.getState().selectedCaseId === null);
store.getState().openSession('s-0042', 'human');
store.getState().openTool('tool_alpha', 'human');
check('a tool profile keeps the session it came from', store.getState().selectedSessionId === 's-0042');
store.getState().setView('overview', 'human');
check(
  'and navigating away drops both',
  store.getState().selectedSessionId === null && store.getState().selectedToolName === null,
);

console.log('\n\x1b[1mone tool call, one undo point\x1b[0m');
store.getState().setFilters({ category: 'tool-selection' }, 'human');
const beforeTransaction = {
  undo: store.getState().undoStack.length,
  filters: JSON.stringify(store.getState().filters),
  view: store.getState().view,
};
store.getState().setFilters({ outcome: 'fail' }, 'agent', { reset: true, view: 'cases' });
check(
  'a reset + patch + view move is a single undo point',
  store.getState().undoStack.length === beforeTransaction.undo + 1,
  `${store.getState().undoStack.length - beforeTransaction.undo} points`,
);
check(
  'the summary names every part',
  (store.getState().lastAction?.summary ?? '').includes('Cleared all filters') &&
    (store.getState().lastAction?.summary ?? '').includes('cases view'),
  store.getState().lastAction?.summary,
);
store.getState().undoLast('human');
check(
  'one undo takes the whole call back',
  JSON.stringify(store.getState().filters) === beforeTransaction.filters &&
    store.getState().view === beforeTransaction.view,
);

console.log('\n\x1b[1mundo tells the truth\x1b[0m');
store.getState().setView('regressions', 'agent');
const reversibleTop = store.getState().undoStack[0];
check('a view change is reversible', store.getState().lastAction?.reversible === true);
store.getState().noteImport('Created eval case case-x from session s-0042', 'agent');
check('a persisted write is not reversible', store.getState().lastAction?.reversible === false);
check(
  'and it adds no undo point',
  store.getState().undoStack[0] === reversibleTop,
);
store.getState().undoLast('human');
check(
  'undo names what it actually reverted, not the persisted write',
  store.getState().lastAction?.summary === `Reverted "${reversibleTop.action.summary}"`,
  store.getState().lastAction?.summary,
);
check('undo itself is not reversible', store.getState().lastAction?.reversible === false);

console.log();
if (failures.length > 0) {
  console.error(`\x1b[31m${failures.length} check(s) failed:\x1b[0m`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('\x1b[32mAll state checks passed.\x1b[0m\n');
