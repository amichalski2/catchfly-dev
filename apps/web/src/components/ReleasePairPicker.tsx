import type { DeploymentRollup } from '@catchfly/core/session-types.ts';

import { StatusMark, type StatusKind } from './StatusMark.tsx';

const percent = (value: number) => `${(value * 100).toFixed(1)}%`;

const failureRate = (deployment: DeploymentRollup): number =>
  deployment.sessionCount === 0 ? 0 : deployment.failedCount / deployment.sessionCount;

const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });

function ReleaseChoice({
  role,
  deployment,
  deployments,
  disabledId,
  status,
  plate,
  onChange,
}: {
  role: 'Baseline' | 'Candidate';
  deployment: DeploymentRollup;
  deployments: DeploymentRollup[];
  disabledId: string;
  status: StatusKind;
  plate: string;
  onChange: (id: string) => void;
}) {
  const statusLabel =
    role === 'Baseline'
      ? 'Reference'
      : status === 'regression'
        ? 'Regression'
        : status === 'recovery'
          ? 'Recovery'
          : 'No material change';

  return (
    <article className={`release-choice release-choice-${role.toLowerCase()}`}>
      <div
        className="release-choice-plate"
        style={{ backgroundImage: `url(/brand/cards/${plate}.webp)` }}
      >
        <StatusMark kind={status} detail={`${role} — ${statusLabel}`} size={16} />
      </div>

      <div className="release-choice-body">
        <div className="release-choice-top">
          <label className="release-choice-select">
            <span className="sr-only">{role} release</span>
            <select value={deployment.id} onChange={(event) => onChange(event.target.value)}>
              {deployments.map((entry) => (
                <option key={entry.id} value={entry.id} disabled={entry.id === disabledId}>
                  {entry.appVersionId} · {shortDate(entry.deployedAt)}
                </option>
              ))}
            </select>
          </label>
        </div>

        <span className="release-choice-meta muted">
          {deployment.id} · {deployment.environment}
        </span>

        <dl className="release-choice-stats">
          <div>
            <dt>Failure rate</dt>
            <dd>{percent(failureRate(deployment))}</dd>
          </div>
          <div>
            <dt>Sessions</dt>
            <dd>{deployment.sessionCount.toLocaleString('en-US')}</dd>
          </div>
        </dl>
      </div>
    </article>
  );
}

export function ReleasePairPicker({
  baseline,
  candidate,
  deployments,
  candidateStatus,
  onChange,
}: {
  baseline: DeploymentRollup;
  candidate: DeploymentRollup;
  deployments: DeploymentRollup[];
  candidateStatus: StatusKind;
  onChange: (pair: { baselineDeploymentId: string; candidateDeploymentId: string }) => void;
}) {
  const candidatePlate =
    candidateStatus === 'regression'
      ? 'card-blush'
      : candidateStatus === 'recovery'
        ? 'card-sage'
        : 'card-fern';

  return (
    <div className="release-pair" aria-label="Releases being compared">
      <ReleaseChoice
        role="Baseline"
        deployment={baseline}
        deployments={deployments}
        disabledId={candidate.id}
        status="control"
        plate="card-fern"
        onChange={(baselineDeploymentId) =>
          onChange({ baselineDeploymentId, candidateDeploymentId: candidate.id })
        }
      />

      <div className="release-pair-arrow" aria-hidden="true">
        <span>→</span>
        <small>compared with</small>
      </div>

      <ReleaseChoice
        role="Candidate"
        deployment={candidate}
        deployments={deployments}
        disabledId={baseline.id}
        status={candidateStatus}
        plate={candidatePlate}
        onChange={(candidateDeploymentId) =>
          onChange({ baselineDeploymentId: baseline.id, candidateDeploymentId })
        }
      />
    </div>
  );
}
