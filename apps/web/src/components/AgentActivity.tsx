import { useState } from 'react';

import { useCatchflyStore, type TraceEntry } from '../state/store.ts';

const SHOWN = 8;

const KIND_COPY: Record<TraceEntry['kind'], string> = {
  read: 'read',
  write: 'changed the view',
  durable: 'made a permanent change',
};

function clock(iso: string): string {
  return iso.slice(11, 19);
}

function label(entry: TraceEntry): string {
  if (entry.status === 'pending') return 'running…';
  if (entry.status === 'failed') return 'refused';
  return KIND_COPY[entry.kind];
}

function elapsed(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function AgentActivity() {
  const trace = useCatchflyStore((state) => state.agentTrace);
  const [collapsedAt, setCollapsedAt] = useState<string | null>(null);

  if (trace.length === 0) return null;

  const open = collapsedAt !== trace[0].at;
  const changes = trace.filter((entry) => entry.kind !== 'read' && entry.status === 'ok').length;
  const running = trace.filter((entry) => entry.status === 'pending').length;

  return (
    <div className={`agent-activity${open ? ' is-open' : ''}`}>
      <button
        type="button"
        className="agent-activity-head"
        aria-expanded={open}
        onClick={() => setCollapsedAt(open ? trace[0].at : null)}
      >
        <span className="who who-agent">Agent</span>
        <span className="agent-activity-count">
          {trace.length} tool {trace.length === 1 ? 'call' : 'calls'} · {changes}{' '}
          {changes === 1 ? 'change' : 'changes'}
          {running > 0 ? ` · ${running} running` : ''}
        </span>
        <span className="agent-activity-latest">{trace[0].title}</span>
        <span className="agent-activity-toggle" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
      </button>

      {open ? (
        <ol className="agent-activity-list">
          {trace.slice(0, SHOWN).map((entry) => (
            <li
              key={entry.id}
              className={`agent-step agent-step-${entry.kind} is-${entry.status}`}
            >
              <span className="agent-step-time tabular">{clock(entry.at)}</span>
              <span className="agent-step-tool" title={entry.tool}>
                {entry.title}
              </span>
              <span className="agent-step-kind">{label(entry)}</span>
              {entry.durationMs === undefined ? null : (
                <span className="agent-step-duration tabular">{elapsed(entry.durationMs)}</span>
              )}
              {entry.error ? (
                <span className="agent-step-error">{entry.error}</span>
              ) : entry.summary ? (
                <span className="agent-step-args">{entry.summary}</span>
              ) : null}
            </li>
          ))}
          {trace.length > SHOWN ? (
            <li className="agent-step muted">…and {trace.length - SHOWN} earlier</li>
          ) : null}
        </ol>
      ) : null}
    </div>
  );
}
