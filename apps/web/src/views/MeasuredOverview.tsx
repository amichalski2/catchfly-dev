import { useEffect, useState } from 'react';

import type { IncidentRecord, OperationalFinding, ProjectOperationalOverview } from '@catchfly/core/product-types.ts';
import { formatCount } from '@catchfly/core/labels.ts';

import { StatTile } from '../components/figures.tsx';
import {
  ApiError,
  createIncident,
  fetchIncidents,
  fetchProjectOverview,
  readStoredAdminKey,
  storeAdminKey,
  updateIncident,
} from '../data/api.ts';
import { useCatchflyStore } from '../state/store.ts';

const percent = (value: number | null): string => value === null ? 'Not measured' : `${(value * 100).toFixed(1)}%`;

const freshness = (value: string | null): string => {
  if (!value) return 'Never';
  const minutes = Math.floor((Date.now() - Date.parse(value)) / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
};

export function MeasuredOverview() {
  const projectId = useCatchflyStore((state) => state.projectId);
  const account = useCatchflyStore((state) => state.account);
  const setView = useCatchflyStore((state) => state.setView);
  const needsAdminKey = account === null;
  const [data, setData] = useState<ProjectOperationalOverview | null>(null);
  const [incidents, setIncidents] = useState<IncidentRecord[]>([]);
  const [adminKey, setAdminKey] = useState(readStoredAdminKey);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    void Promise.all([fetchProjectOverview(projectId), fetchIncidents(projectId)])
      .then(([overview, records]) => { setData(overview); setIncidents(records); })
      .catch((cause) => setError(cause instanceof ApiError ? cause.message : String(cause)));
  }, [projectId]);

  async function promote(finding: OperationalFinding): Promise<void> {
    setBusyId(finding.id); setError('');
    try {
      if (adminKey) storeAdminKey(adminKey);
      const incident = await createIncident({ projectId, finding, adminKey });
      setIncidents((current) => [incident, ...current]);
    } catch (cause) { setError(cause instanceof ApiError ? cause.message : String(cause)); }
    finally { setBusyId(null); }
  }

  async function changeStatus(incident: IncidentRecord, status: IncidentRecord['status']): Promise<void> {
    setBusyId(incident.id); setError('');
    try {
      if (adminKey) storeAdminKey(adminKey);
      const updated = await updateIncident({
        projectId,
        incidentId: incident.id,
        status,
        adminKey,
        ...(status === 'resolved' ? { resolution: 'Resolved from the Catchfly overview.' } : {}),
      });
      setIncidents((current) => current.map((entry) => entry.id === updated.id ? updated : entry));
    } catch (cause) { setError(cause instanceof ApiError ? cause.message : String(cause)); }
    finally { setBusyId(null); }
  }

  if (error && !data) return <section className="panel"><div className="panel-body boot-error">Could not load project overview: {error}</div></section>;
  if (!data) return <section className="panel"><div className="panel-body muted">Loading project health…</div></section>;

  const activeIncidents = incidents.filter((incident) => incident.status !== 'resolved');

  return <div className="stack measured-overview">
    <section className="panel panel-hero"><div className="panel-body">
      <div className="overview-kicker"><div><span className="eyebrow">Production data</span><h2>{data.sessions.total === 0 ? 'Connect your first trace' : `${formatCount(data.sessions.total)} sessions observed`}</h2><p className="muted">Last telemetry: {freshness(data.telemetry.lastEventAt)}</p></div><button type="button" className="btn" onClick={() => setView(data.sessions.total === 0 ? 'sources' : 'sessions', 'human')}>{data.sessions.total === 0 ? 'Connect a source' : 'View sessions'}</button></div>
      <div className="tiles overview-tiles">
        <StatTile label="Outcome coverage" value={percent(data.sessions.outcomeCoverage)} footnote={`${formatCount(data.sessions.unknown)} unknown outcomes`} />
        <StatTile label="Task success" value={data.sessions.measuredTaskSuccessRate === null ? null : percent(data.sessions.measuredTaskSuccessRate)} unmeasuredNote="No sessions carry a measured outcome yet." footnote="among measured sessions" />
        <StatTile label="Tool execution" value={data.calls.executionSuccessRate === null ? null : percent(data.calls.executionSuccessRate)} unmeasuredNote="No completed tool calls yet." footnote={`${formatCount(data.calls.total)} calls`} />
        <StatTile label="Latest eval" value={data.evals.latestSuccessRate === null ? null : percent(data.evals.latestSuccessRate)} unmeasuredNote="Waiting for the first CI eval run." footnote={`${data.evals.runs} runs`} />
      </div>
    </div></section>

    <section className="panel"><div className="panel-head"><div><h2>What deserves attention</h2><p className="muted">Deterministic signals from telemetry and eval history.</p></div></div><div className="panel-body">
      {data.findings.length === 0 ? <p className="empty-good">No current findings. Data is arriving and the measured signals are within their initial thresholds.</p> : <ul className="finding-list">{data.findings.map((finding) => {
        const existing = activeIncidents.find((incident) => incident.findingId === finding.id);
        return <li key={finding.id} className={`finding-item finding-${finding.severity}`}><span className="pill">{finding.kind}</span><div className="finding-copy"><strong>{finding.title}</strong><p className="muted">{finding.summary}</p></div>{existing ? <span className="pill pill-warn">{existing.status}</span> : <button type="button" className="btn btn-quiet" disabled={(needsAdminKey && !adminKey) || busyId !== null} onClick={() => void promote(finding)}>{busyId === finding.id ? 'Creating…' : 'Create incident'}</button>}</li>;
      })}</ul>}
      {needsAdminKey && (data.findings.length > 0 || activeIncidents.length > 0) ? <label className="field finding-admin-key"><span>Project or installation admin key</span><input type="password" value={adminKey} onChange={(event) => setAdminKey(event.target.value)} /></label> : null}
      {error ? <p className="import-error">{error}</p> : null}
    </div></section>

    {activeIncidents.length > 0 ? <section className="panel"><div className="panel-head"><div><h2>Active incidents</h2><p className="muted">Human-owned follow-up created from measured evidence.</p></div></div><div className="panel-body"><ul className="finding-list">{activeIncidents.map((incident) => <li className={`finding-item finding-${incident.severity}`} key={incident.id}><span className="pill pill-warn">{incident.status}</span><div className="finding-copy"><strong>{incident.title}</strong><p className="muted">Opened {freshness(incident.createdAt)} · <code>{incident.id}</code></p></div>{incident.status === 'open' ? <button type="button" className="btn btn-quiet" disabled={(needsAdminKey && !adminKey) || busyId !== null} onClick={() => void changeStatus(incident, 'investigating')}>Investigate</button> : null}<button type="button" className="btn btn-quiet" disabled={(needsAdminKey && !adminKey) || busyId !== null} onClick={() => void changeStatus(incident, 'resolved')}>{busyId === incident.id ? 'Saving…' : 'Resolve'}</button></li>)}</ul></div></section> : null}

    <div className="split"><section className="panel"><div className="panel-head"><div><h2>Telemetry</h2></div><button type="button" className="btn btn-quiet" onClick={() => setView('sources', 'human')}>Connection</button></div><div className="panel-body"><dl className="stat-list"><div><dt>Accepted events</dt><dd>{formatCount(data.telemetry.acceptedEvents)}</dd></div><div><dt>Rejected events</dt><dd>{formatCount(data.telemetry.rejectedEvents)}</dd></div><div><dt>Unknown outcomes</dt><dd>{formatCount(data.sessions.unknown)}</dd></div></dl></div></section>
      <section className="panel"><div className="panel-head"><div><h2>Evals</h2></div><button type="button" className="btn btn-quiet" onClick={() => setView('cases', 'human')}>Open evals</button></div><div className="panel-body"><dl className="stat-list"><div><dt>Runs</dt><dd>{data.evals.runs}</dd></div><div><dt>Latest run</dt><dd><code>{data.evals.latestRunId ?? 'None'}</code></dd></div><div><dt>Success delta</dt><dd>{data.evals.successRateDelta === null ? 'Not comparable' : `${data.evals.successRateDelta >= 0 ? '+' : ''}${(data.evals.successRateDelta * 100).toFixed(1)} pts`}</dd></div></dl></div></section></div>
  </div>;
}
