/**
 * The global Catchfly tool set — what an agent can always do.
 *
 * Every tool is a thin wrapper over the same two layers the human uses: the
 * query primitives in src/data/queries.ts and the named store actions in
 * src/state/store.ts. Write tools pass source 'agent', so the UI can show who
 * changed the shared state, and the human can undo it.
 *
 * Design rule from the PRD: deterministic access and manipulation primitives;
 * interpretation stays with the agent.
 */

import { getAnalysisEntry, getAnalysisProvenance, whenAnalysisSettled } from '@catchfly/core/analysis-db.ts';
import { getDb } from '@catchfly/core/db.ts';
import { getSessionList, isSessionsAvailable } from '@catchfly/core/sessions-db.ts';
import {
  compareRuns,
  compareTrajectories,
  filterCases,
  findRegressions,
  getCase,
  groupResults,
  listAppVersions,
  listRuns,
  type CaseFilters,
  type GroupBy,
} from '@catchfly/core/queries.ts';
import { activateProject, listProjectInfo } from '../data/projects.ts';
import { activateComparison, ensureRunResults, summaryOnlyRuns } from '../data/load.ts';
import { FAILURE_CATEGORIES, type FailureCategory, type Outcome } from '@catchfly/core/types.ts';
import { catchflyStore, type ViewName } from '../state/store.ts';
import { visibleCases } from '../state/selectors.ts';
import {
  attemptPayload,
  caseRowPayload,
  clusterPayload,
  regressionPayload,
  trajectoryPayload,
  truncated,
} from '@catchfly/webmcp/payloads.ts';
import type { ModelContextTool } from '@catchfly/webmcp/spec.ts';

// --- input parsing -----------------------------------------------------
//
// The browser validates inputs against inputSchema before execute runs, but a
// tool must not trust that: a clear error message back to the agent beats a
// crash inside the query layer.

export function asString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`"${key}" must be a non-empty string`);
  }
  return value;
}

export function asOptionalString(input: Record<string, unknown>, key: string): string | undefined {
  return input[key] === undefined ? undefined : asString(input, key);
}

function asRunId(input: Record<string, unknown>, key: string): string {
  const runId = asString(input, key);
  if (!getDb().runsById.has(runId)) {
    const known = getDb()
      .dataset.runs.map((run) => run.id)
      .join(', ');
    throw new Error(`Unknown run "${runId}". Known runs: ${known}`);
  }
  return runId;
}

function runPair(input: Record<string, unknown>): [string, string] {
  return [asRunId(input, 'baselineRunId'), asRunId(input, 'candidateRunId')];
}

function asCaseId(input: Record<string, unknown>, key: string): string {
  const caseId = asString(input, key);
  if (!getDb().casesById.has(caseId)) {
    throw new Error(`Unknown case "${caseId}". Call filter_cases to see the ids in this project.`);
  }
  return caseId;
}

const OUTCOMES: Array<Outcome | 'any-failure'> = ['pass', 'fail', 'error', 'any-failure'];
const GROUPINGS: GroupBy[] = ['category', 'outcome', 'model', 'appVersion', 'tool'];
const VIEWS: ViewName[] = [
  'overview',
  'releases',
  'regressions',
  'cases',
  'case-detail',
  'sessions',
  'sources',
  'settings',
  'system',
  'session-detail',
  'tool-profile',
];

