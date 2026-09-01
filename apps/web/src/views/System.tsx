import { useState } from 'react';

import { formatCount } from '@catchfly/core/labels.ts';

import { ApiError, fetchSystemStatus, readStoredAdminKey, storeAdminKey } from '../data/api.ts';

export function System() {
  const [adminKey, setAdminKey] = useState(readStoredAdminKey);
  const [health, setHealth] = useState<Awaited<ReturnType<typeof fetchSystemStatus>> | null>(null);
  const [error, setError] = useState('');
  async function inspect(): Promise<void> {
    setError('');
    try { storeAdminKey(adminKey); setHealth(await fetchSystemStatus(adminKey)); }
    catch (cause) { setError(cause instanceof ApiError ? cause.message : String(cause)); }
  }
  return <div className="stack"><section className="panel"><div className="panel-head"><div><h2>Installation</h2><p className="muted">Runtime, storage and database readiness for this Catchfly deployment.</p></div></div><div className="panel-body">
    <label className="field field-grow"><span>Installation admin key</span><input type="password" value={adminKey} onChange={(event) => setAdminKey(event.target.value)} /></label>
    <button type="button" className="btn" disabled={!adminKey} onClick={() => void inspect()}>Inspect system</button>
    {health ? <dl className="stat-list system-list"><div><dt>Status</dt><dd>{health.status}</dd></div><div><dt>Catchfly</dt><dd>{health.runtime.version} on {health.runtime.node}</dd></div><div><dt>Database size</dt><dd>{(health.database.bytes / 1024 / 1024).toFixed(1)} MB</dd></div><div><dt>Latest migration</dt><dd><code>{health.database.latestMigration ?? 'Unknown'}</code></dd></div><div><dt>Projects</dt><dd>{health.counts.projects}</dd></div><div><dt>Measured sessions</dt><dd>{formatCount(health.counts.sessions)}</dd></div><div><dt>Telemetry events</dt><dd>{formatCount(health.counts.events)}</dd></div><div><dt>Rejected events</dt><dd>{formatCount(health.counts.rejectedEvents)}</dd></div></dl> : null}
    {error ? <p className="import-error">{error}</p> : null}<p className="table-note">Liveness: <code>/health/live</code> · Readiness: <code>/health/ready</code> · Run <code>npm run retention</code> on a schedule.</p>
  </div></section></div>;
}
