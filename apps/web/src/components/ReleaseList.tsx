import type { ReleasePoint } from './release-points.ts';

const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
const points = (value: number) => `${(Math.abs(value) * 100).toFixed(1)}`;

const ARROW: Record<string, string> = {
  regression: '▲',
  recovery: '▼',
  control: '±',
  decoy: '±',
};

const TONE: Record<string, string> = {
  regression: 'regressed',
  recovery: 'fixed',
  control: 'flat',
  decoy: 'flat',
};

function ReleaseRow({
  point,
  selected,
  onSelect,
}: {
  point: ReleasePoint;
  selected: boolean;
  onSelect: (deploymentId: string | undefined) => void;
}) {
  const { deployment } = point;

  return (
    <li>
      <button
        type="button"
        className={`release-line${selected ? ' is-selected' : ''}`}
        aria-pressed={selected}
        onClick={() => onSelect(selected ? undefined : deployment.id)}
      >
        <span className="release-line-name">{deployment.appVersionId}</span>
        <span className="release-line-rate tabular">{percent(point.failureRate)}</span>
        <span className={`release-line-delta tone-${TONE[point.status]}`}>
          {point.failureRateDelta === null ? (
            <span className="muted">first</span>
          ) : (
            <>
              <span aria-hidden="true">{ARROW[point.status]}</span>{' '}
              <span className="tabular">{points(point.failureRateDelta)}</span>
            </>
          )}
        </span>
      </button>
    </li>
  );
}

export function ReleaseList({
  points: releases,
  recent = 4,
  selectedId,
  onSelect,
}: {
  points: ReleasePoint[];
  recent?: number;
  selectedId: string | undefined;
  onSelect: (deploymentId: string | undefined) => void;
}) {
  const newest = [...releases].reverse();
  const head = newest.slice(0, recent);
  const rest = newest.slice(recent);

  return (
    <div className="release-lines">
      <div className="release-lines-head">
        <span>Release</span>
        <span className="col-right">Failed</span>
        <span className="col-right">vs prev</span>
      </div>

      <ul>
        {head.map((point) => (
          <ReleaseRow
            key={point.deployment.id}
            point={point}
            selected={point.deployment.id === selectedId}
            onSelect={onSelect}
          />
        ))}
      </ul>

      {rest.length > 0 ? (
        <details className="findings-more release-lines-more">
          <summary>{rest.length} older releases</summary>
          <ul>
            {rest.map((point) => (
              <ReleaseRow
                key={point.deployment.id}
                point={point}
                selected={point.deployment.id === selectedId}
                onSelect={onSelect}
              />
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
