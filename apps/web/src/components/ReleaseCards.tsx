import type { IncidentSummary, IncidentTimelinePoint } from '@catchfly/core/types.ts';

import { DeltaBadge } from './figures.tsx';
import { StatusMark } from './StatusMark.tsx';

type Kind = IncidentTimelinePoint['kind'];

const PLATE: Record<Kind, string> = {
  control: 'card-fern',
  regression: 'card-blush',
  decoy: 'card-cosmos',
  recovery: 'card-sage',
};

const REGRESSION_PLATES = ['card-blush', 'card-cherry'];

const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
const points = (value: number) => `${(Math.abs(value) * 100).toFixed(1)} pts`;

function plateFor(point: IncidentTimelinePoint): string {
  if (point.kind !== 'regression') return PLATE[point.kind];
  const seed = [...point.scenarioId].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return REGRESSION_PLATES[seed % REGRESSION_PLATES.length];
}

type Props = {
  timeline: IncidentTimelinePoint[];
  incidents: IncidentSummary[];
  count?: number;
  opening: string | null;
  onOpen: (incident: IncidentSummary) => void;
};

export function ReleaseCards({ timeline, incidents, count = 3, opening, onOpen }: Props) {
  const start = Math.max(timeline.length - count, 0);
  const latest = timeline.slice(start);

  return (
    <div className="release-cards">
      {latest.map((point, offset) => {
        const index = start + offset;
        const previous = index > 0 ? timeline[index - 1] : null;
        const incident = incidents.find((entry) => entry.id === point.scenarioId) ?? null;
        const versus = previous ? `release ${String(index).padStart(2, '0')}` : undefined;

        return (
          <article key={point.appVersionId} className="release-card">
            <div
              className="release-plate"
              style={{ backgroundImage: `url(/brand/cards/${plateFor(point)}.webp)` }}
            >
              <StatusMark kind={point.kind} detail={point.scenarioLabel} />
            </div>

            <div className="release-card-body">
              <h3 className="release-title">{incident?.title ?? 'Clean control'}</h3>

              <div className="release-figures">
                <div className="release-figure">
                  <span className="release-figure-label">Eval success</span>
                  <strong className="release-figure-value tabular">
                    {percent(point.evalSuccessRate)}
                  </strong>
                  {previous ? (
                    <DeltaBadge
                      value={point.evalSuccessRate - previous.evalSuccessRate}
                      format={points}
                      versus={versus}
                    />
                  ) : null}
                </div>
                <div className="release-figure">
                  <span className="release-figure-label">Production failures</span>
                  <strong className="release-figure-value tabular">
                    {percent(point.productionFailureRate)}
                  </strong>
                  {previous ? (
                    <DeltaBadge
                      value={point.productionFailureRate - previous.productionFailureRate}
                      format={points}
                      direction="up-bad"
                      versus={versus}
                    />
                  ) : null}
                </div>
              </div>

              <button
                type="button"
                className="btn btn-quiet release-open"
                disabled={!incident || opening !== null}
                title={incident ? undefined : 'A control release has no regression to open.'}
                onClick={() => incident && onOpen(incident)}
              >
                {incident && opening === incident.id ? 'Loading…' : 'Open evidence'}
              </button>
            </div>
          </article>
        );
      })}
    </div>
  );
}
