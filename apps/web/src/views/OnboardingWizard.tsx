import { useEffect, useState } from 'react';

import {
  fetchSessions,
  fetchSourceHealth,
  provisionWorkspace,
  type ProvisionedWorkspace,
} from '../data/api.ts';
import { InstallSnippet } from '../components/InstallSnippet.tsx';

type Stage = 'setup' | 'provisioning' | 'waiting' | 'connected' | 'failed';

const POLL_MS = 4000;
const STALL_MS = 60_000;
const STORAGE_KEY = 'catchfly.onboarding';
const EXAMPLE_URL = 'https://github.com/amichalski2/catchfly-dev/tree/main/examples/webmcp-vite';

const readSaved = (): ProvisionedWorkspace | null => {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as ProvisionedWorkspace) : null;
  } catch {
    return null;
  }
};

const save = (workspace: ProvisionedWorkspace | null): void => {
  try {
    if (workspace) window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(workspace));
    else window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    return;
  }
};

const openProject = (projectId: string, view: string) => {
  save(null);
  window.location.hash = `#/p/${projectId}/${view}`;
  window.location.reload();
};

const parseOrigin = (value: string): string => {
  const parsed = new URL(value.trim());
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error();
  return parsed.origin;
};

export function OnboardingWizard({ onClose }: { onClose?: () => void } = {}) {
  const [workspace, setWorkspace] = useState<ProvisionedWorkspace | null>(readSaved);
  const [stage, setStage] = useState<Stage>(() => (readSaved() ? 'waiting' : 'setup'));
  const [keySeen, setKeySeen] = useState(false);
  const [stalled, setStalled] = useState(false);
  const [firstSessionId, setFirstSessionId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [appUrl, setAppUrl] = useState('');
  const [additionalOrigins, setAdditionalOrigins] = useState('');
  const [proxyTelemetry, setProxyTelemetry] = useState(false);

  const provision = (): void => {
    setError('');
    let allowedOrigins: string[] | undefined;
    if (!proxyTelemetry) {
      try {
        const extras = additionalOrigins
          .split(/[\s,]+/)
          .map((entry) => entry.trim())
          .filter(Boolean)
          .map(parseOrigin);
        allowedOrigins = [...new Set([parseOrigin(appUrl), ...extras])];
      } catch {
        setError(
          'Enter full http(s) URLs, for example https://app.example.com and http://localhost:5173.',
        );
        return;
      }
    }
    setStage('provisioning');
    provisionWorkspace({ allowedOrigins })
      .then((provisioned) => {
        save(provisioned);
        setWorkspace(provisioned);
        setStalled(false);
        setStage('waiting');
      })
      .catch((cause) => {
        setError(cause instanceof Error ? cause.message : String(cause));
        setStage('failed');
      });
  };

  useEffect(() => {
    if (stage !== 'waiting' || !workspace) return;
    const timer = window.setInterval(() => {
      Promise.all([
        fetchSourceHealth(workspace.project.id),
        fetchSessions(workspace.project.id, {}, null, 1),
      ])
        .then(([health, sessions]) => {
          const environments = health.environments ?? [];
          if (sessions.sessions.length > 0) {
            setFirstSessionId(sessions.sessions[0]?.id ?? null);
            setStage('connected');
            return;
          }
          if (environments.some((entry) => entry.lastBatchAt)) setKeySeen(true);
          if (environments.some((entry) => entry.rejectedEvents > 0)) {
            setError(
              'Catchfly received a batch but rejected at least one event. Check the [Catchfly] error in your app console; deployment metadata and the allowed origin are the usual causes.',
            );
          }
        })
        .catch(() => {
          // The poll retries on its own cadence; a blip is not a failure.
        });
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [stage, workspace]);

  useEffect(() => {
    if (stage !== 'waiting') return;
    const timer = window.setTimeout(() => setStalled(true), STALL_MS);
    return () => window.clearTimeout(timer);
  }, [stage]);

  if (stage === 'setup') {
    return (
      <div className="onboarding-shell">
        <section className="onboarding-card wizard-card wizard-card-intro">
          <img src="/brand/catchfly-lockup.png" alt="Catchfly" className="onboarding-logo" />
          <p className="eyebrow">First project</p>
          <h1>Where does your WebMCP app run?</h1>
          <p className="muted">
            One field. Catchfly creates a project, a production environment and a browser key
            locked to this origin.
          </p>
          <div className="wizard-setup">
            <label className="field">
              <span>App URL</span>
              <input
                autoFocus
                type="url"
                value={appUrl}
                placeholder="https://app.example.com"
                disabled={proxyTelemetry}
                onChange={(event) => setAppUrl(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') provision();
                }}
              />
            </label>
            {error ? <p className="import-error">{error}</p> : null}
            <button
              type="button"
              className="btn"
              disabled={!proxyTelemetry && !appUrl.trim()}
              onClick={provision}
            >
              Create my workspace
            </button>
            <details className="wizard-advanced">
              <summary>Advanced: more origins, or a backend proxy</summary>
              <label className="field">
                <span>Other allowed origins</span>
                <input
                  type="text"
                  value={additionalOrigins}
                  placeholder="http://localhost:5173, https://preview.example.com"
                  disabled={proxyTelemetry}
                  onChange={(event) => setAdditionalOrigins(event.target.value)}
                />
              </label>
              <label className="signin-remember">
                <input
                  type="checkbox"
                  checked={proxyTelemetry}
                  onChange={(event) => setProxyTelemetry(event.target.checked)}
                />
                My backend will proxy telemetry, no browser key needed
              </label>
            </details>
          </div>
          {onClose ? (
            <button type="button" className="linkish wizard-skip" onClick={onClose}>
              Not yet. Explore the demo first
            </button>
          ) : null}
        </section>
      </div>
    );
  }

  if (stage === 'provisioning' || stage === 'failed') {
    return (
      <div className="onboarding-shell">
        <section className="onboarding-card">
          <img src="/brand/catchfly-lockup.png" alt="Catchfly" className="onboarding-logo" />
          {stage === 'failed' ? (
            <>
              <h1>Could not create your workspace</h1>
              <p className="import-error">{error}</p>
              <button type="button" className="btn" onClick={() => setStage('setup')}>
                Try again
              </button>
            </>
          ) : (
            <>
              <p className="eyebrow">Setting up</p>
              <h1>Creating your first project…</h1>
              <p className="muted">Workspace, production environment and an ingest key.</p>
            </>
          )}
        </section>
      </div>
    );
  }

  if (!workspace) return null;
  const { project, ingestKey } = workspace;
  const endpoint = window.location.origin;

  const sdkSnippet = `import { Catchfly, instrumentWebMCP } from '@catchfly/sdk';

const catchfly = new Catchfly({
  endpoint: '${endpoint}',
  projectId: '${project.id}',
  environmentId: '${workspace.environmentId}',
  apiKey: import.meta.env.VITE_CATCHFLY_INGEST_KEY,
  deployment: {
    id: import.meta.env.VITE_CATCHFLY_DEPLOYMENT_ID,
    appVersionId: import.meta.env.VITE_CATCHFLY_APP_VERSION,
  },
  onError: (error) => console.error('[Catchfly]', error),
});

instrumentWebMCP(catchfly);`;

  const envSnippet = ingestKey
    ? `VITE_CATCHFLY_INGEST_KEY=${ingestKey.secret}
VITE_CATCHFLY_DEPLOYMENT_ID=hackathon-local
VITE_CATCHFLY_APP_VERSION=v1`
    : '';

  const proxySnippet = `app.post('/catchfly-proxy/v1/projects/${project.id}/events', (req, res) =>
  forward(req, res, '${endpoint}/api/v1/projects/${project.id}/events', {
    authorization: \`Bearer \${process.env.CATCHFLY_API_KEY}\`,
  }),
);`;

  if (stage === 'connected') {
    return (
      <div className="onboarding-shell">
        <section className="onboarding-card">
          <img src="/brand/catchfly-lockup.png" alt="Catchfly" className="onboarding-logo" />
          <p className="eyebrow">Connected</p>
          <h1>Your first events just arrived</h1>
          <p className="muted">
            {project.name} is receiving telemetry. Open the first session to see what the agent
            actually did.
          </p>
          <div className="wizard-actions">
            <button
              type="button"
              className="btn"
              onClick={() =>
                openProject(
                  project.id,
                  firstSessionId ? `sessions/${encodeURIComponent(firstSessionId)}` : 'sessions',
                )
              }
            >
              View your first session
            </button>
            <button
              type="button"
              className="btn btn-quiet"
              onClick={() => openProject(project.id, 'overview')}
            >
              Open the dashboard
            </button>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="onboarding-shell">
      <section className="onboarding-card wizard-card">
        <img src="/brand/catchfly-lockup.png" alt="Catchfly" className="onboarding-logo" />
        <p className="eyebrow">{project.name}</p>
        <h1>Add Catchfly to your WebMCP app</h1>
        <p className="muted">
          Two lines of setup: configure the client, then let the instrumentation wrap every tool
          registered after it. Tool calls flow in automatically; task outcomes stay unknown unless
          your app reports them with the manual session API.
        </p>

        <InstallSnippet label="Install the SDK" code="npm install @catchfly/sdk" />
        {envSnippet ? <InstallSnippet label="Add the publishable ingest key" code={envSnippet} /> : null}
        <InstallSnippet label="Wire it into your app" code={sdkSnippet} />
        {ingestKey ? (
          <p className="muted wizard-key-note">
            This publishable key is shown only once. It can write telemetry and nothing else;
            mint and revoke keys later under Sources.
          </p>
        ) : null}

        <details className="wizard-advanced">
          <summary>Advanced: keep the key on your server</summary>
          <p className="muted">
            A browser-only app can ship this ingest-scoped key. If you have a backend, proxy the
            events through it instead and keep the key out of client code:
          </p>
          <InstallSnippet code={proxySnippet} />
        </details>

        <div className="wizard-waiting">
          <img
            className="wizard-mark"
            src="/brand/status-active.webp"
            alt=""
            width={20}
            height={20}
            aria-hidden="true"
          />
          {keySeen ? 'Key seen — waiting for the first event…' : 'Waiting for the first event…'}
        </div>
        {error ? <p className="import-error">{error}</p> : null}
        <p className="muted wizard-key-note">
          Open your app in a WebMCP-capable browser and invoke one of its tools. Catchfly marks the
          connection ready only after it can build the first complete session.
        </p>
        {stalled && !keySeen ? (
          <div className="wizard-checklist">
            <strong>Nothing has arrived yet. Three things to check:</strong>
            <ol>
              <li>
                The browser you opened your app in supports WebMCP: Chrome Canary or Dev 150+, or
                the built-in browser of the ChatGPT desktop app. Then call one tool.
              </li>
              <li>
                Your app console shows no <code>[Catchfly]</code> errors. A rejected batch names the
                field that failed.
              </li>
              <li>
                The page runs on the origin you entered. Add more origins under Sources if your
                app lives elsewhere.
              </li>
            </ol>
            <a href={EXAMPLE_URL} target="_blank" rel="noreferrer">
              Compare with the working example integration
            </a>
          </div>
        ) : null}
        {stalled && keySeen ? (
          <p className="muted wizard-key-note">
            Batches reach Catchfly, but no session has completed. A session closes when the tool
            call finishes and the SDK flushes, so give it a moment or trigger one more tool call.
          </p>
        ) : null}

        <button
          type="button"
          className="linkish wizard-skip"
          onClick={() => openProject(project.id, 'sources')}
        >
          I’ll do this later — open Sources
        </button>
      </section>
    </div>
  );
}
