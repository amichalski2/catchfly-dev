import { CATEGORY_LABELS } from '@catchfly/core/labels.ts';
import type { SessionSummary } from '@catchfly/core/session-types.ts';

const OUTCOME_TONE: Record<SessionSummary['outcome'], string> = {
  completed: 'completed',
  failed: 'failed',
  abandoned: 'abandoned',
  unknown: 'unknown',
};

const dayOf = (iso: string) => iso.slice(0, 10);

const dayLabel = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });

const clockOf = (iso: string) => new Date(iso).toISOString().slice(11, 16);

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

export function SessionStream({
  rows,
  onOpenSession,
}: {
  rows: SessionSummary[];
  onOpenSession: (sessionId: string) => void;
}) {
  let lastDay = '';

  return (
    <ol className="stream">
      {rows.map((row) => {
        const day = dayOf(row.startedAt);
        const opensDay = day !== lastDay;
        lastDay = day;

        return (
          <li key={row.id} className="stream-item">
            {opensDay ? <p className="stream-day">{dayLabel(row.startedAt)}</p> : null}

            <div className={`stream-row is-${OUTCOME_TONE[row.outcome]}`}>
              <span className="stream-mark" aria-hidden="true" />

              <span className="stream-clock tabular">{clockOf(row.startedAt)}</span>

              <span className="stream-body">
                <button type="button" className="stream-intent" onClick={() => onOpenSession(row.id)}>
                  {row.intent ?? 'Intent not captured'}
                </button>
                <span className="stream-meta">
                  <span className="stream-version">{row.appVersionId}</span>
                  <span aria-hidden="true">·</span>
                  <span>{row.model ?? 'agent unknown'}</span>
                  <span aria-hidden="true">·</span>
                  <span className="tabular">{row.toolCallCount} calls</span>
                  <span aria-hidden="true">·</span>
                  <span className="tabular">{seconds(row.totalDurationMs)}</span>
                  {row.errorCallCount > 0 ? (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="stream-errored tabular">{row.errorCallCount} rejected</span>
                    </>
                  ) : null}
                </span>
              </span>

              <span className="stream-verdict">
                <span className="stream-outcome">{row.outcome}</span>
                {row.failureCategory ? (
                  <span className="stream-cause">{CATEGORY_LABELS[row.failureCategory]}</span>
                ) : null}
                {row.failureTool ? (
                  <span className="stream-tool">{row.failureTool}</span>
                ) : null}
              </span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
