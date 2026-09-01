/**
 * Sessions — what agents actually did on the deployed app.
 */

import { loadMoreSessions } from '@catchfly/core/sessions-db.ts';

import { toReleasePoints } from '../components/release-points.ts';
import { ReleaseList } from '../components/ReleaseList.tsx';
import { ReleaseVolume } from '../components/ReleaseVolume.tsx';
import { SessionFilterBar } from '../components/SessionFilterBar.tsx';
import { SessionStream } from '../components/SessionStream.tsx';
import { useCatchflyStore } from '../state/store.ts';
import { useAgentTouch } from '../state/useAgentTouch.ts';
import { useDeployments, useSessionList, useSessionsAvailable } from '../state/useSessions.ts';
import '../styles/sessions.css';

const SESSION_ACTIONS = ['set_session_filters', 'reset_session_filters', 'open_session'] as const;

const PAGE_SIZE = 50;

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;

export function Sessions() {
  const available = useSessionsAvailable();
  const filters = useCatchflyStore((state) => state.sessionFilters);
  const setSessionFilters = useCatchflyStore((state) => state.setSessionFilters);
  const openSession = useCatchflyStore((state) => state.openSession);
  const setView = useCatchflyStore((state) => state.setView);
  const touch = useAgentTouch(SESSION_ACTIONS);
  const deployments = useDeployments();
  const list = useSessionList(filters, PAGE_SIZE);

  if (!available) {
    return (
      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>No session data on this deployment</h2>
            <p className="muted">
              Sessions come from a database. The eval half of Catchfly works without one; this half does not.
            </p>
          </div>
        </div>
      </section>
    );
  }

  const rollups = deployments?.status === 'ready' ? deployments.value : [];
  const value = list?.status === 'ready' ? list.value : null;
  const releases = toReleasePoints(rollups);

  const totals = rollups.reduce(
    (sum, deployment) => ({
      sessions: sum.sessions + deployment.sessionCount,
      failed: sum.failed + deployment.failedCount,
      calls: sum.calls + deployment.toolCallCount,
      rejected: sum.rejected + deployment.errorCallCount,
    }),
    { sessions: 0, failed: 0, calls: 0, rejected: 0 },
  );

  const failureRate = totals.sessions === 0 ? 0 : totals.failed / totals.sessions;
  const rejectRate = totals.calls === 0 ? 0 : totals.rejected / totals.calls;
  const scoped = filters.deploymentId
    ? (rollups.find((entry) => entry.id === filters.deploymentId)?.appVersionId ?? null)
    : null;

  const select = (deploymentId: string | undefined) => setSessionFilters({ deploymentId }, 'human');

  return (
    <div className="sessions-view">
      <aside className="session-rail">
        <section className="panel">
          <div className="panel-body">
            <p className="rail-figure">
              <span className="eyebrow">Captured traffic</span>
              <strong className="tabular">{totals.sessions.toLocaleString('en-US')}</strong>
              <span className="muted">
                sessions across {releases.length} {releases.length === 1 ? 'release' : 'releases'}
              </span>
            </p>

            <dl className="rail-stats">
              <div>
                <dt>Failed sessions</dt>
                <dd className="tabular tone-regressed">{pct(failureRate)}</dd>
                <dd className="muted">{totals.failed.toLocaleString('en-US')} traces</dd>
              </div>
              <div>
                <dt>Tool calls</dt>
                <dd className="tabular">{totals.calls.toLocaleString('en-US')}</dd>
                <dd className="muted">{pct(rejectRate)} rejected</dd>
              </div>
            </dl>
          </div>
        </section>

        {releases.length > 0 ? (
          <section className="panel">
            <div className="panel-head">
              <div>
                <h2>Where the failures sit</h2>
                <p className="muted">Failed against total, release by release. Select one to scope the stream.</p>
              </div>
            </div>
            <div className="panel-body">
              <ReleaseVolume points={releases} selectedId={filters.deploymentId} onSelect={select} />
              <ReleaseList points={releases} selectedId={filters.deploymentId} onSelect={select} />
            </div>
          </section>
        ) : null}
      </aside>

      <section key={touch.key} className={`panel session-stream-panel${touch.className}`}>
        <div className="panel-head">
          <div>
            <h2>{scoped ? `Sessions on ${scoped}` : 'The stream'}</h2>
            <p className="muted">
              Newest first. Open a trace to read what the agent did, call by call.
            </p>
          </div>
          <span className="muted stream-count tabular">
            {value === null ? '—' : `${value.total.toLocaleString('en-US')} matching`}
          </span>
        </div>

        <div className="panel-body">
          <div className="sessions-filters">
            <SessionFilterBar deployments={rollups} resultCount={value?.total ?? null} />
          </div>

          {list?.status === 'error' ? <p className="import-error">{list.message}</p> : null}
          {list === null || list.status === 'loading' ? <p className="muted">Loading sessions…</p> : null}

          {value && value.total === 0 ? (
            Object.keys(filters).length === 0 ? (
              <div className="empty-good">
                <strong>No production traces yet.</strong>{' '}
                Connect the SDK and call one WebMCP tool to create the first session.{' '}
                <button type="button" className="linkish" onClick={() => setView('sources', 'human')}>
                  Open Connection
                </button>
              </div>
            ) : (
              <p className="empty-good">No sessions match these filters. Clear them to see all captured traces.</p>
            )
          ) : value ? (
            <>
              <SessionStream rows={value.sessions} onOpenSession={(id) => openSession(id, 'human')} />
              <p className="table-foot">
                Showing {value.sessions.length.toLocaleString('en-US')} of{' '}
                {value.total.toLocaleString('en-US')}.{' '}
                {value.nextCursor ? (
                  <button
                    type="button"
                    className="linkish"
                    disabled={value.loadingMore}
                    onClick={() => loadMoreSessions(filters, PAGE_SIZE)}
                  >
                    {value.loadingMore ? 'Loading…' : 'Load more'}
                  </button>
                ) : (
                  'That is all of them.'
                )}
              </p>
            </>
          ) : null}
        </div>
      </section>
    </div>
  );
}
