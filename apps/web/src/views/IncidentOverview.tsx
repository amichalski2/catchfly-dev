import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  evalsCorroborate,
  headlineIncidents,
  incidentDeploymentPair,
  productionCorroborates,
} from '@catchfly/core/incidents.ts';
import { categoryLabel, formatCount, formatPoints } from '@catchfly/core/labels.ts';
import type {
  IncidentOverview as IncidentOverviewData,
  IncidentSummary,
  IncidentTimelinePoint,
} from '@catchfly/core/types.ts';

import { HeroFigure, StatTile } from '../components/figures.tsx';
import { ReleaseCards } from '../components/ReleaseCards.tsx';
import { ReleaseHistory } from '../components/ReleaseHistory.tsx';
import { StatusMark } from '../components/StatusMark.tsx';
import { TopFindings } from '../components/TopFindings.tsx';
import { fetchIncidentOverview } from '../data/api.ts';
import { activateComparison } from '../data/load.ts';
import { useCatchflyStore } from '../state/store.ts';

const points = (value: number) => formatPoints(value * 100);

function Corroboration({ incident }: { incident: IncidentSummary }) {
  const models = incident.modelCount > 0 && incident.modelAgreement === incident.modelCount;
  const checks = [
    { key: 'evals', label: 'Evals', met: evalsCorroborate(incident) },
    { key: 'production', label: 'Production', met: productionCorroborates(incident) },
    {
      key: 'models',
      label: `Models ${incident.modelAgreement}/${incident.modelCount}`,
      met: models,
    },
  ];
  return (
    <span className="corroboration">
      {checks.map((check) => (
        <span key={check.key} className={`corr ${check.met ? 'corr-met' : 'corr-unmet'}`}>
          <span aria-hidden="true">{check.met ? '✓' : '·'}</span> {check.label}
        </span>
      ))}
    </span>
  );
}

