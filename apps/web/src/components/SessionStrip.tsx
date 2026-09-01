/**
 * The shared-session strip.
 *
 * This is where the two operators become visible to each other: what changed,
 * who changed it, and a way to take it back. Without it, an agent tool call is
 * indistinguishable from the page doing something on its own.
 */

import { agentBusy, pendingCall } from '../state/selectors.ts';
import { useCatchflyStore } from '../state/store.ts';
import type { WebMcpStatus } from '@catchfly/webmcp/spec.ts';

const STATUS_COPY: Record<WebMcpStatus, { label: string; detail: string; mark: string }> = {
  active: {
    label: 'Site tools active',
    detail: 'An agent in this browser can read and drive this dashboard.',
    mark: '/brand/status-active.webp',
  },
  registering: {
    label: 'Site tools registering',
    detail: 'Publishing this page’s tools to the browser — they are not all reachable yet.',
    mark: '/brand/status-active.webp',
  },
  degraded: {
    label: 'Site tools partly available',
    detail: 'Some tools were refused by this browser. The rest work, so an agent may find gaps.',
    mark: '/brand/status-unsupported.webp',
  },
  unsupported: {
    label: 'Site tools unavailable',
    detail: 'This browser has no WebMCP support — the dashboard works normally without it.',
    mark: '/brand/status-unsupported.webp',
  },
};

export function SessionStrip() {
  const status = useCatchflyStore((state) => state.webmcpStatus);
  const lastAction = useCatchflyStore((state) => state.lastAction);
  const nextUndo = useCatchflyStore((state) => state.undoStack[0] ?? null);
  const undoLast = useCatchflyStore((state) => state.undoLast);
  const busy = useCatchflyStore(agentBusy);
  const running = useCatchflyStore(pendingCall);
  const copy = STATUS_COPY[status];
  const spinning = busy || status === 'registering';

  return (
    <div className="session">
      <span className={`session-status is-${status}`} title={copy.detail}>
        <img
          className={`session-mark${spinning ? ' is-spinning' : ''}`}
          src={copy.mark}
          alt=""
          aria-hidden="true"
        />
        {copy.label}
      </span>

      <span className="session-action" role="status" aria-live="polite">
        {running ? (
          <>
            <span className="who who-agent">Agent</span>
            <span className="session-summary">Running {running.title}…</span>
          </>
        ) : lastAction ? (
          <>
            <span className={`who who-${lastAction.source}`}>
              {lastAction.source === 'agent' ? 'Agent' : 'You'}
            </span>
            <span className="session-summary">{lastAction.summary}</span>
            {lastAction.reversible ? null : (
              <span className="session-irreversible">· can’t be undone</span>
            )}
          </>
        ) : (
          <span className="muted">No changes yet this session.</span>
        )}
      </span>

      <button
        type="button"
        className="btn btn-quiet"
        onClick={() => undoLast('human')}
        disabled={nextUndo === null}
        title={nextUndo ? `Revert "${nextUndo.action.summary}"` : 'Nothing to undo'}
        aria-label={nextUndo ? `Revert "${nextUndo.action.summary}"` : 'Nothing to undo'}
      >
        Undo
      </button>
    </div>
  );
}
