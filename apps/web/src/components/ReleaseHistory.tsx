import { useState } from 'react';

import type { IncidentTimelinePoint } from '@catchfly/core/types.ts';

const VIEW_W = 1000;
const PAD_L = 40;
const PAD_R = 132;

const GEOMETRY = {
  wide: {
    height: 196,
    facets: [
      { key: 'eval', title: 'Eval success', top: 16, height: 64, tone: 'fixed' },
      { key: 'production', title: 'Production failures', top: 118, height: 60, tone: 'regressed' },
    ],
  },
  tall: {
    height: 300,
    facets: [
      { key: 'eval', title: 'Eval success', top: 24, height: 98, tone: 'fixed' },
      { key: 'production', title: 'Production failures', top: 180, height: 92, tone: 'regressed' },
    ],
  },
} as const;

type FacetKey = (typeof GEOMETRY)['wide']['facets'][number]['key'];

const valueOf = (point: IncidentTimelinePoint, key: FacetKey) =>
  key === 'eval' ? point.evalSuccessRate : point.productionFailureRate;

const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
const tick = (value: number) => `${Math.round(value * 100)}%`;

const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

function scale(values: number[], top: number, height: number) {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const pad = (hi - lo || 0.02) * 0.28;
  const floor = lo - pad;
  const ceiling = hi + pad;
  return {
    floor,
    ceiling,
    y: (value: number) => top + height * (1 - (value - floor) / (ceiling - floor)),
  };
}

function smoothPath(xs: number[], ys: number[]): string {
  const n = ys.length;
  const dx = xs[1] - xs[0];
  const delta = ys.slice(0, -1).map((value, index) => (ys[index + 1] - value) / dx);
  const slopes = ys.map((_, index) => {
    if (index === 0) return delta[0];
    if (index === n - 1) return delta[n - 2];
    return delta[index - 1] * delta[index] <= 0 ? 0 : (delta[index - 1] + delta[index]) / 2;
  });

  for (let index = 0; index < n - 1; index += 1) {
    if (delta[index] === 0) {
      slopes[index] = 0;
      slopes[index + 1] = 0;
      continue;
    }
    const a = slopes[index] / delta[index];
    const b = slopes[index + 1] / delta[index];
    const magnitude = a * a + b * b;
    if (magnitude > 9) {
      const factor = 3 / Math.sqrt(magnitude);
      slopes[index] = factor * a * delta[index];
      slopes[index + 1] = factor * b * delta[index];
    }
  }

  let d = `M${xs[0]} ${ys[0]}`;
  for (let index = 0; index < n - 1; index += 1) {
    d += ` C${xs[index] + dx / 3} ${ys[index] + (slopes[index] * dx) / 3} ${xs[index + 1] - dx / 3} ${ys[index + 1] - (slopes[index + 1] * dx) / 3} ${xs[index + 1]} ${ys[index + 1]}`;
  }
  return d;
}

type Props = {
  timeline: IncidentTimelinePoint[];
  opening: string | null;
  onSelect: (point: IncidentTimelinePoint) => void;
  selectable: (point: IncidentTimelinePoint) => boolean;
  /** 'tall' fills a half-width panel, where the wide shape leaves dead space. */
  shape?: keyof typeof GEOMETRY;
};

