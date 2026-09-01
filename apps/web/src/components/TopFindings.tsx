import { categoryLabel, formatPoints } from '@catchfly/core/labels.ts';
import type { IncidentSummary, IncidentTimelinePoint } from '@catchfly/core/types.ts';

import { IncidentRecurrence } from './IncidentRecurrence.tsx';
import type { ProductionPair } from './ReleaseCards.tsx';
import { StatusMark } from './StatusMark.tsx';

/* Each finding gets the plate painted for it; a scenario without one falls back
   to a botanical plate rather than to another finding's picture. */
const ART: Record<string, string> = {
  selection: 'finding-selection',
  'removed-tool': 'finding-removed-tool',
  abandonment: 'finding-abandonment',
};

const FALLBACK = ['card-blush', 'card-cosmos', 'card-fern'];

const points = (value: number) => formatPoints(value * 100);

type Props = {
  incidents: IncidentSummary[];
  timeline: IncidentTimelinePoint[];
  opening: string | null;
  onOpen: (incident: IncidentSummary) => void;
  productionFor: (incident: IncidentSummary) => ProductionPair | null;
  onOpenProduction: (pair: ProductionPair) => void;
};

export function TopFindings({ incidents, timeline, opening, onOpen, productionFor, onOpenProduction }: Props) {
  if (incidents.length === 0) return null;


  return (
    <div className="findings">
      {incidents.map((incident, index) => {
        const production = productionFor(incident);
        return (
        <article key={incident.id} className="finding">
          <img
            className="finding-art"
            src={`/brand/cards/${ART[incident.id] ?? FALLBACK[index % FALLBACK.length]}.webp`}
            alt=""
            aria-hidden="true"
          />

          <div className="finding-head">
            <h3 className="finding-title">{incident.title}</h3>
            <StatusMark kind={incident.kind} detail={categoryLabel(incident.failureCategory ?? undefined)} />
          </div>

          <p className="finding-summary muted">{incident.summary}</p>

          <div className="finding-spark">
            <IncidentRecurrence timeline={timeline} scenarioId={incident.id} kind={incident.kind} />
          </div>

          <dl className="finding-figures">
            <div>
              <dt>Evals</dt>
              <dd className="tabular">{points(incident.evalSuccessRateDelta)}</dd>
            </div>
            <div>
              <dt>Production</dt>
              <dd className="tabular">
                {incident.kind === 'decoy'
                  ? `${incident.latencyMultiplier.toFixed(1)}× latency`
                  : points(incident.productionFailureRateDelta)}
              </dd>
            </div>
            <div>
              <dt>Models</dt>
              <dd className="tabular">
                {incident.modelAgreement}/{incident.modelCount}
              </dd>
            </div>
          </dl>

          <p className="finding-tools">
            {incident.tools.length ? incident.tools.join(', ') : 'multiple tools'}
            <span className="muted"> · observed {incident.occurrences}×</span>
          </p>

          <div className="card-actions finding-actions">
            <button
              type="button"
              className="linkish incident-open"
              disabled={opening !== null}
              onClick={() => onOpen(incident)}
            >
              {opening === incident.id ? 'Loading…' : 'Evals'}
            </button>
            <button
              type="button"
              className="linkish incident-open"
              disabled={!production}
              title={production ? undefined : 'This scenario has no deployment to compare.'}
              onClick={() => production && onOpenProduction(production)}
            >
              Production
            </button>
          </div>
        </article>
        );
      })}
    </div>
  );
}