export function IncidentOverview() {
  const projectId = useCatchflyStore((state) => state.projectId);
  const setReleaseComparison = useCatchflyStore((state) => state.setReleaseComparison);
  const [request, setRequest] = useState<{
    projectId: string;
    data: IncidentOverviewData | null;
    error: string | null;
  }>({ projectId: '', data: null, error: null });
  const [opening, setOpening] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void fetchIncidentOverview(projectId)
      .then((value) => {
        if (active) setRequest({ projectId, data: value, error: null });
      })
      .catch((reason: unknown) => {
        if (active) {
          setRequest({
            projectId,
            data: null,
            error: reason instanceof Error ? reason.message : String(reason),
          });
        }
      });
    return () => {
      active = false;
    };
  }, [projectId]);

  const data = request.projectId === projectId ? request.data : null;
  const error = request.projectId === projectId ? request.error : null;
  const falseLead = useMemo(() => data?.incidents.find((entry) => entry.kind === 'decoy'), [data]);
  const incidentFor = useCallback(
    (point: IncidentTimelinePoint) => data?.incidents.find((entry) => entry.id === point.scenarioId),
    [data],
  );

  if (error) {
    return <section className="panel"><div className="panel-body boot-error">Could not load incident summary: {error}</div></section>;
  }
  if (!data) {
    return <section className="panel"><div className="panel-body muted">Loading incident summary…</div></section>;
  }

  const open = async (incident: IncidentSummary) => {
    if (!incident.baselineRunId || !incident.candidateRunId) return;
    setOpening(incident.id);
    try {
      await activateComparison(
        { baselineRunId: incident.baselineRunId, candidateRunId: incident.candidateRunId },
        'human',
      );
    } finally {
      setOpening(null);
    }
  };

  const productionPair = (incident: IncidentSummary) => incidentDeploymentPair(incident, data.timeline);

  return (
    <div className="stack incident-overview">
      <section className="panel panel-hero">
        <div className="panel-body hero-row">
          <HeroFigure
            label="Incident patterns"
            value={String(data.incidentPatterns)}
            tone="regressed"
            caption="corroborated in both halves"
          />
          <div className="tiles">
            <StatTile label="Affected tools" value={String(data.affectedTools)} footnote="root-cause surface" />
            <StatTile label="Eval attempts" value={formatCount(data.evalAttempts)} footnote="across every model" />
            <StatTile label="Production sessions" value={formatCount(data.productionSessions)} footnote="same release history" />
            <StatTile
              label="False lead isolated"
              value={falseLead ? `${falseLead.latencyMultiplier.toFixed(1)}× latency` : '—'}
              footnote={falseLead ? 'without quality loss' : 'no false lead in this history'}
            />
          </div>
        </div>
        <ul className="mark-legend" aria-label="What the marks mean">
          <li><StatusMark kind="regression" size={14} /> Confirmed regression</li>
          <li><StatusMark kind="recovery" size={14} /> Recovered</li>
          <li><StatusMark kind="decoy" size={14} /> False lead</li>
          <li><StatusMark kind="control" size={14} /> Clean control</li>
        </ul>
      </section>

      <div className="release-row">
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Latest releases</h2>
              <p className="muted">The newest three, each against the release before it.</p>
            </div>
            <span className="muted release-count">
              {data.timeline.length} releases shipped
            </span>
          </div>
          <div className="panel-body">
            <ReleaseCards
              timeline={data.timeline}
              incidents={data.incidents}
              opening={opening}
              onOpen={(incident) => void open(incident)}
              productionFor={productionPair}
              onOpenProduction={(pair) => setReleaseComparison(pair, 'human')}
            />
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Release history</h2>
              <p className="muted">Eval success and production failures across every release.</p>
            </div>
          </div>
          <div className="panel-body">
            <ReleaseHistory
              timeline={data.timeline}
              shape="tall"
              opening={opening}
              selectable={(point) => incidentFor(point) !== undefined}
              onSelect={(point) => {
                const incident = incidentFor(point);
                if (incident) void open(incident);
              }}
            />
            <p className="chart-note">
              <span className="muted">Select a release with an incident to open its evidence.</span>
            </p>
          </div>
        </section>
      </div>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>What deserves attention</h2>
            <p className="muted">Findings ranked by how far evals and production moved together.</p>
          </div>
        </div>
        <div className="panel-body">
        <TopFindings
          incidents={headlineIncidents(data)}
          timeline={data.timeline}
          opening={opening}
          onOpen={(incident) => void open(incident)}
          productionFor={productionPair}
          onOpenProduction={(pair) => setReleaseComparison(pair, 'human')}
        />

        <details className="findings-more">
          <summary>All {data.incidents.length} findings</summary>
          <div className="incident-table-wrap">
              <table className="table incident-table">
                <thead>
                  <tr><th>Finding</th><th>Tools / failure</th><th>Eval impact</th><th>Production</th><th>Corroboration</th><th>Evidence</th><th>Status</th></tr>
                </thead>
                <tbody>
                  {data.incidents.map((incident) => {
                    const production = productionPair(incident);
                    return (
                      <tr key={incident.id}>
                        <th>
                          <span className="incident-title">{incident.title}</span>
                          <span className="row-sub">{incident.summary} · observed {incident.occurrences}×</span>
                        </th>
                        <td>
                          <span className="incident-tools">{incident.tools.length ? incident.tools.join(', ') : 'multiple tools'}</span>
                          <span className="row-sub">{categoryLabel(incident.failureCategory ?? undefined)}</span>
                        </td>
                        <td className={evalsCorroborate(incident) ? 'col-strong' : ''}>
                          {points(incident.evalSuccessRateDelta)}
                        </td>
                        <td>
                          {incident.kind === 'decoy'
                            ? `${incident.latencyMultiplier.toFixed(1)}× latency`
                            : `${points(incident.productionFailureRateDelta)} failure rate`}
                        </td>
                        <td>
                          <Corroboration incident={incident} />
                          <span className="row-sub">{incident.model} is the representative run</span>
                        </td>
                        <td>
                          <span className="incident-evidence">
                            <button className="linkish incident-open" type="button" onClick={() => void open(incident)} disabled={opening !== null}>
                              {opening === incident.id ? 'Loading…' : 'Evals'}
                            </button>
                            <button
                              className="linkish incident-open"
                              type="button"
                              disabled={!production}
                              title={production ? undefined : 'This scenario has no deployment to compare.'}
                              onClick={() => production && setReleaseComparison(production, 'human')}
                            >
                              Production
                            </button>
                          </span>
                        </td>
                        <td><StatusMark kind={incident.kind} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
          </div>
        </details>
        </div>
      </section>
    </div>
  );
}
