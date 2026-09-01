import { create } from 'zustand';

import type { CaseFilters } from '@catchfly/core/queries.ts';
import type { SessionFilters } from '@catchfly/core/session-types.ts';
import { getDeployments } from '@catchfly/core/sessions-db.ts';
import type { WebMcpStatus } from '@catchfly/webmcp/spec.ts';

export type ViewName =
  | 'overview'
  | 'releases'
  | 'regressions'
  | 'cases'
  | 'case-detail'
  | 'sessions'
  | 'sources'
  | 'settings'
  | 'system'
  | 'profile'
  | 'session-detail'
  | 'tool-profile';

/** Who performed an action. Tools always pass 'agent'. */
export type ActionSource = 'human' | 'agent';

export type Comparison = { baselineRunId: string; candidateRunId: string };

export type ReleaseComparison = { baselineDeploymentId: string; candidateDeploymentId: string };

export type TraceEntry = {
  id: string;
  tool: string;
  title: string;
  kind: 'read' | 'write' | 'durable';
  summary: string;
  at: string;
  status: 'pending' | 'ok' | 'failed';
  durationMs?: number;
  error?: string;
};

export type TraceOutcome = {
  status: 'ok' | 'failed';
  durationMs: number;
  kind?: TraceEntry['kind'];
  error?: string;
};

export type ActionRecord = {
  name: string;
  source: ActionSource;
  summary: string;
  at: string;
  reversible: boolean;
};

export type UndoEntry = { snapshot: Snapshot; action: ActionRecord };

/** The part of the state an action can change — and that undo restores. */
type Snapshot = {
  view: ViewName;
  comparison: Comparison | null;
  /** The two deployments whose production traffic is being compared. */
  releaseComparison: ReleaseComparison | null;
  filters: CaseFilters;
  selectedCaseId: string | null;
  /** The session on screen, and the filters that found it. */
  selectedSessionId: string | null;
  sessionFilters: SessionFilters;
  /** The tool whose profile is on screen. */
  selectedToolName: string | null;
};

export type CatchflyState = Snapshot & {
  ready: boolean;
  /** Which dataset the dashboard is looking at — see src/data/projects.ts. */
  projectId: string;
  /** Set when the dataset could not be loaded — the app says so instead of spinning. */
  loadError: string | null;
  /** The deployment is fine, it just holds no projects yet. */
  isEmpty: boolean;
  authRequired: boolean;
  /** The signed-in user, outside Snapshot so neither undo nor an agent can revert it. */
  account: { userId: string; email: string; orgId: string | null; orgName: string | null } | null;
  /** Whether an agent in this browser can reach the page's tools. */
  webmcpStatus: WebMcpStatus;
  /**
   * Bumped whenever the dataset itself changes. Selectors memoise on the state
   * object, so an import that only touches the dataset would otherwise serve
   * stale results.
   */
  datasetVersion: number;
  lastAction: ActionRecord | null;
  /** Most recent first, capped — enough to show what the agent just did. */
  actionLog: ActionRecord[];
  agentTrace: TraceEntry[];
  undoStack: UndoEntry[];
};

type Actions = {
  markReady: (comparison: Comparison | null, projectId: string) => void;
  /**
   * Replaces the active dataset. Everything positional — filters, selection,
   * undo — resets with it: those reference case and run ids that do
   * not exist in the dataset being switched to.
   */
  switchDataset: (
    projectId: string,
    projectName: string,
    comparison: Comparison | null,
    source?: ActionSource,
  ) => void;
  failToLoad: (message: string) => void;
  markEmpty: () => void;
  requireAuth: () => void;
  setAccount: (account: CatchflyState['account']) => void;
  setWebMcpStatus: (status: WebMcpStatus) => void;
  /** Records that the active dataset gained a run. */
  noteImport: (summary: string, source?: ActionSource) => void;
  /** A lazy large-project read filled in run bodies without changing the view. */
  refreshDataset: () => void;
  setView: (view: ViewName, source?: ActionSource) => void;
  setComparison: (comparison: Comparison, source?: ActionSource) => void;
  setReleaseComparison: (comparison: ReleaseComparison, source?: ActionSource) => void;
  setFilters: (patch: CaseFilters, source?: ActionSource, options?: FilterOptions) => void;
  resetFilters: (source?: ActionSource) => void;
  openCase: (caseId: string, source?: ActionSource) => void;
  closeCase: (source?: ActionSource) => void;
  setSessionFilters: (patch: SessionFilters, source?: ActionSource, options?: SessionFilterOptions) => void;
  resetSessionFilters: (source?: ActionSource) => void;
  openSession: (sessionId: string, source?: ActionSource) => void;
  closeSession: (source?: ActionSource) => void;
  openTool: (toolName: string, source?: ActionSource) => void;
  closeTool: (source?: ActionSource) => void;
  undoLast: (source?: ActionSource) => boolean;
  beginToolCall: (entry: TraceEntry) => void;
  finishToolCall: (id: string, outcome: TraceOutcome) => void;
};

