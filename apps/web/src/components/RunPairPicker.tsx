import { formatCount, formatPercent } from '@catchfly/core/labels.ts';
import type { RunSummary } from '@catchfly/core/queries.ts';

import { shortDate } from './dates.ts';
import { StatusMark, type StatusKind } from './StatusMark.tsx';
import '../styles/release-comparison.css';

const attemptsOf = (run: RunSummary): number =>
  run.metrics.passCount + run.metrics.failCount + run.metrics.errorCount;

function RunChoice({
  role,
  run,
  runs,
  disabledId,
  status,
  statusLabel,
  plate,
  onChange,
}: {
  role: 'Baseline' | 'Candidate';
  run: RunSummary;
  runs: RunSummary[];
  disabledId: string;
  status: StatusKind;
  statusLabel: string;
  plate: string;
  onChange: (runId: string) => void;
}) {
  return (
    <article className={`release-choice run-choice release-choice-${role.toLowerCase()}`}>
      <div
        className="release-choice-plate"
        style={{ backgroundImage: `url(/brand/cards/${plate}.webp)` }}
      >
        <StatusMark kind={status} detail={`${role} — ${statusLabel}`} size={16} />
      </div>

      <div className="release-choice-body">
        <div className="release-choice-top">
          <label className="release-choice-select">
            <span className="sr-only">{role} run</span>
            <select value={run.runId} onChange={(event) => onChange(event.target.value)}>
              {runs.map((entry) => (
                <option
                  key={entry.runId}
                  value={entry.runId}
                  title={entry.runId}
                  disabled={entry.runId === disabledId}
                >
                  {entry.appVersionLabel} · {entry.model}
                </option>
              ))}
            </select>
          </label>
        </div>

        <span className="release-choice-meta muted" title={run.runId}>
          {run.runId} · {shortDate(run.timestamp, true)}
        </span>

        <dl className="release-choice-stats">
          <div>
            <dt>Success</dt>
            <dd>{formatPercent(run.metrics.successRate)}</dd>
          </div>
          <div>
            <dt>Attempts</dt>
            <dd>{formatCount(attemptsOf(run))}</dd>
          </div>
          <div>
            <dt>Cases</dt>
            <dd>{formatCount(run.metrics.testCount)}</dd>
          </div>
          {run.metrics.avgLatencyMs !== undefined ? (
            <div>
              <dt>Latency</dt>
              <dd>{formatCount(Math.round(run.metrics.avgLatencyMs))} ms</dd>
            </div>
          ) : null}
        </dl>
      </div>
    </article>
  );
}

export function RunPairPicker({
  baseline,
  candidate,
  runs,
  candidateStatus,
  candidateLabel,
  onChange,
}: {
  baseline: RunSummary;
  candidate: RunSummary;
  runs: RunSummary[];
  candidateStatus: StatusKind;
  candidateLabel: string;
  onChange: (pair: { baselineRunId: string; candidateRunId: string }) => void;
}) {
  const candidatePlate =
    candidateStatus === 'regression'
      ? 'card-blush'
      : candidateStatus === 'recovery'
        ? 'card-sage'
        : 'card-fern';

  return (
    <div className="release-pair" aria-label="Eval runs being compared">
      <RunChoice
        role="Baseline"
        run={baseline}
        runs={runs}
        disabledId={candidate.runId}
        status="control"
        statusLabel="Reference"
        plate="card-fern"
        onChange={(baselineRunId) => onChange({ baselineRunId, candidateRunId: candidate.runId })}
      />

      <div className="release-pair-arrow" aria-hidden="true">
        <span>→</span>
        <small>compared with</small>
      </div>

      <RunChoice
        role="Candidate"
        run={candidate}
        runs={runs}
        disabledId={baseline.runId}
        status={candidateStatus}
        statusLabel={candidateLabel}
        plate={candidatePlate}
        onChange={(candidateRunId) => onChange({ baselineRunId: baseline.runId, candidateRunId })}
      />
    </div>
  );
}
