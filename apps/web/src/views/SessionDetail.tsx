/**
 * Session detail — one production trace, and what to do about it.
 *
 * This is where the two halves of Catchfly meet. The trace shows what an agent
 * did on the deployed app; the tool name in each row leads to how that tool has
 * been behaving across releases; and the panel at the bottom turns the whole
 * thing into an eval case. A failure that gets read here and left here has
 * taught nobody anything.
 */

import { CATEGORY_LABELS } from '@catchfly/core/labels.ts';

import { CreateEvalPanel } from '../components/CreateEvalPanel.tsx';
import { SessionTrace } from '../components/SessionTrace.tsx';
import { useCatchflyStore } from '../state/store.ts';
import { useAgentTouch } from '../state/useAgentTouch.ts';
import { useDeployments, useSession } from '../state/useSessions.ts';

const SELECTION_ACTIONS = ['open_session'] as const;

export function SessionDetail() {
  const sessionId = useCatchflyStore((state) => state.selectedSessionId);
  const closeSession = useCatchflyStore((state) => state.closeSession);
  const openTool = useCatchflyStore((state) => state.openTool);
  const touch = useAgentTouch(SELECTION_ACTIONS);
  const entry = useSession(sessionId);
  const deployments = useDeployments();

  if (!sessionId) return <p className="muted">No session selected.</p>;
  if (entry === null || entry.status === 'loading') return <p className="muted">Loading session…</p>;
  if (entry.status === 'error') return <p className="import-error">{entry.message}</p>;

  const session = entry.value;
  const deployment =
    deployments?.status === 'ready'
      ? deployments.value.find((entry) => entry.id === session.deploymentId)
      : undefined;
  const errored = session.toolCalls.filter((call) => call.status === 'error').length;
  const duration = session.toolCalls.reduce((total, call) => total + call.durationMs, 0);

  return (
    <div className="stack">
      <section key={touch.key} className={`panel${touch.className}`}>
        <div className="panel-head">
          <div>
            <h2>{session.intent ?? 'Intent not captured'}</h2>
            <p className="muted">
              {session.id} · {new Date(session.startedAt).toISOString().replace('T', ' ').slice(0, 19)} UTC
            </p>
          </div>
          <button type="button" className="btn" onClick={() => closeSession('human')}>
            Back to sessions
          </button>
        </div>

        <div className="panel-body">
          <table className="table table-dense">
            <tbody>
              <tr>
                <th scope="row">Outcome</th>
                <td>
                  <span className={`pill pill-${session.outcome === 'completed' ? 'pass' : 'fail'}`}>
                    {session.outcome}
                  </span>
                  {session.failureCategory ? (
                    <span className="row-sub">{CATEGORY_LABELS[session.failureCategory]}</span>
                  ) : null}
                </td>
              </tr>
              <tr>
                <th scope="row">Deployment</th>
                <td>
                  {session.deploymentId}
                  {deployment ? <span className="row-sub">{deployment.appVersionId}</span> : null}
                </td>
              </tr>
              <tr>
                <th scope="row">Environment</th>
                <td>{session.environment}</td>
              </tr>
              <tr>
                <th scope="row">Agent</th>
                {/* The PRD is explicit that missing agent metadata must never be
                    dressed up as a fact. */}
                <td>
                  {session.model ?? <span className="muted">unknown — the client did not report it</span>}
                  {session.agent ? <span className="row-sub">{session.agent}</span> : null}
                </td>
              </tr>
              <tr>
                <th scope="row">Calls</th>
                <td className="tabular">
                  {session.toolCalls.length} in {(duration / 1000).toFixed(1)}s
                  {errored > 0 ? <span className="row-sub">{errored} rejected</span> : null}
                </td>
              </tr>
              {session.failureTool ? (
                <tr>
                  <th scope="row">Attributed to</th>
                  <td>
                    <button
                      type="button"
                      className="linkish"
                      onClick={() => openTool(session.failureTool!, 'human')}
                    >
                      <code>{session.failureTool}</code>
                    </button>
                    <span className="row-sub">open the tool profile to see how it behaves across releases</span>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>What the agent did</h2>
            <p className="muted">Every call, in order, with how long it took and what came back.</p>
          </div>
        </div>
        <div className="panel-body">
          <SessionTrace session={session} onOpenTool={(toolName) => openTool(toolName, 'human')} />
        </div>
      </section>

      <CreateEvalPanel session={session} />
    </div>
  );
}