export function asEnum<T extends string>(input: Record<string, unknown>, key: string, allowed: T[]): T | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`"${key}" must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

/** Parses the filter fields shared by filter_cases and set_dashboard_filters. */
function parseFilters(input: Record<string, unknown>): CaseFilters {
  const filters: CaseFilters = {};
  const runId = asOptionalString(input, 'runId');
  if (runId !== undefined) filters.runId = asRunId(input, 'runId');
  const appVersionId = asOptionalString(input, 'appVersionId');
  if (appVersionId !== undefined) {
    if (!getDb().versionsById.has(appVersionId)) {
      const known = listAppVersions(getDb())
        .map((version) => version.id)
        .join(', ');
      throw new Error(`Unknown app version "${appVersionId}". Known versions: ${known}`);
    }
    filters.appVersionId = appVersionId;
  }
  const model = asOptionalString(input, 'model');
  if (model !== undefined) {
    if (!getDb().models.includes(model)) {
      throw new Error(`Unknown model "${model}". Known models: ${getDb().models.join(', ')}`);
    }
    filters.model = model;
  }
  const category = asEnum(input, 'category', FAILURE_CATEGORIES as FailureCategory[]);
  if (category !== undefined) filters.category = category;
  const outcome = asEnum(input, 'outcome', OUTCOMES);
  if (outcome !== undefined) filters.outcome = outcome;
  const search = asOptionalString(input, 'search');
  if (search !== undefined) filters.search = search;
  const toolCalled = asOptionalString(input, 'toolCalled');
  if (toolCalled !== undefined) filters.toolCalled = toolCalled;
  if (input.caseIds !== undefined) {
    if (!Array.isArray(input.caseIds) || !input.caseIds.every((id) => typeof id === 'string')) {
      throw new Error('"caseIds" must be an array of case id strings');
    }
    filters.caseIds = input.caseIds;
  }
  return filters;
}

// --- shared schema fragments -------------------------------------------

const RUN_ID = { type: 'string', description: 'A run id. Call list_runs for the ids in this project.' };

const FILTER_PROPERTIES = {
  runId: { ...RUN_ID, description: 'Restrict to one eval run.' },
  appVersionId: {
    type: 'string',
    description: 'Restrict to one app version. Call list_runs for the ids in this project.',
  },
  model: { type: 'string', description: 'Restrict to one model.' },
  category: {
    type: 'string',
    enum: FAILURE_CATEGORIES,
    description: 'Only cases that failed with this category.',
  },
  outcome: {
    type: 'string',
    enum: OUTCOMES,
    description: '"any-failure" matches cases with at least one non-passing attempt.',
  },
  search: { type: 'string', description: 'Free-text match over case name and prompt.' },
  toolCalled: { type: 'string', description: 'Only cases where the model actually called this tool.' },
  caseIds: {
    type: 'array',
    items: { type: 'string' },
    description: 'Restrict to an explicit list of case ids.',
  },
} as const;

export const SEES_AND_CAN_UNDO = ' The developer sees this immediately and can undo it.';

function runLabel(runId: string): string {
  const run = getDb().runsById.get(runId);
  if (!run) return runId;
  const version = getDb().versionsById.get(run.appVersionId)?.label ?? run.appVersionId;
  return `${version} · ${run.model}`;
}

function visibleSessions(): { shown: number; matching: number } | null {
  if (!isSessionsAvailable()) return null;
  const list = getSessionList(catchflyStore.getState().sessionFilters);
  if (!list || list.status !== 'ready') return null;
  return { shown: list.value.sessions.length, matching: list.value.total };
}

export function runCoverage(): { coverage?: { loadedRuns: number; totalRuns: number; note: string } } {
  const runIds = getDb().dataset.runs.map((run) => run.id);
  const pending = summaryOnlyRuns(runIds).length;
  if (pending === 0) return {};
  const loadedRuns = runIds.length - pending;
  return {
    coverage: {
      loadedRuns,
      totalRuns: runIds.length,
      note:
        `Attempts are loaded for ${loadedRuns} of ${runIds.length} runs. The rest are summary-only ` +
        'and contribute no rows here — find_regressions or compare_trajectories on a run pair loads that pair.',
    },
  };
}

/** What the dashboard currently shows — returned by every write tool as well. */
export function describeSharedState() {
  const state = catchflyStore.getState();
  const project = getDb().dataset.project;
  const lastAction = state.lastAction;
  return {
    project: { id: project.id, name: project.name },
    view: state.view,
    comparison: state.comparison
      ? {
          ...state.comparison,
          baselineLabel: runLabel(state.comparison.baselineRunId),
          candidateLabel: runLabel(state.comparison.candidateRunId),
        }
      : null,
    releaseComparison: state.releaseComparison,
    filters: state.filters,
    selectedCaseId: state.selectedCaseId,
    visibleCases: visibleCases(state).length,
    // The session half of the shared state. An agent reading this back after a
    // write needs to know which trace and which tool the developer is on, not
    // only which case.
    selectedSessionId: state.selectedSessionId,
    selectedToolName: state.selectedToolName,
    sessionFilters: state.sessionFilters,
    visibleSessions: visibleSessions(),
    undoDepth: state.undoStack.length,
    revertedByHuman: lastAction?.name === 'undo' && lastAction.source === 'human',
    lastAction: lastAction ? { name: lastAction.name, source: lastAction.source, summary: lastAction.summary } : null,
  };
}

export function writeResult<T extends Record<string, unknown>>(extra?: T) {
  return { ...(extra ?? ({} as T)), state: describeSharedState() };
}

/**
 * Whether the developer can see the case this payload describes.
 *
 * Read tools answer in the agent's context, which the developer never sees; the
 * dashboard keeps showing whatever it showed before. Models routinely analyse a
 * case at length without ever putting it on screen, so every case-level read
 * states the fact. It is a fact about shared state, not an instruction: when the
 * developer asked for a read and nothing more, the right move is still to answer
 * without touching their view.
 */
function visibility(caseId: string): { shownToUser: boolean; hint?: string } {
  const state = catchflyStore.getState();
  if (state.selectedCaseId === caseId && state.view === 'case-detail') return { shownToUser: true };
  return {
    shownToUser: false,
    hint: `The developer is not looking at this case — open_case with caseId "${caseId}" puts it on their screen.`,
  };
}

// --- the tools ---------------------------------------------------------

export function buildGlobalTools(): ModelContextTool[] {
  return [
    {
      name: 'get_current_view',
      title: 'Read the shared screen',
      description:
        'Read what the Catchfly dashboard currently shows: active view, run comparison, filters, ' +
        'selected case, and the last action either operator took. Call this first ' +
        'to see the state the developer is looking at.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
      execute: async () => describeSharedState(),
    },

    {
      name: 'list_projects',
      title: 'List projects',
      description:
        'List the projects (datasets) this dashboard can point at, and which one is active. ' +
        'One of them is Catchfly itself — its own WebMCP tools, evaluated by the Chrome ' +
        'WebMCP Evals runner. Use switch_project to change.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
      execute: async () => ({
        projects: listProjectInfo().map((project) => ({
          ...project,
          active: project.id === catchflyStore.getState().projectId,
        })),
      }),
    },

    {
      name: 'list_runs',
      title: 'List eval runs',
      description:
        'List eval runs with their metrics: success rate, pass/fail/error counts, average latency ' +
        'and total cost. Each run is one app version evaluated with one model.',
      inputSchema: {
        type: 'object',
        properties: {
          appVersionId: FILTER_PROPERTIES.appVersionId,
          model: FILTER_PROPERTIES.model,
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      execute: async (input) => ({
        runs: listRuns(getDb(), {
          appVersionId: asOptionalString(input, 'appVersionId'),
          model: asOptionalString(input, 'model'),
        }),
        appVersions: listAppVersions(getDb()).map((version) => ({
          id: version.id,
          label: version.label,
          note: version.note ?? null,
          tools: version.toolManifest.map((tool) => tool.name),
        })),
      }),
    },

    {
      name: 'compare_runs',
      title: 'Compare two runs',
      description:
        'Compare two eval runs: success-rate, latency and cost deltas, plus failure counts per ' +
        'category in each run. Purely a read — use set_dashboard_filters or open_case to change ' +
        'what the developer sees.',
      inputSchema: {
        type: 'object',
        properties: { baselineRunId: RUN_ID, candidateRunId: RUN_ID },
        required: ['baselineRunId', 'candidateRunId'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      execute: async (input) => {
        const [baselineRunId, candidateRunId] = runPair(input);
        await ensureRunResults([baselineRunId, candidateRunId]);
        return compareRuns(getDb(), baselineRunId, candidateRunId);
      },
    },

    {
      name: 'find_regressions',
      title: 'Find regressions',
      description:
        'Find what got worse between two runs, ignoring failures already present in the baseline. ' +
        'A regression is a lost passing attempt: a case that passed some of its repeated attempts ' +
        'and now passes fewer. Returns totals, a per-category breakdown, the regressed cases (worst first) and ' +
        'the cases the candidate fixed.',
      inputSchema: {
        type: 'object',
        properties: { baselineRunId: RUN_ID, candidateRunId: RUN_ID },
        required: ['baselineRunId', 'candidateRunId'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      execute: async (input) => {
        const [baselineRunId, candidateRunId] = runPair(input);
        await ensureRunResults([baselineRunId, candidateRunId]);
        return regressionPayload(findRegressions(getDb(), baselineRunId, candidateRunId));
      },
    },

    {
      name: 'filter_cases',
      title: 'Query cases',
      description:
        'Query eval cases without changing what the developer sees. Returns matching cases with their ' +
        'pass rates and dominant failure category. Only runs whose attempts are loaded contribute ' +
        'rows; a coverage field says when that is not all of them. To apply the same filters to the ' +
        'shared dashboard, call set_dashboard_filters.',
      inputSchema: {
        type: 'object',
        properties: FILTER_PROPERTIES,
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      execute: async (input) => {
        const filters = parseFilters(input);
        if (filters.runId) await ensureRunResults([filters.runId]);
        const rows = filterCases(getDb(), filters);
        return { ...runCoverage(), cases: truncated(rows.map(caseRowPayload)) };
      },
    },

    {
      name: 'group_results',
      title: 'Group results',
      description:
        'Aggregate case results by category, outcome, model, appVersion or tool. Groups the ' +
        'currently visible cases by default; pass filters to group a different slice instead.',
      inputSchema: {
        type: 'object',
        properties: {
          groupBy: { type: 'string', enum: GROUPINGS, description: 'Dimension to group by.' },
          ...FILTER_PROPERTIES,
        },
        required: ['groupBy'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      execute: async (input) => {
        const groupBy = asEnum(input, 'groupBy', GROUPINGS);
        if (!groupBy) throw new Error(`"groupBy" must be one of: ${GROUPINGS.join(', ')}`);
        const { groupBy: _ignored, ...rest } = input;
        const filters = Object.keys(rest).length > 0 ? parseFilters(rest) : catchflyStore.getState().filters;
        if (filters.runId) await ensureRunResults([filters.runId]);
        return { ...runCoverage(), groupBy, groups: groupResults(filterCases(getDb(), filters), groupBy) };
      },
    },

    {
      name: 'get_case',
      title: 'Read a case',
      description:
        'Read one eval case: its prompt, the expected tool calls, and per-run results across every ' +
        'app version and model, with every attempt\'s call sequence, arguments, outcome and failure ' +
        'reason — the same shape inspect_selected_case returns. Purely a read — use open_case to ' +
        'show the case to the developer. If the case is already open, inspect_selected_case reads ' +
        'the same thing without needing an id.',
      inputSchema: {
        type: 'object',
        properties: {
          caseId: { type: 'string', description: 'A case id. Call filter_cases for the ids in this project.' },
          failingOnly: { type: 'boolean', description: 'Return only the attempts that did not pass.' },
        },
        required: ['caseId'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      execute: async (input) => {
        const detail = getCase(getDb(), asCaseId(input, 'caseId'));
        const failingOnly = input.failingOnly === true;
        return {
          ...visibility(detail.definition.caseId),
          ...runCoverage(),
          caseId: detail.definition.caseId,
          name: detail.definition.name,
          prompt: detail.definition.prompt,
          expectedBehavior: detail.definition.expectedBehavior ?? null,
          expectedCall: detail.definition.expectedCall,
          runs: detail.runs.map((run) => ({
            runId: run.runId,
            appVersion: run.appVersionLabel,
            model: run.model,
            passes: run.passes,
            repeats: run.repeats,
            attempts: run.attempts
              .filter((attempt) => !failingOnly || attempt.outcome !== 'pass')
              .map(attemptPayload),
          })),
        };
      },
    },

    {
      name: 'compare_trajectories',
      title: 'Compare trajectories',
      description:
        'Put one case\'s tool-call trajectory in two runs side by side: a passing baseline attempt ' +
        'against a failing candidate attempt, the first call where they diverge, and which tools ' +
        'were added or removed between the two app versions. If the case is already open, ' +
        'compare_selected_trajectories does this without needing any ids.',
      inputSchema: {
        type: 'object',
        properties: {
          caseId: { type: 'string', description: 'A case id. Call filter_cases for the ids in this project.' },
          baselineRunId: RUN_ID,
          candidateRunId: RUN_ID,
        },
        required: ['caseId', 'baselineRunId', 'candidateRunId'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      execute: async (input) => {
        const caseId = asCaseId(input, 'caseId');
        const [baselineRunId, candidateRunId] = runPair(input);
        await ensureRunResults([baselineRunId, candidateRunId]);
        return {
          ...visibility(caseId),
          ...trajectoryPayload(compareTrajectories(getDb(), caseId, baselineRunId, candidateRunId)),
        };
      },
    },

    {
      name: 'list_failure_clusters',
      title: 'List failure clusters',
      description:
        'List the failure clusters for a run comparison: regressed cases grouped by failure ' +
        'category, by where their tool calls diverge from the baseline, and by failure reason. ' +
        'Each cluster carries a deterministic label and summary plus the case ids — hand those ' +
        'to set_dashboard_filters to show the developer one cluster. Defaults to the comparison the ' +
        'developer is currently viewing. Root cause stays explicitly unanalysed.',
      inputSchema: {
        type: 'object',
        properties: {
          baselineRunId: { ...RUN_ID, description: 'Baseline run. Defaults to the active comparison.' },
          candidateRunId: { ...RUN_ID, description: 'Candidate run. Defaults to the active comparison.' },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: async (input) => {
        await whenAnalysisSettled();

        const hasBaseline = input.baselineRunId !== undefined;
        const hasCandidate = input.candidateRunId !== undefined;
        if (hasBaseline !== hasCandidate) {
          throw new Error(
            'Pass both baselineRunId and candidateRunId, or neither to use the comparison the developer is viewing.',
          );
        }

        const comparison = catchflyStore.getState().comparison;
        const baselineRunId = hasBaseline ? asRunId(input, 'baselineRunId') : comparison?.baselineRunId;
        const candidateRunId = hasCandidate ? asRunId(input, 'candidateRunId') : comparison?.candidateRunId;
        if (!baselineRunId || !candidateRunId) {
          throw new Error(
            'No comparison is active yet. Pass baselineRunId and candidateRunId explicitly — see list_runs.',
          );
        }

        const entry = getAnalysisEntry(baselineRunId, candidateRunId);
        // Absence is an answer, not an error: the agent can still do the work
        // itself with the deterministic tools, so say so instead of failing.
        if (!entry) {
          return {
            baselineRunId,
            candidateRunId,
            clusters: null,
            note:
              'No precomputed analysis for this comparison. Cluster the failures yourself with ' +
              'find_regressions, group_results and compare_trajectories.',
          };
        }
        // Shape stays constant whether or not there is anything to report:
        // `clusters` is null only when there is no analysis at all.
        return {
          baselineRunId,
          candidateRunId,
          provenance: getAnalysisProvenance(),
          clusters: truncated(entry.clusters.map(clusterPayload)),
          ...(entry.clusters.length === 0 ? { note: 'No regressions between these runs.' } : {}),
        };
      },
    },

    // --- write tools: these change what the user is looking at ----------

    {
      name: 'undo_last',
      title: 'Undo the last action',
      description:
        'Revert the most recent change to the shared dashboard, whoever made it — the same Undo ' +
        'button the developer has. Returns undone: false when there is nothing to revert. ' +
        'The developer sees the reverted state immediately.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => writeResult({ undone: catchflyStore.getState().undoLast('agent') }),
    },

    {
      name: 'switch_project',
      title: 'Switch project',
      description:
        'Point the whole shared dashboard at a different project (dataset). Filters and selection ' +
        'reset, because they reference ids that only exist in the current project. ' +
        'The developer sees the change immediately; it cannot be undone, only switched back. ' +
        'Returns the resulting state.',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'A project id from list_projects, e.g. "catchfly".' },
        },
        required: ['projectId'],
        additionalProperties: false,
      },
      execute: async (input) => {
        await activateProject(asString(input, 'projectId'), 'agent');
        return writeResult();
      },
    },

    {
      name: 'set_dashboard_filters',
      title: 'Filter the dashboard',
      description:
        'Change the filters of the shared dashboard. Only the fields you pass change; pass reset: ' +
        'true to clear everything first. Switching the view away from an open case or session ' +
        'closes it and revokes its scoped tools. Returns the resulting state.' + SEES_AND_CAN_UNDO,
      inputSchema: {
        type: 'object',
        properties: {
          ...FILTER_PROPERTIES,
          reset: { type: 'boolean', description: 'Clear all existing filters before applying.' },
          view: { type: 'string', enum: VIEWS, description: 'Also switch the dashboard view.' },
        },
        additionalProperties: false,
      },
      execute: async (input) => {
        const { reset, view, ...rest } = input;
        const filters = parseFilters(rest);
        const targetView = asEnum({ view }, 'view', VIEWS);
        catchflyStore
          .getState()
          .setFilters(filters, 'agent', { reset: reset === true, view: targetView });
        return writeResult();
      },
    },

    {
      name: 'set_comparison',
      title: 'Change the comparison',
      description:
        'Point the shared regression view at a different baseline/candidate run pair. ' +
        'Returns the resulting state.' + SEES_AND_CAN_UNDO,
      inputSchema: {
        type: 'object',
        properties: { baselineRunId: RUN_ID, candidateRunId: RUN_ID },
        required: ['baselineRunId', 'candidateRunId'],
        additionalProperties: false,
      },
      execute: async (input) => {
        await activateComparison(
          { baselineRunId: asRunId(input, 'baselineRunId'), candidateRunId: asRunId(input, 'candidateRunId') },
          'agent',
        );
        return writeResult();
      },
    },

    {
      name: 'open_case',
      title: 'Open a case',
      description:
        'Open one case in the shared case-detail view. Selecting a case also ' +
        'registers case-scoped tools (inspect_selected_case, compare_selected_trajectories, ' +
        'close_case). Returns the resulting state.' + SEES_AND_CAN_UNDO,
      inputSchema: {
        type: 'object',
        properties: { caseId: { type: 'string', description: 'A case id. Call filter_cases for the ids in this project.' } },
        required: ['caseId'],
        additionalProperties: false,
      },
      execute: async (input) => {
        catchflyStore.getState().openCase(asCaseId(input, 'caseId'), 'agent');
        return writeResult();
      },
    },
  ];
}