export type FilterOptions = { reset?: boolean; view?: ViewName };
export type SessionFilterOptions = { reset?: boolean };

export type CatchflyStore = CatchflyState & Actions;

const ACTION_LOG_LIMIT = 20;
const UNDO_LIMIT = 20;
const TRACE_LIMIT = 50;

const INITIAL: Snapshot = {
  view: 'overview',
  comparison: null,
  releaseComparison: null,
  filters: {},
  selectedCaseId: null,
  selectedSessionId: null,
  sessionFilters: {},
  selectedToolName: null,
};

function snapshotOf(state: CatchflyStore): Snapshot {
  return {
    view: state.view,
    comparison: state.comparison,
    releaseComparison: state.releaseComparison,
    filters: { ...state.filters },
    selectedCaseId: state.selectedCaseId,
    selectedSessionId: state.selectedSessionId,
    sessionFilters: { ...state.sessionFilters },
    selectedToolName: state.selectedToolName,
  };
}

/** Timestamps are read at call time so the store stays free of side effects elsewhere. */
function record(name: string, source: ActionSource, summary: string, reversible = true): ActionRecord {
  return { name, source, summary, at: new Date().toISOString(), reversible };
}

function viewChanges(view: ViewName): Partial<Snapshot> {
  return {
    view,
    ...(view === 'case-detail' ? {} : { selectedCaseId: null }),
    ...(view === 'session-detail' || view === 'tool-profile' ? {} : { selectedSessionId: null }),
    ...(view === 'tool-profile' ? {} : { selectedToolName: null }),
  };
}