export function ReleaseHistory({ timeline, opening, onSelect, selectable, shape = 'wide' }: Props) {
  const view = GEOMETRY[shape];
  const [hovered, setHovered] = useState<number | null>(null);
  const count = timeline.length;
  if (count < 2) return null;

  const step = (VIEW_W - PAD_L - PAD_R) / (count - 1);
  const x = (index: number) => PAD_L + index * step;
  const xs = timeline.map((_, index) => x(index));

  const controls = timeline.filter((point) => point.kind === 'control');

  const facets = view.facets.map((facet) => {
    const values = timeline.map((point) => valueOf(point, facet.key));
    const band = scale(values, facet.top, facet.height);
    const reference =
      controls.length === 0
        ? null
        : controls.reduce((sum, point) => sum + valueOf(point, facet.key), 0) / controls.length;
    return { ...facet, values, band, reference, path: smoothPath(xs, values.map(band.y)) };
  });

  const cycleStarts = timeline
    .map((point, index) => (point.kind === 'control' && index > 0 ? index : -1))
    .filter((index) => index > 0);

  const active = hovered === null ? null : timeline[hovered];
  const showTick = (index: number) =>
    index % 3 === 0 || index === count - 1 || index === hovered || cycleStarts.includes(index);

  return (
    <div className="rhist">
      <div className="rhist-plot">
        <svg
          viewBox={`0 0 ${VIEW_W} ${view.height}`}
          className="rhist-svg"
          role="img"
          aria-label="Eval success rate and production failure rate across every release"
        >
          {facets.map((facet) => (
            <g key={facet.key} className={`rhist-facet rhist-facet-${facet.tone}`}>
              {[facet.band.ceiling, (facet.band.ceiling + facet.band.floor) / 2, facet.band.floor].map(
                (value) => (
                  <g key={value}>
                    <line
                      className="rhist-grid"
                      x1={PAD_L - 8}
                      x2={VIEW_W - PAD_R + 8}
                      y1={facet.band.y(value)}
                      y2={facet.band.y(value)}
                    />
                    <text className="rhist-ytick" x={PAD_L - 14} y={facet.band.y(value) + 3}>
                      {tick(value)}
                    </text>
                  </g>
                ),
              )}

              {facet.reference === null ? null : (
                <line
                  className="rhist-reference"
                  x1={PAD_L - 8}
                  x2={VIEW_W - PAD_R + 8}
                  y1={facet.band.y(facet.reference)}
                  y2={facet.band.y(facet.reference)}
                />
              )}

              <path className="rhist-line" d={facet.path} />

              {hovered === null ? null : (
                <circle
                  className="rhist-dot"
                  cx={x(hovered)}
                  cy={facet.band.y(facet.values[hovered])}
                  r={3.5}
                />
              )}

              <text
                className="rhist-series"
                x={VIEW_W - PAD_R + 18}
                y={facet.band.y(facet.values[count - 1]) - 3}
              >
                {facet.title}
              </text>
              <text
                className="rhist-series-value"
                x={VIEW_W - PAD_R + 18}
                y={facet.band.y(facet.values[count - 1]) + 11}
              >
                {percent(facet.values[count - 1])}
              </text>
            </g>
          ))}

          {cycleStarts.map((index) => (
            <g key={`cycle-${index}`}>
              <line
                className="rhist-cycle"
                x1={x(index) - step / 2}
                x2={x(index) - step / 2}
                y1={8}
                y2={view.height - 6}
              />
              <text className="rhist-cycle-label" x={x(index) - step / 2 + 6} y={12}>
                cycle {cycleStarts.indexOf(index) + 2}
              </text>
            </g>
          ))}
        </svg>

        <div className="rhist-hits">
          {timeline.map((point, index) => {
            const enabled = selectable(point);
            return (
              <button
                key={point.appVersionId}
                type="button"
                className={`rhist-hit${hovered === index ? ' is-hovered' : ''}`}
                style={{ left: `${(x(index) / VIEW_W) * 100}%`, width: `${(step / VIEW_W) * 100}%` }}
                disabled={!enabled || opening !== null}
                aria-label={`Release ${String(index + 1).padStart(2, '0')} — ${point.appVersionLabel}`}
                onMouseEnter={() => setHovered(index)}
                onMouseLeave={() => setHovered((current) => (current === index ? null : current))}
                onFocus={() => setHovered(index)}
                onBlur={() => setHovered((current) => (current === index ? null : current))}
                onClick={() => enabled && onSelect(point)}
              />
            );
          })}
        </div>

        {active && hovered !== null ? (
          <div
            className="rhist-tip"
            role="tooltip"
            style={{
              left: `${(x(hovered) / VIEW_W) * 100}%`,
              transform: `translate(${hovered <= 2 ? '0%' : hovered >= count - 3 ? '-100%' : '-50%'}, -50%)`,
            }}
          >
            <strong>Release {String(hovered + 1).padStart(2, '0')}</strong>
            <span className="muted">{active.scenarioLabel}</span>
            <span>{percent(active.evalSuccessRate)} eval</span>
            <span>{percent(active.productionFailureRate)} prod</span>
            <span className="muted">
              {shortDate(active.releasedAt)} · {Math.round(active.avgToolLatencyMs)} ms
            </span>
          </div>
        ) : null}
      </div>

      <div className="rhist-axis">
        {timeline.map((point, index) =>
          showTick(index) ? (
            <span
              key={point.appVersionId}
              className={`rhist-tick${hovered === index ? ' is-hovered' : ''}`}
              style={{ left: `${(x(index) / VIEW_W) * 100}%` }}
            >
              {String(index + 1).padStart(2, '0')}
            </span>
          ) : null,
        )}
      </div>

    </div>
  );
}
