/**
 * Contract test for the WebMCP layer, against a spec-faithful fake of
 * document.modelContext: registerTool resolves on registration, and aborting
 * the options signal unregisters the tool and rejects the promise — exactly
 * the semantics Catchfly relies on for its dynamic tool set.
 *
 * Then drives the whole demo scenario through execute() calls only, the way a
 * browser agent would.
 *
 * Run with: npm run smoke
 */

import { useCatchflyStore } from '../apps/web/src/state/store.ts';
import { buildCaseTools } from '../apps/web/src/webmcp/case-tools.ts';
import { buildSessionScopedTools } from '../apps/web/src/webmcp/session-scoped-tools.ts';
import { buildIncidentTools } from '../apps/web/src/webmcp/incident-tools.ts';
import { buildLandingTools } from '../apps/web/src/webmcp/landing-tools.ts';
import { buildProductTools } from '../apps/web/src/webmcp/product-tools.ts';
import { buildSessionTools } from '../apps/web/src/webmcp/session-tools.ts';
import { registerToolGroup } from '@catchfly/webmcp/registry.ts';
import { traced } from '../apps/web/src/webmcp/traced.ts';
import type { ModelContext, ModelContextTool } from '@catchfly/webmcp/spec.ts';
import { buildGlobalTools } from '../apps/web/src/webmcp/tools.ts';
import type { Deployment, Session } from '@catchfly/core/session-types.ts';
import { configureSessionsSource, setSessionsUnavailable } from '@catchfly/core/sessions-db.ts';
import { memorySessionsSource } from '@catchfly/core/sessions-memory.ts';
import type { EvalCase } from '@catchfly/core/types.ts';
import { applyProse, deriveClusters, PROMPT_VERSION } from '@catchfly/core/analysis.ts';
import { setAnalysis, setAnalysisUnavailable } from '@catchfly/core/analysis-db.ts';
import { createDb, getDb, setDb } from '@catchfly/core/db.ts';
import { filterCases, findRegressions } from '@catchfly/core/queries.ts';
import type { FailureCategory } from '@catchfly/core/types.ts';
import { loadTestDb, TEST_PROJECT_ID, TEST_RUN_BASELINE, TEST_RUN_CANDIDATE } from './test-io.ts';

// --- a spec-faithful fake browser ---------------------------------------

class FakeModelContext implements ModelContext {
  readonly tools = new Map<string, ModelContextTool>();

