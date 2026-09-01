/**
 * Derived views over state + data. Nothing here holds state of its own — every
 * answer is recomputed from the store's filters and the query primitives, so
 * the human and the agent always look at the same numbers.
 *
 * Selectors are memoised on the identity of the state object. zustand hands
 * components a new state object only when something actually changed, so this
 * both keeps references stable across renders (a selector returning a fresh
 * array on every call would re-render forever) and stops the query layer from
 * recomputing 1200 rows for nothing.
 */

import { getDb } from '@catchfly/core/db.ts';
import {
  compareRuns,
  compareTrajectories,
  filterCases,
  findRegressions,
  getCase,
  groupResults,
  listRuns,
  type CaseDetail,
  type CaseRow,
  type Group,
  type GroupBy,
  type RegressionReport,
  type RunComparison,
  type RunSummary,
  type TrajectoryComparison,
} from '@catchfly/core/queries.ts';
import { useCatchflyStore, type CatchflyState, type CatchflyStore, type TraceEntry } from './store.ts';

export type Selector<T> = (state: CatchflyStore) => T;

function memoize<T>(compute: Selector<T>): Selector<T> {
  const cache = new WeakMap<CatchflyStore, T>();
  return (state) => {
    if (cache.has(state)) return cache.get(state) as T;
    const value = compute(state);
    cache.set(state, value);
    return value;
  };
}

export const visibleCases = memoize<CaseRow[]>((state) =>
  state.ready ? filterCases(getDb(), state.filters) : [],
);

const groupCaches = new Map<GroupBy, Selector<Group[]>>();

/** `useSelector(visibleGroups('category'))` — one memoised selector per grouping. */
export function visibleGroups(groupBy: GroupBy): Selector<Group[]> {
  const cached = groupCaches.get(groupBy);
  if (cached) return cached;
  const selector = memoize<Group[]>((state) => groupResults(visibleCases(state), groupBy));
  groupCaches.set(groupBy, selector);
  return selector;
}

export const activeComparison = memoize<RunComparison | null>((state) =>
  state.ready && state.comparison
    ? compareRuns(getDb(), state.comparison.baselineRunId, state.comparison.candidateRunId)
    : null,
);

export const activeRegressions = memoize<RegressionReport | null>((state) =>
  state.ready && state.comparison
    ? findRegressions(getDb(), state.comparison.baselineRunId, state.comparison.candidateRunId)
    : null,
);

export const selectedCase = memoize<CaseDetail | null>((state) =>
  state.ready && state.selectedCaseId ? getCase(getDb(), state.selectedCaseId) : null,
);

export const selectedTrajectory = memoize<TrajectoryComparison | null>((state) => {
  if (!state.ready || !state.selectedCaseId || !state.comparison) return null;
  return compareTrajectories(
    getDb(),
    state.selectedCaseId,
    state.comparison.baselineRunId,
    state.comparison.candidateRunId,
  );
});

export function pendingCall(state: CatchflyState): TraceEntry | null {
  return state.agentTrace.find((entry) => entry.status === 'pending') ?? null;
}

export function agentBusy(state: CatchflyState): boolean {
  return state.agentTrace.some((entry) => entry.status === 'pending');
}

/** Run list is state-independent; read it straight off the dataset. */
export function allRuns(): RunSummary[] {
  return listRuns(getDb());
}

/** Hook form, for components: `useSelector(visibleCases)`. */
export function useSelector<T>(selector: Selector<T>): T {
  return useCatchflyStore(selector);
}
