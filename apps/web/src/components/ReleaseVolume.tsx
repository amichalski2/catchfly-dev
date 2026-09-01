import { useState } from 'react';

import { formatCount, formatPercent } from '@catchfly/core/labels.ts';

import { shortDate } from './dates.ts';
import type { ReleasePoint } from './release-points.ts';

export function ReleaseVolume({
  points,
  selectedId,
  onSelect,
}: {
  points: ReleasePoint[];
  selectedId: string | undefined;
  onSelect: (deploymentId: string | undefined) => void;
}) {
  const [hovered, setHovered] = useState<string | null>(null);

  if (points.length === 0) return null;

  const ceiling = Math.max(...points.map((point) => point.deployment.failedCount), 1);
  const active = points.find((point) => point.deployment.id === hovered) ?? null;

  return (
    <div className="volume">
      <div className="volume-bars">
        {points.map((point) => {
          const { deployment } = point;
          const selected = deployment.id === selectedId;
          const failed = (deployment.failedCount / ceiling) * 100;

          return (
            <button
              key={deployment.id}
              type="button"
              className={`volume-bar${selected ? ' is-selected' : ''}`}
              aria-pressed={selected}
              aria-label={`${deployment.appVersionId} — ${deployment.failedCount} of ${deployment.sessionCount} sessions failed`}
              onMouseEnter={() => setHovered(deployment.id)}
              onMouseLeave={() =>
                setHovered((current) => (current === deployment.id ? null : current))
              }
              onFocus={() => setHovered(deployment.id)}
              onBlur={() => setHovered((current) => (current === deployment.id ? null : current))}
              onClick={() => onSelect(selected ? undefined : deployment.id)}
            >
              <span className="volume-track" />
              <span className="volume-failed" style={{ height: `${failed}%` }} />
            </button>
          );
        })}
      </div>

      <p className="volume-legend">
        {active ? (
          <>
            <strong>{active.deployment.appVersionId}</strong>{' '}
            <span className="tabular">{formatCount(active.deployment.failedCount)}</span>{' '}
            of{' '}
            <span className="tabular">{formatCount(active.deployment.sessionCount)}</span>{' '}
            failed · {formatPercent(active.failureRate)} ·{' '}
            <span className="muted">{shortDate(active.deployment.deployedAt)}</span>
          </>
        ) : (
          <span className="muted">
            Failed sessions per release, oldest first · tallest is{' '}
            <span className="tabular">{formatCount(ceiling)}</span>
          </span>
        )}
      </p>
    </div>
  );
}
