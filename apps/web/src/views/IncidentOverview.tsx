import { useCallback, useEffect, useMemo, useState } from 'react';

import { categoryLabel } from '@catchfly/core/labels.ts';
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
import { useAgentTouch } from '../state/useAgentTouch.ts';

const points = (value: number) => `${value >= 0 ? '+' : '−'}${(Math.abs(value) * 100).toFixed(1)} pts`;

const EVAL_THRESHOLD = -0.01;
const PRODUCTION_THRESHOLD = 0.005;

function evalsConfirm(incident: IncidentSummary): boolean {
  return incident.kind === 'recovery'
    ? incident.evalSuccessRateDelta > -EVAL_THRESHOLD
    : incident.evalSuccessRateDelta < EVAL_THRESHOLD;
}

function productionConfirms(incident: IncidentSummary): boolean {
  return incident.kind === 'recovery'
    ? incident.productionFailureRateDelta < -PRODUCTION_THRESHOLD
    : incident.productionFailureRateDelta > PRODUCTION_THRESHOLD;
}

function Corroboration({ incident }: { incident: IncidentSummary }) {
  const models = incident.modelCount > 0 && incident.modelAgreement === incident.modelCount;
  const checks = [
    { key: 'evals', label: 'Evals', met: evalsConfirm(incident) },
    { key: 'production', label: 'Production', met: productionConfirms(incident) },
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

const INCIDENT_ACTIONS = ['set_comparison', 'set_release_comparison'] as const;

export function IncidentOverview() {
  const projectId = useCatchflyStore((state) => state.projectId);
  const setReleaseComparison = useCatchflyStore((state) => state.setReleaseComparison);
  const touch = useAgentTouch(INCIDENT_ACTIONS);
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

  const deploymentFor = (appVersionId: string): string | null =>
    data.timeline.find(
      (point: IncidentTimelinePoint) => point.appVersionId === appVersionId && point.deploymentId,
    )?.deploymentId ?? null;

  const productionPair = (incident: IncidentSummary) => {
    const baselineDeploymentId = deploymentFor(incident.baselineVersionId);
    const candidateDeploymentId = deploymentFor(incident.candidateVersionId);
    return baselineDeploymentId && candidateDeploymentId
      ? { baselineDeploymentId, candidateDeploymentId }
      : null;
  };

  return (
    <div className="stack incident-overview">
      <section key={touch.key} className={`panel panel-hero${touch.className}`}>
        <div className="panel-body hero-row">
          <HeroFigure
            label="Incident patterns"
            value={String(data.incidentPatterns)}
            tone="regressed"
            caption="corroborated in both halves"
          />
          <div className="tiles">
            <StatTile label="Affected tools" value={String(data.affectedTools)} footnote="root-cause surface" />
            <StatTile label="Eval attempts" value={data.evalAttempts.toLocaleString()} footnote="across every model" />
            <StatTile label="Production sessions" value={data.productionSessions.toLocaleString()} footnote="same release history" />
            <StatTile
              label="False lead isolated"
              value={falseLead ? `${falseLead.latencyMultiplier.toFixed(1)}× latency` : '—'}
              footnote="without quality loss"
            />
          </div>
        </div>
      </section>

      <div className="release-row">
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Latest releases</h2>
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
            />
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Release history</h2>
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
          </div>
        </section>
      </div>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>What deserves attention</h2>
          </div>
        </div>
        <div className="panel-body">
        <TopFindings
          incidents={data.incidents.slice(0, 3)}
          timeline={data.timeline}
          opening={opening}
          onOpen={(incident) => void open(incident)}
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
                        <td className={evalsConfirm(incident) ? 'col-strong' : ''}>
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
