/**
 * Failure clusters — regressed cases grouped by how they failed.
 *
 * The bars show the size of each failure mode; the cards describe the computed
 * grouping. Clicking either pins that cluster's cases in the shared table.
 */

import { BarList, type BarDatum } from './BarList.tsx';
import type { AnalysisEntry, AnalysisProvenance, FailureCluster } from '@catchfly/core/analysis.ts';

type Props = {
  entry: AnalysisEntry;
  provenance: AnalysisProvenance | null;
  onSelect: (cluster: FailureCluster) => void;
};

function attemptLabel(count: number): string {
  return `${count} lost`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

export function FailureClusters({ entry, provenance, onSelect }: Props) {
  const { clusters } = entry;
  if (clusters.length === 0) {
    return <p className="muted">No regressions between these runs — nothing to cluster.</p>;
  }

  const bars: BarDatum[] = clusters.map((cluster) => ({
    key: cluster.signature,
    label: cluster.label,
    value: cluster.lostAttempts,
    detail: cluster.summary,
  }));

  const bySignature = new Map(clusters.map((cluster) => [cluster.signature, cluster]));
  return (
    <>
      <BarList
        data={bars}
        format={attemptLabel}
        emphasisKey={clusters[0]?.signature}
        onSelect={(key) => {
          const cluster = bySignature.get(key);
          if (cluster) onSelect(cluster);
        }}
      />

      <ul className="clusters">
        {clusters.map((cluster) => (
          <li key={cluster.signature}>
            <button type="button" className="cluster" onClick={() => onSelect(cluster)}>
              <span className="cluster-head">
                <span className="cluster-label">{cluster.label}</span>
                <span className="cluster-count tabular">
                  {plural(cluster.lostAttempts, 'attempt')} · {plural(cluster.cases, 'case')}
                </span>
              </span>
              <span className="cluster-summary">{cluster.summary}</span>
              {cluster.divergence.baselineTool && cluster.divergence.candidateTool ? (
                <span className="cluster-swap">
                  {cluster.divergence.baselineTool} → {cluster.divergence.candidateTool}
                </span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>

      {provenance ? (
        <p className="muted cluster-provenance">
          Cluster membership, labels and summaries are computed deterministically from the eval data.
        </p>
      ) : null}
    </>
  );
}
