/**
 * Failure clusters — regressed cases grouped by how they failed.
 *
 * Two readings of the same list. The bars answer "how big is each failure
 * mode", which is the question that decides what to fix first; the cards below
 * answer "what is it and why", which is the part a model wrote. Clicking either
 * pins that cluster's cases in the shared table, so the panel hands off to the
 * same filtered view the agent produces through set_dashboard_filters.
 *
 * The generated half is labelled as generated. A root-cause line is a
 * hypothesis about a probabilistic system, and presenting it as a finding would
 * be the wrong kind of confident.
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
  // Placeholder prose says the same sentence on every card; the footnote below
  // already explains why, so the cards stay quiet until a model has written.
  const written = provenance !== null && provenance.model !== 'none';

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
              {written ? (
                <span className="cluster-cause">
                  <span className="cluster-cause-tag">hypothesis</span> {cluster.rootCause}
                </span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>

      {provenance ? (
        <p className="muted cluster-provenance">
          {provenance.model === 'none'
            ? 'Cluster membership is computed; labels are placeholders until the analysis is generated with a model.'
            : `Cluster membership is computed from the eval data. Labels, summaries and hypotheses were written by ${provenance.model}.`}
        </p>
      ) : null}
    </>
  );
}
