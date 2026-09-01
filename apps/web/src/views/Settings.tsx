import { useEffect, useState } from 'react';

import type { DataPolicy, ProjectEnvironment, RedactionRule } from '@catchfly/core/product-types.ts';

import { ApiError, fetchDataPolicy, fetchEnvironments, readStoredAdminKey, saveDataPolicy, storeAdminKey } from '../data/api.ts';
import { useCatchflyStore } from '../state/store.ts';
import { projectInfo } from '../data/projects.ts';

export function Settings() {
  const projectId = useCatchflyStore((state) => state.projectId);
  const account = useCatchflyStore((state) => state.account);
  const readOnlyDemo = projectInfo(projectId)?.dataOrigin === 'synthetic';
  const needsAdminKey = account === null;
  const [environments, setEnvironments] = useState<ProjectEnvironment[]>([]);
  const [environmentId, setEnvironmentId] = useState('production');
  const [policy, setPolicy] = useState<DataPolicy | null>(null);
  const [rules, setRules] = useState('[]');
  const [adminKey, setAdminKey] = useState(readStoredAdminKey);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    void fetchEnvironments(projectId).then((entries) => {
      setEnvironments(entries);
      setEnvironmentId((current) => entries.some((entry) => entry.id === current) ? current : (entries[0]?.id ?? ''));
    }).catch((cause) => setError(String(cause)));
  }, [projectId]);

  useEffect(() => {
    if (!environmentId) return;
    void fetchDataPolicy(projectId, environmentId).then((next) => {
      setPolicy(next);
      setRules(JSON.stringify(next.redactionRules, null, 2));
    }).catch((cause) => setError(String(cause)));
  }, [projectId, environmentId]);

  async function save(): Promise<void> {
    setError(''); setMessage('');
    try {
      const redactionRules = JSON.parse(rules) as RedactionRule[];
      if (adminKey) storeAdminKey(adminKey);
      const next = await saveDataPolicy({
        projectId, environmentId, adminKey,
        policy: { redactionRules, samplingRate: policy?.samplingRate ?? 1, retentionDays: policy?.retentionDays ?? 30 },
      });
      setPolicy(next); setMessage('Data policy saved. New events use it immediately.');
    } catch (cause) { setError(cause instanceof ApiError ? cause.message : String(cause)); }
  }

  return <div className="stack"><section className="panel"><div className="panel-head"><div><h2>Data policy</h2><p className="muted">Server-side rules are applied before telemetry reaches storage.</p></div></div><div className="panel-body">
    {readOnlyDemo ? <p className="empty-good">The synthetic Investigation Lab is read-only. Its policy is visible for reference.</p> : null}
    <div className="form-row">
      <label className="field"><span>Environment</span><select value={environmentId} onChange={(event) => setEnvironmentId(event.target.value)}>{environments.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></label>
      <label className="field"><span>Sampling rate</span><input disabled={readOnlyDemo} type="number" min="0" max="1" step="0.01" value={policy?.samplingRate ?? 1} onChange={(event) => setPolicy((current) => current ? { ...current, samplingRate: Number(event.target.value) } : current)} /></label>
      <label className="field"><span>Retention days</span><input disabled={readOnlyDemo} type="number" min="1" value={policy?.retentionDays ?? 30} onChange={(event) => setPolicy((current) => current ? { ...current, retentionDays: Number(event.target.value) } : current)} /></label>
    </div>
    <label className="field field-grow"><span>Redaction rules</span><textarea className="policy-editor" readOnly={readOnlyDemo} value={rules} onChange={(event) => setRules(event.target.value)} spellCheck={false} /></label>
    <p className="table-note">Paths start at <code>payload</code>. Supported actions: <code>remove</code>, <code>mask</code>, <code>hash</code> and <code>truncate</code>.</p>
    {!readOnlyDemo && needsAdminKey ? <label className="field field-grow"><span>Project or installation admin key</span><input type="password" value={adminKey} onChange={(event) => setAdminKey(event.target.value)} /></label> : null}
    {!readOnlyDemo ? <button type="button" className="btn" disabled={!policy || (needsAdminKey && !adminKey)} onClick={() => void save()}>Save data policy</button> : null}
    {message ? <p className="import-done">{message}</p> : null}{error ? <p className="import-error">{error}</p> : null}
  </div></section></div>;
}
