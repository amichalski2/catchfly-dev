/**
 * The shared-session strip.
 *
 * This is where the two operators become visible to each other: what changed,
 * who changed it, and a way to take it back. Without it, an agent tool call is
 * indistinguishable from the page doing something on its own.
 */

import { useEffect, useRef, useState } from 'react';

import { agentBusy, pendingCall } from '../state/selectors.ts';
import { useCatchflyStore } from '../state/store.ts';
import type { WebMcpStatus } from '@catchfly/webmcp/spec.ts';

const README_URL = 'https://github.com/amichalski2/catchfly-dev#investigate-with-an-agent';

const STATUS_COPY: Record<
  WebMcpStatus,
  { label: string; detail: string; mark: string; help: string | null }
> = {
  active: {
    label: 'Site tools active',
    detail: 'An agent in this browser can read and drive this dashboard.',
    mark: '/brand/status-active.webp',
    help: null,
  },
  registering: {
    label: 'Site tools registering',
    detail: 'Publishing this page’s tools to the browser — they are not all reachable yet.',
    mark: '/brand/status-active.webp',
    help: null,
  },
  degraded: {
    label: 'Site tools partly available',
    detail: 'Some tools were refused by this browser. The rest work, so an agent may find gaps.',
    mark: '/brand/status-unsupported.webp',
    help: 'Reload the page to retry registration. If it repeats, the browser build is limiting the tool count.',
  },
  unsupported: {
    label: 'Site tools unavailable',
    detail: 'This browser has no WebMCP support — the dashboard works normally without it.',
    mark: '/brand/status-unsupported.webp',
    help: 'WebMCP needs Chrome Canary or Dev 150+ with the WebMCP flag, or the built-in browser of the ChatGPT desktop app.',
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
  const [open, setOpen] = useState(false);
  const statusRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent && event.key !== 'Escape') return;
      if (event instanceof MouseEvent && statusRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  return (
    <div className="session">
      <div className="tools-status" ref={statusRef}>
        <button
          type="button"
          className={`session-status tools-status-button is-${status}`}
          aria-expanded={open}
          aria-controls="tools-status-popover"
          onClick={() => setOpen((current) => !current)}
        >
          <img
            className={`session-mark${spinning ? ' is-spinning' : ''}`}
            src={copy.mark}
            alt=""
            aria-hidden="true"
          />
          {copy.label}
          {status === 'degraded' ? <span className="tools-status-flag" aria-hidden="true">!</span> : null}
        </button>
        {open ? (
          <div id="tools-status-popover" className="tools-status-popover" role="dialog" aria-label={copy.label}>
            <p>{copy.detail}</p>
            {copy.help ? <p className="muted">{copy.help}</p> : null}
            <a href={README_URL} target="_blank" rel="noreferrer">
              How agents work with Catchfly
            </a>
          </div>
        ) : null}
      </div>

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
