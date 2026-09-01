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

export type ProductionPair = { baselineDeploymentId: string; candidateDeploymentId: string };

type Props = {
  timeline: IncidentTimelinePoint[];
  incidents: IncidentSummary[];
  count?: number;
  opening: string | null;
  onOpen: (incident: IncidentSummary) => void;
  productionFor: (incident: IncidentSummary) => ProductionPair | null;
  onOpenProduction: (pair: ProductionPair) => void;
};

export function ReleaseCards({
  timeline,
  incidents,
  count = 3,
  opening,
  onOpen,
  productionFor,
  onOpenProduction,
}: Props) {
  const start = Math.max(timeline.length - count, 0);
  const latest = timeline.slice(start);

  return (
    <div className="release-cards">
      {latest.map((point, offset) => {
        const index = start + offset;
        const previous = index > 0 ? timeline[index - 1] : null;
        const incident = incidents.find((entry) => entry.id === point.scenarioId) ?? null;
        const versus = previous ? `release ${String(index).padStart(2, '0')}` : undefined;
        const production = incident ? productionFor(incident) : null;

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

              <div className="card-actions">
                <button
                  type="button"
                  className="btn btn-quiet release-open"
                  disabled={!incident || opening !== null}
                  title={incident ? 'Open the eval comparison behind this release' : 'A control release has no regression to open.'}
                  onClick={() => incident && onOpen(incident)}
                >
                  {incident && opening === incident.id ? 'Loading…' : 'Evals'}
                </button>
                <button
                  type="button"
                  className="btn btn-quiet release-open"
                  disabled={!production}
                  title={production ? 'Open the production comparison behind this release' : 'This release has no deployment to compare.'}
                  onClick={() => production && onOpenProduction(production)}
                >
                  Production
                </button>
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
}
