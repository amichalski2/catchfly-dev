import type { ReleaseFinding } from '../views/release-comparison-model.ts';

import { StatusMark, type StatusKind } from './StatusMark.tsx';

const MARK_FOR: Record<ReleaseFinding['tone'], StatusKind> = {
  regressed: 'regression',
  fixed: 'recovery',
  neutral: 'control',
};

export function ReleaseEvidence({
  findings,
  onOpen,
}: {
  findings: ReleaseFinding[];
  onOpen: (finding: ReleaseFinding) => void;
}) {
  if (findings.length === 0) {
    return (
      <div className="release-evidence-empty">
        <strong>No material change surfaced.</strong>
        <span className="muted">
          Failure mix, tool traffic and the manifest are stable for this release pair.
        </span>
      </div>
    );
  }

  return (
    <div className="release-evidence" aria-label="Evidence connecting the release to changed behavior">
      {findings.map((finding, index) => (
        <article key={finding.id} className={`release-evidence-step tone-${finding.tone}`}>
          <span className="release-evidence-index" aria-hidden="true">
            {String(index + 1).padStart(2, '0')}
          </span>

          <span className="release-evidence-mark">
            <StatusMark kind={MARK_FOR[finding.tone]} detail={finding.eyebrow} />
          </span>

          <div className="release-evidence-copy">
            <span className="release-evidence-eyebrow">{finding.eyebrow}</span>
            <h3 className="release-evidence-title">{finding.title}</h3>
            <p className="release-evidence-summary muted">{finding.summary}</p>
          </div>

          <dl className="release-evidence-metrics">
            {finding.metrics.map((metric) => (
              <div key={metric.label}>
                <dt>{metric.label}</dt>
                <dd className="tabular">{metric.value}</dd>
              </div>
            ))}
          </dl>

          <button
            type="button"
            className="release-evidence-open"
            onClick={() => onOpen(finding)}
          >
            <span className="sr-only">Open evidence for {finding.title}</span>
          </button>
        </article>
      ))}
    </div>
  );
}