export const useCatchflyStore = create<CatchflyStore>((set, get) => {
  /** Applies a state change, pushing an undo point and logging who did it. */
  const apply = (
    name: string,
    source: ActionSource,
    summary: string,
    changes: Partial<Snapshot>,
  ): void => {
    const snapshot = snapshotOf(get());
    const action = record(name, source, summary);
    set((state) => ({
      ...changes,
      lastAction: action,
      actionLog: [action, ...state.actionLog].slice(0, ACTION_LOG_LIMIT),
      undoStack: [{ snapshot, action }, ...state.undoStack].slice(0, UNDO_LIMIT),
    }));
  };

  return {
    ...INITIAL,
    ready: false,
    projectId: '',
    loadError: null,
    isEmpty: false,
    authRequired: false,
    account: null,
    webmcpStatus: 'unsupported',
    datasetVersion: 0,
    lastAction: null,
    actionLog: [],
    agentTrace: [],
    undoStack: [],

    markReady: (comparison, projectId) =>
      set({ ready: true, loadError: null, isEmpty: false, comparison, projectId }),

    switchDataset: (projectId, projectName, comparison, source = 'human') => {
      const action = record('switch_project', source, `Switched to the ${projectName} project`, false);
      set((state) => ({
        ...INITIAL,
        comparison,
        projectId,
        datasetVersion: state.datasetVersion + 1,
        lastAction: action,
        actionLog: [action, ...state.actionLog].slice(0, ACTION_LOG_LIMIT),
        undoStack: [],
      }));
    },

    failToLoad: (message) => set({ ready: false, loadError: message }),

    markEmpty: () => set({ ready: false, loadError: null, isEmpty: true }),

    requireAuth: () => set({ ready: false, loadError: null, isEmpty: false, authRequired: true }),
    setAccount: (account) => set({ account }),

    setWebMcpStatus: (status) => set({ webmcpStatus: status }),

    noteImport: (summary, source = 'human') => {
      const action = record('import_run', source, summary, false);
      set((state) => ({
        datasetVersion: state.datasetVersion + 1,
        lastAction: action,
        actionLog: [action, ...state.actionLog].slice(0, ACTION_LOG_LIMIT),
      }));
    },

    refreshDataset: () => set((state) => ({ datasetVersion: state.datasetVersion + 1 })),

    setView: (view, source = 'human') =>
      apply('set_view', source, `Switched to the ${view} view`, viewChanges(view)),

    setComparison: (comparison, source = 'human') =>
      apply(
        'set_comparison',
        source,
        `Comparing ${comparison.baselineRunId} against ${comparison.candidateRunId}`,
        { comparison, view: 'regressions' },
      ),

    setReleaseComparison: (releaseComparison, source = 'human') =>
      apply(
        'set_release_comparison',
        source,
        `Comparing production on ${releaseComparison.baselineDeploymentId} against ` +
          `${releaseComparison.candidateDeploymentId}`,
        { releaseComparison, view: 'releases' },
      ),

    setFilters: (patch, source = 'human', options) => {
      const filters = { ...(options?.reset === true ? {} : get().filters), ...patch };
      // An explicit undefined clears a filter rather than pinning it.
      for (const key of Object.keys(patch) as Array<keyof CaseFilters>) {
        if (patch[key] === undefined) delete filters[key];
      }
      const described = Object.entries(patch)
        .map(([key, value]) => `${key}=${Array.isArray(value) ? `${value.length} ids` : String(value)}`)
        .join(', ');
      const parts = [
        ...(options?.reset === true ? ['Cleared all filters'] : []),
        ...(Object.keys(patch).length > 0 ? [`Filtered by ${described}`] : []),
        ...(options?.view ? [`switched to the ${options.view} view`] : []),
      ];
      apply('set_filters', source, parts.join(', ') || 'Filtered by nothing', {
        filters,
        ...(options?.view ? viewChanges(options.view) : {}),
      });
    },

    resetFilters: (source = 'human') =>
      apply('reset_filters', source, 'Cleared all filters', { filters: {} }),

    openCase: (caseId, source = 'human') =>
      apply('open_case', source, `Opened ${caseId}`, { selectedCaseId: caseId, view: 'case-detail' }),

    closeCase: (source = 'human') =>
      apply('close_case', source, 'Closed the case detail', { selectedCaseId: null, view: 'cases' }),

    setSessionFilters: (patch, source = 'human', options) => {
      const sessionFilters = { ...(options?.reset === true ? {} : get().sessionFilters), ...patch };
      // An explicit undefined clears a filter rather than pinning it, exactly as
      // on the eval side.
      for (const key of Object.keys(patch) as Array<keyof SessionFilters>) {
        if (patch[key] === undefined) delete sessionFilters[key];
      }
      const deployments = getDeployments();
      const releaseOf = (deploymentId: string): string =>
        deployments?.status === 'ready'
          ? (deployments.value.find((entry) => entry.id === deploymentId)?.appVersionId ?? deploymentId)
          : deploymentId;
      const described = Object.entries(patch)
        .map(([key, value]) =>
          key === 'deploymentId' && typeof value === 'string'
            ? `release=${releaseOf(value)}`
            : `${key}=${String(value)}`,
        )
        .join(', ');
      const parts = [
        ...(options?.reset === true ? ['Cleared the session filters'] : []),
        ...(Object.keys(patch).length > 0 ? [`Filtered sessions by ${described}`] : []),
      ];
      apply('set_session_filters', source, parts.join(', ') || 'Filtered sessions by nothing', {
        sessionFilters,
        ...viewChanges('sessions'),
      });
    },

    resetSessionFilters: (source = 'human') =>
      apply('reset_session_filters', source, 'Cleared the session filters', { sessionFilters: {} }),

    openSession: (sessionId, source = 'human') =>
      apply('open_session', source, `Opened session ${sessionId}`, {
        selectedSessionId: sessionId,
        view: 'session-detail',
      }),

    closeSession: (source = 'human') =>
      apply('close_session', source, 'Closed the session', { selectedSessionId: null, view: 'sessions' }),

    openTool: (toolName, source = 'human') =>
      apply('open_tool', source, `Opened the ${toolName} profile`, {
        selectedToolName: toolName,
        view: 'tool-profile',
      }),

    closeTool: (source = 'human') =>
      apply('close_tool', source, 'Closed the tool profile', { selectedToolName: null, view: 'sessions' }),

    beginToolCall: (entry) =>
      set((state) => ({ agentTrace: [entry, ...state.agentTrace].slice(0, TRACE_LIMIT) })),

    finishToolCall: (id, outcome) =>
      set((state) => ({
        agentTrace: state.agentTrace.map((entry) =>
          entry.id === id ? { ...entry, ...outcome, kind: outcome.kind ?? entry.kind } : entry,
        ),
      })),

    undoLast: (source = 'human') => {
      const [entry, ...rest] = get().undoStack;
      if (!entry) return false;
      const action = record('undo', source, `Reverted "${entry.action.summary}"`, false);
      set((state) => ({
        ...entry.snapshot,
        lastAction: action,
        actionLog: [action, ...state.actionLog].slice(0, ACTION_LOG_LIMIT),
        undoStack: rest,
      }));
      return true;
    },
  };
});

/** Store access from outside React — this is how WebMCP tools reach the state. */
export const catchflyStore = {
  getState: useCatchflyStore.getState,
  setState: useCatchflyStore.setState,
  subscribe: useCatchflyStore.subscribe,
};
