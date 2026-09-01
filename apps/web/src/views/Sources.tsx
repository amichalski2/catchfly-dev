import { useEffect, useMemo, useState } from 'react';

import { getDb } from '@catchfly/core/db.ts';
import { formatCount } from '@catchfly/core/labels.ts';
import type {
  ApiKeyScope,
  EnvironmentKind,
  ProjectApiKey,
  ProjectEnvironment,
  SourceHealth,
  TelemetryEvent,
} from '@catchfly/core/product-types.ts';

import {
  ApiError,
  createEnvironment,
  createProject,
  createProjectKey,
  fetchEnvironments,
  fetchProjectKeys,
  fetchSourceHealth,
  readStoredAdminKey,
  revokeProjectKey,
  sendTelemetry,
  storeAdminKey,
  storeEvalKey,
} from '../data/api.ts';
import { projectInfo } from '../data/projects.ts';
import { useCatchflyStore } from '../state/store.ts';

const age = (timestamp: string | null): string => {
  if (!timestamp) return 'Never';
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(timestamp)) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
};

type KeyKind = 'ingest' | 'evals';

export function Sources() {
  const projectId = useCatchflyStore((state) => state.projectId);
  const account = useCatchflyStore((state) => state.account);
  useCatchflyStore((state) => state.datasetVersion);
  const readOnlyDemo = projectInfo(projectId)?.dataOrigin === 'synthetic';
  const [health, setHealth] = useState<SourceHealth | null>(null);
  const [environments, setEnvironments] = useState<ProjectEnvironment[]>([]);
  const [keys, setKeys] = useState<ProjectApiKey[]>([]);
  const [environmentId, setEnvironmentId] = useState('production');
  const [adminKey, setAdminKey] = useState(readStoredAdminKey);
  const [secrets, setSecrets] = useState<Partial<Record<KeyKind, string>>>({});
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<KeyKind | 'test' | 'keys' | null>(null);
  const [newEnvironmentName, setNewEnvironmentName] = useState('');
  const [newEnvironmentKind, setNewEnvironmentKind] = useState<EnvironmentKind>('staging');
  const [busyKeyId, setBusyKeyId] = useState<string | null>(null);
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectId, setNewProjectId] = useState('');
  const [appOrigin, setAppOrigin] = useState('');
  const needsAdminKey = account === null;

  const rememberAdminKey = () => {
    if (adminKey) storeAdminKey(adminKey);
  };

  const refresh = async () => {
    const [nextHealth, nextEnvironments] = await Promise.all([
      fetchSourceHealth(projectId),
      fetchEnvironments(projectId),
    ]);
    setHealth(nextHealth);
    setEnvironments(nextEnvironments);
    setEnvironmentId((current) =>
      nextEnvironments.some((entry) => entry.id === current)
        ? current
        : (nextEnvironments[0]?.id ?? ''),
    );
  };

  useEffect(() => {
    void Promise.all([fetchSourceHealth(projectId), fetchEnvironments(projectId)])
      .then(([nextHealth, nextEnvironments]) => {
        setHealth(nextHealth);
        setEnvironments(nextEnvironments);
        setEnvironmentId((current) =>
          nextEnvironments.some((entry) => entry.id === current)
            ? current
            : (nextEnvironments[0]?.id ?? ''),
        );
      })
      .catch((cause) => setError(String(cause)));
  }, [projectId]);

  const environment = environments.find((entry) => entry.id === environmentId);
  const environmentHealth = health?.environments.find(
    (entry) => entry.environment.id === environmentId,
  );
  const runCount = getDb().dataset.runs.length;
  const productionConnected = Boolean(environmentHealth?.lastEventAt);
  const evalsConnected = runCount > 0;
  const endpoint = window.location.origin;

  const sdkSnippet = useMemo(
    () => `import { Catchfly, instrumentWebMCP } from '@catchfly/sdk';

const catchfly = new Catchfly({
  endpoint: '${endpoint}',
  projectId: '${projectId}',
  environmentId: '${environmentId}',
  apiKey: import.meta.env.VITE_CATCHFLY_INGEST_KEY,
  deployment: {
    id: import.meta.env.VITE_CATCHFLY_DEPLOYMENT_ID,
    appVersionId: import.meta.env.VITE_CATCHFLY_APP_VERSION
  },
  onError: (error) => console.error('[Catchfly]', error)
});

instrumentWebMCP(catchfly);`,
    [endpoint, environmentId, projectId],
  );

  const evalCommand = useMemo(
    () => `npx @catchfly/cli eval run \\
  --url https://your-app.example \\
  --evals evals.json \\
  --endpoint ${endpoint} \\
  --project ${projectId} \\
  --version $GIT_SHA \\
  --key $CATCHFLY_EVAL_KEY`,
    [endpoint, projectId],
  );

  const fail = (cause: unknown) => {
    setError(cause instanceof ApiError ? cause.message : String(cause));
  };

  async function mint(kind: KeyKind): Promise<void> {
    setBusy(kind);
    setError('');
    setStatus('');
    try {
      rememberAdminKey();
      const scopes: ApiKeyScope[] = kind === 'ingest' ? ['ingest'] : ['evals:write'];
      let allowedOrigins: string[] | undefined;
      if (kind === 'ingest' && appOrigin.trim()) {
        try {
          const parsed = new URL(appOrigin.trim());
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error();
          allowedOrigins = [parsed.origin];
        } catch {
          throw new Error('App origin must be a full http(s) URL, for example https://app.example.com.');
        }
      }
      const created = await createProjectKey({
        projectId,
        environmentId,
        name: kind === 'ingest' ? `${environmentId} runtime` : `${environmentId} CI`,
        scopes,
        adminKey,
        ...(allowedOrigins ? { allowedOrigins } : {}),
      });
      setSecrets((current) => ({ ...current, [kind]: created.secret }));
      if (kind === 'evals') storeEvalKey(created.secret);
      setKeys((current) => [created.key, ...current]);
      setStatus(`${kind === 'ingest' ? 'Runtime' : 'CI'} key created. Copy it now.`);
      await refresh();
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(null);
    }
  }

  async function sendTest(): Promise<void> {
    const key = secrets.ingest;
    if (!key) return;
    setBusy('test');
    setError('');
    const sessionId = `ses_test_${crypto.randomUUID()}`;
    const occurredAt = new Date().toISOString();
    const base = { schemaVersion: '1' as const, sessionId, occurredAt };
    const events: TelemetryEvent[] = [
      {
        ...base,
        eventId: `evt_${crypto.randomUUID()}`,
        sequence: 0,
        type: 'session.started',
        payload: {
          deploymentId: `setup-${environmentId}`,
          appVersionId: 'setup-v1',
          appVersionLabel: 'Connection check',
          intent: 'Verify the Catchfly connection',
          model: 'integration-check',
        },
      },
      {
        ...base,
        eventId: `evt_${crypto.randomUUID()}`,
        sequence: 1,
        type: 'tool.called',
        payload: {
          callId: 'setup-call',
          toolName: 'catchfly_connection_check',
          arguments: { source: 'settings' },
        },
      },
      {
        ...base,
        eventId: `evt_${crypto.randomUUID()}`,
        sequence: 2,
        type: 'tool.completed',
        payload: {
          callId: 'setup-call',
          toolName: 'catchfly_connection_check',
          result: { connected: true },
          durationMs: 1,
        },
      },
      {
        ...base,
        eventId: `evt_${crypto.randomUUID()}`,
        sequence: 3,
        type: 'task.completed',
        payload: {},
      },
    ];
    try {
      const result = await sendTelemetry({ projectId, environmentId, key, events });
      setStatus(`Connected. Catchfly accepted ${result.accepted} test events.`);
      await refresh();
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(null);
    }
  }

  async function loadKeys(): Promise<void> {
    setBusy('keys');
    setError('');
    try {
      rememberAdminKey();
      setKeys(await fetchProjectKeys(projectId, adminKey));
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(null);
    }
  }

  async function addEnvironment(): Promise<void> {
    const id = newEnvironmentName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    if (id.length < 2) {
      setError('Use an environment name with at least two letters or numbers.');
      return;
    }
    setError('');
    try {
      rememberAdminKey();
      const created = await createEnvironment({
        projectId,
        id,
        name: newEnvironmentName.trim(),
        kind: newEnvironmentKind,
        adminKey,
      });
      setEnvironments((current) => [...current, created]);
      setEnvironmentId(created.id);
      setNewEnvironmentName('');
      setStatus(`${created.name} added.`);
      await refresh();
    } catch (cause) {
      fail(cause);
    }
  }

  async function revoke(keyId: string): Promise<void> {
    setBusyKeyId(keyId);
    setError('');
    try {
      rememberAdminKey();
      await revokeProjectKey(projectId, keyId, adminKey);
      setKeys((current) =>
        current.map((key) =>
          key.id === keyId ? { ...key, revokedAt: new Date().toISOString() } : key,
        ),
      );
      setStatus('Key revoked.');
      await refresh();
    } catch (cause) {
      fail(cause);
    } finally {
      setBusyKeyId(null);
    }
  }

  async function addMeasuredProject(): Promise<void> {
    setError('');
    try {
      rememberAdminKey();
      await createProject({ id: newProjectId, name: newProjectName.trim(), adminKey });
      window.location.hash = `#/p/${encodeURIComponent(newProjectId)}/sources`;
      window.location.reload();
    } catch (cause) {
      fail(cause);
    }
  }

  if (readOnlyDemo) {
    return (
      <section className="panel connection-start">
        <div className="panel-body connection-start-body">
          <p className="eyebrow">Your data</p>
          <h2>Connect your WebMCP app</h2>
          <p className="muted">
            The Investigation Lab stays untouched. Your traces and eval runs live in a separate
            project.
          </p>
          <div className="connection-project-form">
            <label className="field field-grow">
              <span>Project name</span>
              <input
                autoFocus
                value={newProjectName}
                placeholder="Checkout agent"
                onChange={(event) => {
                  const name = event.target.value;
                  setNewProjectName(name);
                  setNewProjectId(
                    name
                      .toLowerCase()
                      .trim()
                      .replace(/[^a-z0-9]+/g, '-')
                      .replace(/^-|-$/g, '')
                      .slice(0, 63),
                  );
                }}
              />
            </label>
            <label className="field field-grow">
              <span>Project ID</span>
              <input value={newProjectId} onChange={(event) => setNewProjectId(event.target.value)} />
            </label>
            {needsAdminKey ? (
              <label className="field field-grow">
                <span>Installation admin key</span>
                <input
                  type="password"
                  value={adminKey}
                  placeholder="CATCHFLY_ADMIN_KEY"
                  onChange={(event) => setAdminKey(event.target.value)}
                />
              </label>
            ) : null}
          </div>
          <button
            type="button"
            className="btn"
            disabled={(needsAdminKey && !adminKey) || !newProjectName.trim() || newProjectId.length < 2}
            onClick={() => void addMeasuredProject()}
          >
            Create project
          </button>
          {error ? <p className="import-error">{error}</p> : null}
        </div>
      </section>
    );
  }

  return (
    <div className="stack connection-page">
      <section className="connection-status" aria-label="Connection status">
        <div>
          <img
            className="connection-mark"
            src={productionConnected ? '/brand/status-active.webp' : '/brand/status-unsupported.webp'}
            alt=""
            width={18}
            height={18}
            aria-hidden="true"
          />
          <span>Production</span>
          <strong>{productionConnected ? `Live · ${age(environmentHealth?.lastEventAt ?? null)}` : 'Waiting for data'}</strong>
        </div>
        <div>
          <img
            className="connection-mark"
            src={evalsConnected ? '/brand/status-active.webp' : '/brand/status-unsupported.webp'}
            alt=""
            width={18}
            height={18}
            aria-hidden="true"
          />
          <span>Evals</span>
          <strong>{evalsConnected ? `${formatCount(runCount)} runs` : 'Waiting for CI'}</strong>
        </div>
      </section>

      <section className="panel connection-access">
        <div className="panel-body form-row">
          <label className="field">
            <span>Environment</span>
            <select value={environmentId} onChange={(event) => setEnvironmentId(event.target.value)}>
              {environments.map((entry) => (
                <option key={entry.id} value={entry.id}>{entry.name}</option>
              ))}
            </select>
          </label>
          {needsAdminKey ? (
            <label className="field field-grow">
              <span>Admin key</span>
              <input
                type="password"
                value={adminKey}
                placeholder="Project or installation admin key"
                onChange={(event) => setAdminKey(event.target.value)}
              />
            </label>
          ) : null}
        </div>
      </section>

      <div className="connection-channels">
        <section className="panel connection-channel">
          <div className="panel-head">
            <div>
              <p className="eyebrow">Production</p>
              <h2>Production connection</h2>
              <p className="muted">Install the SDK once. New sessions appear as they happen.</p>
            </div>
            <span className={`pill ${productionConnected ? 'pill-pass' : 'pill-warn'}`}>
              {productionConnected ? 'Connected' : 'Not connected'}
            </span>
          </div>
          <div className="panel-body connection-channel-body">
            <pre className="code-block"><code>{sdkSnippet}</code></pre>
            <label className="field field-grow">
              <span>WebMCP app origin</span>
              <input
                type="url"
                value={appOrigin}
                placeholder="https://app.example.com"
                onChange={(event) => setAppOrigin(event.target.value)}
              />
            </label>
            <p className="table-note">
              Browser requests from other origins will be refused. Leave this empty only when your backend proxies telemetry.
            </p>
            {secrets.ingest ? (
              <label className="field field-grow">
                <span>Runtime key, shown once</span>
                <input className="secret-output" readOnly value={secrets.ingest} onFocus={(event) => event.currentTarget.select()} />
              </label>
            ) : null}
            <div className="connection-actions">
              <button type="button" className="btn" disabled={(needsAdminKey && !adminKey) || !environmentId || busy !== null} onClick={() => void mint('ingest')}>
                {busy === 'ingest' ? 'Creating…' : 'Create runtime key'}
              </button>
              {secrets.ingest ? (
                <button type="button" className="btn btn-quiet" disabled={busy !== null} onClick={() => void sendTest()}>
                  {busy === 'test' ? 'Sending…' : 'Test connection'}
                </button>
              ) : null}
            </div>
          </div>
        </section>

        <section className="panel connection-channel">
          <div className="panel-head">
            <div>
              <p className="eyebrow">CI</p>
              <h2>Eval connection</h2>
              <p className="muted">One command runs the WebMCP suite and sends the result here.</p>
            </div>
            <span className={`pill ${evalsConnected ? 'pill-pass' : 'pill-warn'}`}>
              {evalsConnected ? 'Connected' : 'Not connected'}
            </span>
          </div>
          <div className="panel-body connection-channel-body">
            <pre className="code-block"><code>{evalCommand}</code></pre>
            {secrets.evals ? (
              <label className="field field-grow">
                <span>CI key, shown once</span>
                <input className="secret-output" readOnly value={secrets.evals} onFocus={(event) => event.currentTarget.select()} />
              </label>
            ) : null}
            <div className="connection-actions">
              <button type="button" className="btn" disabled={(needsAdminKey && !adminKey) || !environmentId || busy !== null} onClick={() => void mint('evals')}>
                {busy === 'evals' ? 'Creating…' : 'Create CI key'}
              </button>
            </div>
          </div>
        </section>
      </div>

      {status ? <p className="import-done">{status}</p> : null}
      {error ? <p className="import-error">{error}</p> : null}

      <details className="panel settings-advanced">
        <summary>Environments and keys</summary>
        <div className="panel-body stack">
          <section>
            <h3>Add an environment</h3>
            <div className="form-row">
              <label className="field field-grow">
                <span>Name</span>
                <input value={newEnvironmentName} placeholder="Staging" onChange={(event) => setNewEnvironmentName(event.target.value)} />
              </label>
              <label className="field">
                <span>Kind</span>
                <select value={newEnvironmentKind} onChange={(event) => setNewEnvironmentKind(event.target.value as EnvironmentKind)}>
                  <option value="development">Development</option>
                  <option value="staging">Staging</option>
                  <option value="production">Production</option>
                </select>
              </label>
              <button type="button" className="btn btn-quiet" disabled={(needsAdminKey && !adminKey) || !newEnvironmentName.trim()} onClick={() => void addEnvironment()}>
                Add environment
              </button>
            </div>
          </section>
          <section>
            <div className="advanced-head">
              <div><h3>Project keys</h3><p className="muted">Secrets are shown only when a key is created.</p></div>
              <button type="button" className="btn btn-quiet" disabled={(needsAdminKey && !adminKey) || busy !== null} onClick={() => void loadKeys()}>
                {busy === 'keys' ? 'Loading…' : 'Load keys'}
              </button>
            </div>
            {keys.length > 0 ? (
              <div className="table-wrap source-key-list">
                <table>
                  <thead><tr><th>Name</th><th>Environment</th><th>Scopes</th><th>Origins</th><th>Last used</th><th>Status</th><th /></tr></thead>
                  <tbody>
                    {keys.map((key) => (
                      <tr key={key.id}>
                        <td>{key.name}</td><td><code>{key.environmentId}</code></td><td>{key.scopes.join(', ')}</td>
                        <td>{key.allowedOrigins?.join(', ') ?? 'Server / any origin'}</td>
                        <td>{key.lastUsedAt ? age(key.lastUsedAt) : 'Never'}</td><td>{key.revokedAt ? 'Revoked' : 'Active'}</td>
                        <td>{key.revokedAt ? null : <button type="button" className="btn btn-quiet" disabled={busyKeyId !== null} onClick={() => void revoke(key.id)}>{busyKeyId === key.id ? 'Revoking…' : 'Revoke'}</button>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </section>
        </div>
      </details>
      <p className="table-note connection-footnote">
        Selected environment: <strong>{environment?.name ?? environmentId}</strong>. Runtime keys belong in the app. CI keys belong in your build system.
      </p>
    </div>
  );
}
