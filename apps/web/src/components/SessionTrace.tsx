/**
 * One session, call by call.
 *
 * Built on the same `.traj-*` vocabulary as TrajectoryDiff, because a reviewer
 * reading a production trace and a developer reading an eval trajectory are
 * doing the same thing and should not have to learn two layouts.
 *
 * What is different is time. An eval trajectory is a sequence; a session
 * happened, so each call carries its offset from the start and how long it
 * took. A slow call and a failed call look different here, which is the whole
 * reason for looking.
 *
 * Arguments and results are collapsed by default. They are the evidence, and
 * they are usually long — a trace that opens with every payload expanded is a
 * wall rather than a timeline.
 */

import type { Session, SessionToolCall } from '@catchfly/core/session-types.ts';
import type { TrajectoryStep } from '@catchfly/core/types.ts';

function argSummary(args: Record<string, unknown> | undefined): string {
  if (!args) return '';
  const entries = Object.entries(args);
  if (entries.length === 0) return '';
  return entries
    .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(', ');
}

/** Offset from the first call, which is what makes a gap in the trace visible. */
function offset(call: SessionToolCall, startedAt: string): string {
  const ms = Date.parse(call.timestamp) - Date.parse(startedAt);
  if (Number.isNaN(ms) || ms < 0) return '0.0s';
  return `${(ms / 1000).toFixed(1)}s`;
}

function Payload({ label, value }: { label: string; value: unknown }) {
  if (value === undefined) return null;
  return (
    <details className="trace-payload">
      <summary>{label}</summary>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}

/**
 * The agent's narration, when the client forwarded it. Interleaved with the
 * calls rather than shown as a separate block: what the agent said it was
 * about to do belongs next to what it then did.
 */
function Narration({ step }: { step: TrajectoryStep }) {
  if (!step.text && !step.reasoningText) return null;
  return (
    <div className="trace-said">
      {step.reasoningText ? <p className="trace-reasoning">{step.reasoningText}</p> : null}
      {step.text ? <p className="trace-text">{step.text}</p> : null}
    </div>
  );
}

export function SessionTrace({
  session,
  onOpenTool,
}: {
  session: Session;
  onOpenTool: (toolName: string) => void;
}) {
  const first = session.toolCalls[0]?.timestamp ?? session.startedAt;

  // Narration steps that carry no tool call are the agent's opening and closing
  // remarks; they bracket the trace rather than sitting inside it.
  const opening = session.transcript?.find((step) => !step.toolCalls?.length && step.text);
  const closing = [...(session.transcript ?? [])]
    .reverse()
    .find((step) => !step.toolCalls?.length && step.text);
  const spoken = (session.transcript ?? []).filter((step) => step.toolCalls?.length);

  return (
    <div className="traj-wrap">
      {opening ? <Narration step={opening} /> : null}

      <ol className="traj-calls trace-calls">
        {session.toolCalls.map((call, index) => {
          const failed = call.status === 'error';
          const narration = spoken[index];
          return (
            <li key={`${call.toolName}-${index}`}>
              {narration ? <Narration step={narration} /> : null}
              <div className={`traj-call trace-call${failed ? ' is-diverged' : ''}`}>
                <span className="trace-clock tabular">{offset(call, first)}</span>
                <button type="button" className="linkish" onClick={() => onOpenTool(call.toolName)}>
                  <code>{call.toolName}</code>
                </button>
                <span className="trace-duration tabular">{Math.round(call.durationMs)}ms</span>
                <span className={`pill pill-${failed ? 'fail' : 'pass'}`}>{failed ? '✗' : '✓'}</span>
                {argSummary(call.arguments) ? (
                  <span className="traj-args">{argSummary(call.arguments)}</span>
                ) : null}
                {call.errorMessage ? <span className="traj-error">{call.errorMessage}</span> : null}
                <div className="trace-payloads">
                  <Payload label="arguments" value={call.arguments} />
                  <Payload label="result" value={call.result} />
                </div>
              </div>
            </li>
          );
        })}
      </ol>

      {closing && closing !== opening ? <Narration step={closing} /> : null}

      {session.transcript === undefined ? (
        <p className="traj-reason muted">
          This client did not forward the agent&apos;s own narration — only the calls it made.
        </p>
      ) : null}
    </div>
  );
}
