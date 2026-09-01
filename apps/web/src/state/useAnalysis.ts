/**
 * React's view of the analysis registry.
 *
 * The registry itself stays React-free — it is read by WebMCP tools and Node
 * scripts too — so the binding lives here, as an external store. The version
 * counter is the snapshot: it changes when deterministic analysis is registered,
 * and nothing else re-renders on it.
 */

import { useSyncExternalStore } from 'react';

import {
  getAnalysisEntry,
  getAnalysisVersion,
  subscribeAnalysis,
} from '@catchfly/core/analysis-db.ts';
import type { AnalysisEntry } from '@catchfly/core/analysis.ts';
import type { Comparison } from './store.ts';

export function useAnalysisEntry(comparison: Comparison | null): AnalysisEntry | null {
  const version = useSyncExternalStore(subscribeAnalysis, getAnalysisVersion, getAnalysisVersion);
  // `version` is the dependency, not the value: reading through it is what ties
  // this lookup to the registry's change feed.
  void version;
  return comparison ? getAnalysisEntry(comparison.baselineRunId, comparison.candidateRunId) : null;
}
