import { useEffect, useState } from 'react';

import { comparisonResultsLoaded, ensureComparisonResults } from '../data/load.ts';
import { useCatchflyStore } from './store.ts';

/** Loads the two run bodies only when a detail view actually needs them. */
export function useComparisonEvidence(): { ready: boolean; error: string | null } {
  const comparison = useCatchflyStore((state) => state.comparison);
  useCatchflyStore((state) => state.datasetVersion);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const key = comparison ? `${comparison.baselineRunId}::${comparison.candidateRunId}` : '';
  const ready = comparison ? comparisonResultsLoaded(comparison) : true;

  useEffect(() => {
    if (!comparison || ready) return;
    let active = true;
    void ensureComparisonResults(comparison).catch((reason: unknown) => {
      if (active) setFailure({ key, message: reason instanceof Error ? reason.message : String(reason) });
    });
    return () => {
      active = false;
    };
  }, [comparison, key, ready]);

  return { ready, error: failure?.key === key ? failure.message : null };
}