  registerTool(tool: ModelContextTool, options: { signal?: AbortSignal } = {}): Promise<undefined> {
    if (this.tools.has(tool.name)) {
      return Promise.reject(new DOMException(`Tool "${tool.name}" already registered`, 'InvalidStateError'));
    }
    this.tools.set(tool.name, tool);
    return new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => {
        this.tools.delete(tool.name);
        reject(new DOMException('Registration aborted', 'AbortError'));
      });
    });
  }

  async call(name: string, input: Record<string, unknown> = {}): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Agent tried to call unregistered tool "${name}"`);
    return tool.execute(input);
  }
}

// --- harness ------------------------------------------------------------

loadTestDb();
// The page reaches this state whenever no analysis has been fetched yet; the
// cluster tool must answer from it rather than wait forever.
setAnalysisUnavailable();
const store = useCatchflyStore;
const context = new FakeModelContext();

const failures: string[] = [];
function check(label: string, condition: boolean, detail = ''): void {
  const status = condition ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  ${status} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures.push(label);
}

async function expectError(label: string, call: () => Promise<unknown>, needle: string): Promise<void> {
  try {
    await call();
    check(label, false, 'expected an error, got a result');
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    check(label, message.includes(needle), message);
  }
}

const BASELINE = TEST_RUN_BASELINE;
const CANDIDATE = TEST_RUN_CANDIDATE;

async function main(): Promise<void> {
  console.log('\n\x1b[1mlanding hand-off\x1b[0m');
  const landingContext = new FakeModelContext();
  let openedDevpostAnalytics = false;
  const landingGroup = registerToolGroup(
    landingContext,
    buildLandingTools(() => {
      openedDevpostAnalytics = true;
    }),
  );
  await Promise.resolve();
  check(
    'the landing registers only open_devpost_analytics',
    landingContext.tools.size === 1 && landingContext.tools.has('open_devpost_analytics'),
  );
  const handoff = (await landingContext.call('open_devpost_analytics')) as {
    opening: boolean;
    destination: string;
  };
  check('the landing tool opens the analytics workspace', openedDevpostAnalytics);
  check(
    'the landing tool reports the hand-off',
    handoff.opening === true && handoff.destination.includes('Devpost analytics'),
  );
  landingGroup.revoke();

  store.getState().markReady({ baselineRunId: BASELINE, candidateRunId: CANDIDATE }, TEST_PROJECT_ID);

  console.log('\n\x1b[1mregistration\x1b[0m');
  const globalTools = buildGlobalTools();
  registerToolGroup(context, globalTools);
  await Promise.resolve();
  check('all global tools registered', context.tools.size === globalTools.length, `${context.tools.size} tools`);
  const readOnly = globalTools.filter((tool) => tool.annotations?.readOnlyHint === true).length;
  check('read/write split declared', readOnly === 10 && globalTools.length === 15, `${readOnly} read, ${globalTools.length - readOnly} write`);
  check('no case tools before selection', !context.tools.has('inspect_selected_case'));

  const everyTool = [
    ...globalTools,
    ...buildProductTools(),
    ...buildSessionTools(),
    ...buildIncidentTools(),
    ...buildCaseTools(),
    ...buildSessionScopedTools(),
    ...buildLandingTools(() => {}),
  ];
  const untitled = everyTool.filter(
    (tool) => typeof tool.title !== 'string' || tool.title.length === 0 || tool.title.length > 40,
  );
  check(
    'every tool carries a short human title',
    untitled.length === 0 && everyTool.length === 38,
    untitled.length > 0 ? untitled.map((tool) => tool.name).join(', ') : `${everyTool.length} tools`,
  );

  console.log('\n\x1b[1mthe page can show what the agent is doing\x1b[0m');
  const tracedContext = new FakeModelContext();
  let release = (): void => {};
  const tracedGroup = registerToolGroup(
    tracedContext,
    traced([
      {
        name: 'slow_read',
        title: 'Read the shared screen',
        description: 'A read that takes a moment.',
        annotations: { readOnlyHint: true },
        execute: () => new Promise((resolve) => { release = () => resolve({ ok: true }); }),
      },
      {
        name: 'draft_then_commit',
        title: 'Create an eval case',
        description: 'Two-phase durable write.',
        annotations: { destructiveHint: true },
        execute: async (input) =>
          input.confirmed === true ? { created: true } : { confirmationRequired: true },
      },
      {
        name: 'always_refuses',
        title: 'Open a case',
        description: 'Always throws.',
        execute: async () => {
          throw new Error('Unknown case "case-999". Call filter_cases to see the ids.');
        },
      },
    ]),
  );
  await Promise.resolve();

  const inFlight = tracedContext.call('slow_read');
  await Promise.resolve();
  const pending = store.getState().agentTrace[0];
  check(
    'a call is on the page before it finishes',
    pending.status === 'pending' && pending.title === 'Read the shared screen',
    `${pending.title}: ${pending.status}`,
  );
  release();
  await inFlight;
  const finishedRead = store.getState().agentTrace[0];
  check(
    'and is completed in place with how long it took',
    finishedRead.id === pending.id &&
      finishedRead.status === 'ok' &&
      typeof finishedRead.durationMs === 'number',
  );

  await tracedContext.call('draft_then_commit', {});
  check(
    'a draft is not reported as a permanent change',
    store.getState().agentTrace[0].kind === 'write',
    store.getState().agentTrace[0].kind,
  );
  await tracedContext.call('draft_then_commit', { confirmed: true });
  check(
    'the confirmed call is',
    store.getState().agentTrace[0].kind === 'durable',
    store.getState().agentTrace[0].kind,
  );

  await expectError(
    'a refused call still reaches the agent',
    () => tracedContext.call('always_refuses'),
    'case-999',
  );
  const refused = store.getState().agentTrace[0];
  check(
    'and the human sees why it was refused',
    refused.status === 'failed' && (refused.error ?? '').includes('case-999'),
    refused.error,
  );
  tracedGroup.revoke();

  console.log('\n\x1b[1mregistration reports partial failure\x1b[0m');
  const flakyContext = new FakeModelContext();
  const flaky: ModelContext = {
    registerTool: (tool, options) =>
      tool.name === 'list_projects'
        ? Promise.reject(new DOMException('refused', 'NotSupportedError'))
        : flakyContext.registerTool(tool, options),
  };
  const flakyGroup = registerToolGroup(flaky, buildGlobalTools());
  const flakyOutcome = await flakyGroup.settled;
  check('one refused tool is counted, not swallowed', flakyOutcome.failed === 1, `${flakyOutcome.failed} failed`);
  const cleanGroup = registerToolGroup(new FakeModelContext(), buildGlobalTools());
  cleanGroup.revoke();
  check('revoking a healthy group is not a failure', (await cleanGroup.settled).failed === 0);

  console.log('\n\x1b[1minvestigation — the demo scenario, tool calls only\x1b[0m');
  const view = (await context.call('get_current_view')) as Record<string, unknown>;
  check('get_current_view reads the shared state', view.visibleCases === 80 && view.view === 'overview');

  const regressions = (await context.call('find_regressions', {
    baselineRunId: BASELINE,
    candidateRunId: CANDIDATE,
  })) as { regressedAttempts: number; byCategory: Array<{ category: string; attempts: number }> };
  check('find_regressions returns every lost attempt', regressions.regressedAttempts === 23);
  const topCategory = regressions.byCategory[0];
  check(
    'the categories are ranked by weight',
    topCategory.attempts >= (regressions.byCategory[1]?.attempts ?? 0) && topCategory.attempts > 0,
    `${topCategory.category}: ${topCategory.attempts}`,
  );

  console.log('\n\x1b[1mfailure clusters\x1b[0m');
  const clustered = (await context.call('list_failure_clusters')) as {
    baselineRunId: string;
    clusters: {
      items: Array<{
        label: string;
        summary: string;
        rootCause: string;
        category: string;
        divergence: { baselineTool: string | null; candidateTool: string | null };
        cases: number;
        lostAttempts: number;
        caseIds: { items: string[] };
      }>;
    } | null;
  };
  check('clusters default to the comparison the user is viewing', clustered.baselineRunId === BASELINE);
  check('with nothing analyzed the tool answers instead of failing', clustered.clusters === null);

  // Register an analysis the way the runtime does — deterministic clusters plus
  // prose — so the serving path is covered without committing an artefact.
  const derived = deriveClusters(getDb(), BASELINE, CANDIDATE);
  setAnalysis({
    version: 1,
    provenance: {
      model: 'offline',
      promptVersion: PROMPT_VERSION,
      generatedAt: '2026-01-01T00:00:00.000Z',
      source: 'script',
    },
    entries: [
      { baselineRunId: BASELINE, candidateRunId: CANDIDATE, clusters: applyProse(derived, new Map()) },
    ],
  });

  const served = (await context.call('list_failure_clusters')) as typeof clustered;
  const clusters = served.clusters?.items ?? [];
  const topCluster = clusters[0];
  check('the tool serves the registered analysis', clusters.length === derived.length, `${clusters.length} clusters`);
  check(
    'clusters account for every regressed attempt',
    clusters.reduce((total, cluster) => total + cluster.lostAttempts, 0) === regressions.regressedAttempts,
  );
  check(
    'every cluster carries prose the agent can read',
    clusters.every(
      (cluster) => cluster.label.length > 0 && cluster.summary.length > 0 && cluster.rootCause.length > 0,
    ),
  );
  check('reading clusters did not change the shared view', store.getState().view === 'overview');

  const uncovered = (await context.call('list_failure_clusters', {
    baselineRunId: CANDIDATE,
    candidateRunId: BASELINE,
  })) as { clusters: null; note: string };
  check(
    'an unanalyzed comparison degrades in the answer, not as an error',
    uncovered.clusters === null && uncovered.note.includes('group_results'),
  );

  const undoBeforeFilters = store.getState().undoStack.length;
  const filtered = (await context.call('set_dashboard_filters', {
    runId: CANDIDATE,
    category: topCategory.category,
    reset: true,
    view: 'cases',
  })) as Record<string, unknown>;
  const expectedVisible = filterCases(getDb(), {
    runId: CANDIDATE,
    category: topCategory.category as FailureCategory,
  }).length;
  check(
    'set_dashboard_filters narrows the shared view',
    filtered.visibleCases === expectedVisible,
    `${String(filtered.visibleCases)} of ${expectedVisible}`,
  );
  check('dashboard switched view', filtered.view === 'cases');
  check('the human sees the agent did it', store.getState().lastAction?.source === 'agent');
  check(
    'one tool call leaves exactly one undo point',
    store.getState().undoStack.length === undoBeforeFilters + 1,
    `${store.getState().undoStack.length - undoBeforeFilters} points`,
  );
  check('and the human is told it can be taken back', store.getState().lastAction?.reversible === true);

  const grouped = (await context.call('group_results', { groupBy: 'tool' })) as {
    groups: Array<{ key: string }>;
  };
  check(
    'group_results works over the current visible slice',
    grouped.groups.length > 0,
    grouped.groups.map((group) => group.key).slice(0, 4).join(', '),
  );

  const cases = (await context.call('filter_cases', {
    runId: CANDIDATE,
    category: 'tool-selection',
    toolCalled: 'tool_gamma',
  })) as { cases: { items: Array<{ caseId: string }>; total: number } };
  check('filter_cases pins the suspects without touching the UI', cases.cases.total > 0, `${cases.cases.total} cases`);
  check('reading did not change shared filters', store.getState().filters.toolCalled === undefined);

  console.log('\n\x1b[1mdynamic case-scoped tools\x1b[0m');
  const target = cases.cases.items[0].caseId;
  let caseGroup: ReturnType<typeof registerToolGroup> | null = null;
  store.subscribe((state, previous) => {
    const selected = state.selectedCaseId !== null;
    if (selected === (previous.selectedCaseId !== null)) return;
    if (selected) caseGroup = registerToolGroup(context, buildCaseTools());
    else {
      caseGroup?.revoke();
      caseGroup = null;
    }
  });

  await context.call('open_case', { caseId: target });
  check('open_case moved the shared view', store.getState().view === 'case-detail');
  check('case tools appeared on selection', context.tools.has('inspect_selected_case'));

  const trajectory = (await context.call('compare_selected_trajectories')) as {
    divergence: { baselineTool?: string; candidateTool?: string } | null;
    toolManifestDelta: { added: string[] };
  };
  check(
    'trajectory comparison names the divergence',
    trajectory.divergence?.baselineTool === 'tool_alpha' &&
      trajectory.divergence?.candidateTool === 'tool_gamma',
    `${trajectory.divergence?.baselineTool} -> ${trajectory.divergence?.candidateTool}`,
  );

  const segment = (await context.call('create_segment', { name: 'tool_gamma regressions' })) as {
    segment: { createdBy: string };
  };
  check('segment recorded as agent work', segment.segment.createdBy === 'agent');

  const shownWhileOpen = (await context.call('get_case', { caseId: target })) as { shownToUser: boolean };
  check('an open case reads as shown to the developer', shownWhileOpen.shownToUser === true);
  await context.call('set_dashboard_filters', { view: 'overview' });
  check('navigating away released the selection', store.getState().selectedCaseId === null);
  check('scoped tools went with it', !context.tools.has('inspect_selected_case'));
  const shownAfterLeaving = (await context.call('get_case', { caseId: target })) as {
    shownToUser: boolean;
    hint?: string;
  };
  check(
    'and the agent is no longer told the developer can see it',
    shownAfterLeaving.shownToUser === false && (shownAfterLeaving.hint ?? '').includes('open_case'),
  );

  await context.call('open_case', { caseId: target });
  await context.call('close_case');
  check('close_case returned to the table', store.getState().view === 'cases');
  check('case tools revoked on deselection', !context.tools.has('inspect_selected_case'));

  console.log('\n\x1b[1merror reporting back to the agent\x1b[0m');
  await expectError(
    'unknown run id names the known runs',
    () => context.call('compare_runs', { baselineRunId: 'run-v99', candidateRunId: CANDIDATE }),
    'Known runs:',
  );
  await expectError(
    'unknown case id points at filter_cases',
    () => context.call('open_case', { caseId: 'case-999' }),
    'filter_cases',
  );
  await expectError(
    'bad enum lists the options',
    () => context.call('group_results', { groupBy: 'vibes' }),
    'must be one of',
  );
  await expectError(
    'half a comparison asks for the other half',
    () => context.call('list_failure_clusters', { baselineRunId: BASELINE }),
    'or neither',
  );

  console.log('\n\x1b[1mhuman undo of agent work\x1b[0m');
  store.getState().undoLast('human');
  check('undo reverted the last agent action', store.getState().view === 'case-detail');

  console.log('\n\x1b[1mcluster hand-off: agent pins one cluster for the human\x1b[0m');
  const pinned = (await context.call('set_dashboard_filters', {
    reset: true,
    runId: CANDIDATE,
    caseIds: topCluster?.caseIds.items ?? [],
    view: 'cases',
  })) as { visibleCases: number };
  check(
    'cluster caseIds drive the shared table',
    pinned.visibleCases === topCluster?.cases,
    `${pinned.visibleCases} of ${topCluster?.cases} cases`,
  );

  // --- the production half ---------------------------------------------
  //
  // A hand-built fixture rather than the pilot seed, so this script stays
  // self-contained and its sessions call the same tools the test manifest
  // declares.

  console.log('\n\x1b[1msession tools\x1b[0m');

  const DEPLOYMENTS: Deployment[] = [
    { id: 'deploy-1', appVersionId: 'app-v1', environment: 'production', deployedAt: '2026-01-05T00:00:00.000Z' },
    { id: 'deploy-2', appVersionId: 'app-v2', environment: 'production', deployedAt: '2026-02-05T00:00:00.000Z' },
  ];
  const SESSIONS: Session[] = [
    {
      id: 's-01',
      deploymentId: 'deploy-1',
      environment: 'production',
      startedAt: '2026-01-10T10:00:00.000Z',
      intent: 'Find item-1 and record it',
      outcome: 'completed',
      toolCalls: [
        { timestamp: '2026-01-10T10:00:00.000Z', toolName: 'tool_alpha', arguments: { query: 'item-1' }, status: 'success', durationMs: 120 },
        { timestamp: '2026-01-10T10:00:01.000Z', toolName: 'tool_beta', arguments: { id: 'item-1' }, status: 'success', durationMs: 90 },
      ],
    },
    {
      id: 's-02',
      deploymentId: 'deploy-2',
      environment: 'production',
      startedAt: '2026-02-10T10:00:00.000Z',
      intent: 'Find item-2 and record it',
      outcome: 'failed',
      failureCategory: 'argument-errors',
      failureTool: 'tool_beta',
      model: 'model-a',
      toolCalls: [
        { timestamp: '2026-02-10T10:00:00.000Z', toolName: 'tool_alpha', arguments: { query: 'item-2' }, status: 'success', durationMs: 140 },
        {
          timestamp: '2026-02-10T10:00:01.000Z',
          toolName: 'tool_beta',
          arguments: { id: 42 },
          status: 'error',
          durationMs: 60,
          errorType: 'invalid_argument',
          errorMessage: '"id" must be a string',
        },
      ],
    },
    {
      id: 's-03',
      deploymentId: 'deploy-2',
      environment: 'production',
      startedAt: '2026-02-11T10:00:00.000Z',
      outcome: 'abandoned',
      failureCategory: 'error',
      toolCalls: [
        { timestamp: '2026-02-11T10:00:00.000Z', toolName: 'tool_alpha', arguments: { query: 'item-3' }, status: 'success', durationMs: 110 },
      ],
    },
    {
      id: 's-04',
      deploymentId: 'deploy-2',
      environment: 'production',
      startedAt: '2026-02-12T10:00:00.000Z',
      intent: 'Find the strongest item and record it',
      outcome: 'failed',
      failureCategory: 'tool-selection',
      failureTool: 'tool_alpha',
      toolCalls: [
        { timestamp: '2026-02-12T10:00:00.000Z', toolName: 'tool_beta', arguments: { id: 'item-9' }, status: 'success', durationMs: 100 },
        { timestamp: '2026-02-12T10:00:01.000Z', toolName: 'tool_gamma', arguments: { id: 'item-9' }, status: 'success', durationMs: 95 },
      ],
    },
  ];

  configureSessionsSource(memorySessionsSource(DEPLOYMENTS, SESSIONS));
  const sessionTools = buildSessionTools();
  registerToolGroup(context, sessionTools);
  await Promise.resolve();
  check('session tools registered', context.tools.has('search_sessions'), `${sessionTools.length} tools`);
  check('no session-scoped tools before selection', !context.tools.has('inspect_selected_session'));

  const deployments = (await context.call('list_deployments')) as {
    deployments: Array<{ deploymentId: string; failureRate: number }>;
  };
  check('list_deployments answers in release order', deployments.deployments[0].deploymentId === 'deploy-1');
  check(
    'the rollup carries the failure rate the strip shows',
    deployments.deployments[1].failureRate > deployments.deployments[0].failureRate,
  );

  const searched = (await context.call('search_sessions', { outcome: 'any-failure' })) as {
    items: Array<{ sessionId: string; intent: string | null }>;
    matching: number;
    nextCursor: string | null;
  };
  check('search_sessions finds the failures', searched.matching === 3, `${searched.matching} sessions`);
  check('newest first', searched.items[0].sessionId === 's-04');
  check(
    'a session with no captured intent says so rather than omitting it',
    searched.items.find((entry) => entry.sessionId === 's-03')?.intent === null,
  );
  check('reading did not move the developer', store.getState().view === 'cases');

  const trace = (await context.call('get_session', { sessionId: 's-02' })) as {
    toolCalls: Array<{ toolName: string; status: string; errorMessage: string | null }>;
    shownToUser: boolean;
    hint?: string;
  };
  check('get_session returns the full trace', trace.toolCalls.length === 2);
  check('the rejected call carries its reason', trace.toolCalls[1].errorMessage === '"id" must be a string');
  check('a read states whether the developer can see it', trace.shownToUser === false && !!trace.hint);

  const profile = (await context.call('get_tool_profile', { toolName: 'tool_alpha' })) as {
    production: { calls: number; byDeployment: unknown[] };
    schemaChanges: Array<{ from: string; to: string; descriptionChanged: boolean }>;
  };
  check('the profile counts production calls', profile.production.calls === 3);
  check(
    'the profile explains a version change with the schema diff',
    profile.schemaChanges[0].descriptionChanged === true,
    `${profile.schemaChanges[0].from} -> ${profile.schemaChanges[0].to}`,
  );

  const drift = (await context.call('compare_deployments', {
    baselineDeploymentId: 'deploy-1',
    candidateDeploymentId: 'deploy-2',
  })) as { tools: Array<{ toolName: string; successRateDelta: number; candidateCalls: number }> };
  check(
    'compare_deployments ranks the worst-hit tool first',
    drift.tools[0].toolName === 'tool_beta' && drift.tools[0].successRateDelta < 0,
    `${drift.tools[0].toolName} ${drift.tools[0].successRateDelta}`,
  );
  check(
    'the comparison reports call volume alongside the delta',
    typeof drift.tools[0].candidateCalls === 'number',
  );

  console.log('\n\x1b[1mdynamic session-scoped tools\x1b[0m');
  let sessionGroup: ReturnType<typeof registerToolGroup> | null = null;
  store.subscribe((state, previous) => {
    const selected = state.selectedSessionId !== null;
    if (selected === (previous.selectedSessionId !== null)) return;
    if (selected) sessionGroup = registerToolGroup(context, buildSessionScopedTools());
    else {
      sessionGroup?.revoke();
      sessionGroup = null;
    }
  });

  await expectError(
    'open_session refuses an unknown id instead of navigating to nothing',
    () => context.call('open_session', { sessionId: 's-99' }),
    'Unknown session',
  );

  await context.call('open_session', { sessionId: 's-02' });
  check('open_session moved the shared view', store.getState().view === 'session-detail');
  check('session-scoped tools appeared', context.tools.has('create_eval_from_session'));

  const inspected = (await context.call('inspect_selected_session')) as { sessionId: string; shownToUser: boolean };
  check('inspect_selected_session follows the selection', inspected.sessionId === 's-02');
  check('and reports that the developer is looking at it', inspected.shownToUser === true);

  // The write path, against a stubbed API. The point is the shape of the case
  // the tool mints, which is what a future run will be judged against.
  const posted: Array<{ url: string; body: { case: EvalCase } }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? '{}')) as { case: EvalCase; overwrite?: boolean };
    // Emulate the endpoint rather than always saying yes: a duplicate id is the
    // interesting case, and a stub that accepts everything would hide it.
    if (!body.overwrite && posted.some((entry) => entry.body.case.caseId === body.case.caseId)) {
      return new Response(JSON.stringify({ error: `Case "${body.case.caseId}" already exists.` }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      });
    }
    posted.push({ url, body });
    return new Response(JSON.stringify({ case: body.case }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  await expectError(
    'without a stored key the tool says who can fix it',
    () => context.call('create_eval_from_session', { confirmed: true }),
    'eval key',
  );

  // A browser would have one; Node does not, so stand one in.
  const stored = new Map<string, string>([['catchfly.evalKey', 'test-key']]);
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
  };

  const preview = (await context.call('create_eval_from_session', {})) as { confirmationRequired: boolean; draft: EvalCase };
  check('durable eval creation requires explicit confirmation', preview.confirmationRequired && posted.length === 0);
  const minted = (await context.call('create_eval_from_session', { confirmed: true })) as {
    created: EvalCase;
    hint: string;
  };
  check('the case records where it came from', minted.created.sourceSessionId === 's-02');
  check(
    'a persisted eval is reported as something undo cannot take back',
    store.getState().lastAction?.reversible === false,
    store.getState().lastAction?.summary,
  );
  check('the prompt is the captured intent', minted.created.prompt === 'Find item-2 and record it');
  check(
    'the successful call keeps the arguments that worked',
    JSON.stringify(minted.created.expectedCall[0]) ===
      JSON.stringify({ functionName: 'tool_alpha', arguments: { query: 'item-2' } }),
  );
  check(
    'the rejected call asserts the tool but not the arguments that failed',
    JSON.stringify(minted.created.expectedCall[1]) ===
      JSON.stringify({ functionName: 'tool_beta', arguments: null }),
    'null means "any arguments" — asserting {id: 42} would mint a test for the bug',
  );
  check('the case was sent to the API', posted[0]?.url.includes('/cases') === true, posted[0]?.url);
  check('the tool points at how to show it', minted.hint.includes('open_case'));

  // Minting twice from one session reaches for the same id. The local dataset
  // has not reloaded yet, so the collision is the server's to catch — and the
  // tool has to pass that back as something the agent can act on.
  await expectError(
    'a second mint of the same session is refused, not silently overwritten',
    () => context.call('create_eval_from_session', { confirmed: true }),
    'overwrite: true',
  );

  const corrected = (await context.call('create_eval_from_session', {
    name: 'Records with a string id',
    overwrite: true,
    confirmed: true,
    correctedCalls: [
      { functionName: 'tool_alpha', arguments: { query: 'item-2' } },
      { functionName: 'tool_beta', arguments: { id: 'item-2' } },
    ],
  })) as { created: EvalCase };
  check(
    'correctedCalls override the derived expectation',
    JSON.stringify(corrected.created.expectedCall[1]) ===
      JSON.stringify({ functionName: 'tool_beta', arguments: { id: 'item-2' } }),
  );

  await context.call('close_session');
  check('close_session returned to the list', store.getState().view === 'sessions');
  check('session-scoped tools revoked', !context.tools.has('create_eval_from_session'));

  // A session with no intent cannot be replayed, and the tool must say which
  // field is missing rather than invent one.
  await context.call('open_session', { sessionId: 's-03' });
  await expectError(
    'a session with no captured intent asks for a prompt',
    () => context.call('create_eval_from_session', {}),
    'no user intent',
  );
  const supplied = (await context.call('create_eval_from_session', {
    prompt: 'Find item-3', confirmed: true,
  })) as { created: EvalCase };
  check('supplying the prompt is enough', supplied.created.prompt === 'Find item-3');
  await context.call('close_session');

  console.log('\n\x1b[1mminting from a tool-selection failure\x1b[0m');
  await context.call('open_session', { sessionId: 's-04' });
  await expectError(
    'a session that failed by never calling a tool refuses to mint from the calls it did make',
    () => context.call('create_eval_from_session', {}),
    'never calling tool_alpha',
  );
  const repaired = (await context.call('create_eval_from_session', {
    correctedCalls: [
      { functionName: 'tool_alpha', arguments: { query: 'item-9' } },
      { functionName: 'tool_beta', arguments: { id: 'item-9' } },
    ], confirmed: true,
  })) as { created: EvalCase };
  check(
    'supplying the trajectory that should have run is enough',
    JSON.stringify(repaired.created.expectedCall).includes('tool_alpha'),
  );
  check(
    'and the minted case still records where it came from',
    repaired.created.sourceSessionId === 's-04',
  );
  await context.call('close_session');

  globalThis.fetch = realFetch;

  console.log('\n\x1b[1msessions on a deployment without a database\x1b[0m');
  setSessionsUnavailable();
  await expectError(
    'the tools refuse clearly instead of hanging',
    () => context.call('search_sessions', {}),
    'no production session data',
  );
  configureSessionsSource(memorySessionsSource(DEPLOYMENTS, SESSIONS));

  console.log('\n\x1b[1mincident tools\x1b[0m');
  const incidentTools = buildIncidentTools();
  registerToolGroup(context, incidentTools);
  await Promise.resolve();
  check('incident tools registered', context.tools.size >= incidentTools.length, `${incidentTools.length} tools`);
  const incidentReads = incidentTools.filter((tool) => tool.annotations?.readOnlyHint === true).length;
  check('one read, two writes', incidentReads === 1 && incidentTools.length === 3);

  await expectError(
    'open_release_comparison refuses an unknown deployment instead of navigating to nothing',
    () => context.call('open_release_comparison', { baselineDeploymentId: 'deploy-1', candidateDeploymentId: 'deploy-99' }),
    'Unknown deployment',
  );
  await expectError(
    'and refuses to compare a release with itself',
    () => context.call('open_release_comparison', { baselineDeploymentId: 'deploy-1', candidateDeploymentId: 'deploy-1' }),
    'two different deployments',
  );
  const opened = (await context.call('open_release_comparison', {
    baselineDeploymentId: 'deploy-1',
    candidateDeploymentId: 'deploy-2',
  })) as { view: string; releaseComparison: { baselineDeploymentId: string } | null };
  check('open_release_comparison moved the shared view', opened.view === 'releases');
  check('and reports the pair back', opened.releaseComparison?.baselineDeploymentId === 'deploy-1');
  check('the agent is credited', store.getState().lastAction?.source === 'agent');
  check('the human can take it back', store.getState().undoLast('human') === true);

  await context.call('open_tool', { toolName: 'tool_alpha' });
  check('open_tool selected a tool', store.getState().selectedToolName === 'tool_alpha');
  const closed = (await context.call('close_tool')) as { view: string; selectedToolName: string | null };
  check('close_tool returns to the session list', closed.view === 'sessions');
  check('and clears the selection', closed.selectedToolName === null);

  console.log('\n\x1b[1ma paged project, where runs boot summary-only\x1b[0m');
  const fullDataset = getDb().dataset;
  const resultsByRun = new Map(fullDataset.runs.map((run) => [run.id, run.results]));
  setDb(
    createDb({
      ...fullDataset,
      runs: fullDataset.runs.map((run) =>
        run.id === BASELINE || run.id === CANDIDATE ? { ...run, results: [] } : run,
      ),
    }),
  );
  check(
    'the trap is armed: the query layer sees no attempts at all',
    findRegressions(getDb(), BASELINE, CANDIDATE).regressedAttempts === 0,
  );
  const resultRequests: string[] = [];
  const beforePaged = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    resultRequests.push(url);
    const runId = decodeURIComponent(url.match(/eval-runs\/([^/]+)\/results/)?.[1] ?? '');
    const results = resultsByRun.get(runId) ?? [];
    return new Response(JSON.stringify({ results, total: results.length, nextCursor: null }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  const paged = (await context.call('find_regressions', {
    baselineRunId: BASELINE,
    candidateRunId: CANDIDATE,
  })) as { regressedAttempts: number };
  check(
    'find_regressions loads the pair before answering, instead of reporting nothing',
    paged.regressedAttempts === 23,
    `${paged.regressedAttempts} attempts after ${resultRequests.length} result request(s)`,
  );
  check('it fetched both runs, not one', resultRequests.length === 2);
  const cached = (await context.call('compare_trajectories', {
    caseId: target,
    baselineRunId: BASELINE,
    candidateRunId: CANDIDATE,
  })) as { candidate: { calls: unknown[] }; firstDivergenceIndex: number };
  check('a hydrated pair is not fetched twice', resultRequests.length === 2);
  check(
    'and the trajectory has real calls to diverge on',
    cached.candidate.calls.length > 0 && cached.firstDivergenceIndex >= 0,
    `diverges at call ${cached.firstDivergenceIndex}`,
  );

  globalThis.fetch = beforePaged;

  console.log('\n\x1b[1mserialization\x1b[0m');
  for (const tool of context.tools.values()) {
    JSON.stringify(tool.inputSchema ?? {});
  }
  const everything = await Promise.all(
    [
      ['list_runs', {}],
      ['compare_runs', { baselineRunId: BASELINE, candidateRunId: CANDIDATE }],
      ['get_case', { caseId: target }],
      ['list_failure_clusters', {}],
    ].map(([name, input]) => context.call(name as string, input as Record<string, unknown>)),
  );
  check(
    'every payload is JSON-serializable',
    everything.every((payload) => typeof JSON.stringify(payload) === 'string'),
  );

  console.log();
  if (failures.length > 0) {
    console.error(`\x1b[31m${failures.length} check(s) failed:\x1b[0m`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log('\x1b[32mAll WebMCP contract checks passed.\x1b[0m\n');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
