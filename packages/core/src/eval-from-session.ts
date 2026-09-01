/**
 * Turning a production failure into an eval case.
 *
 * This is the hinge of the product: the moment a thing that went wrong once
 * becomes a thing that will be checked every time. Everything about the shape
 * of the case follows from wanting it to be a *useful* test rather than a
 * transcript.
 *
 * Two decisions are worth stating outright.
 *
 * The expectation is the calls the agent made, minus the mistake. A session
 * that failed is not a description of correct behaviour, so replaying it
 * verbatim would mint a test that asserts the bug. Successful calls keep the
 * arguments they were made with; the call that was rejected keeps its name and
 * loses its arguments, which in Chrome's semantics means "any arguments" — the
 * honest statement that this tool should be reached for, while what to send it
 * is exactly what nobody knows yet. A caller who does know passes
 * `correctedCalls` and overrides all of it.
 *
 * That subtraction only works when the mistake is visible in the trace. In a
 * tool-selection failure it is not: every call succeeded, and what went wrong is
 * the call that was never made. Deriving an expectation there would assert the
 * wrong trajectory precisely when the case matters most, so this refuses and
 * asks for `correctedCalls` rather than minting a test for the bug.
 *
 * And the case carries `sourceSessionId`, so the answer to "why does this test
 * exist?" lives in the data rather than in whoever remembers.
 *
 * Pure, so the UI panel and the WebMCP tool mint identical cases.
 */

import type { Session } from './session-types.ts';
import type { EvalCase, ExpectedFunctionCall } from './types.ts';

export type MintOptions = {
  /** Overrides the derived id. Must still be a usable case id. */
  caseId?: string;
  name?: string;
  /** Required when the session captured no intent — a case needs a request to replay. */
  prompt?: string;
  expectedBehavior?: string;
  /** The call sequence that *should* have happened, when the caller knows it. */
  correctedCalls?: Array<{ functionName: string; arguments?: Record<string, unknown> | null }>;
  /** Case ids already in the project, so a mint does not collide with one. */
  taken?: string[];
};

export class MintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MintError';
  }
}

/** `s-0142` becomes `case-from-s-0142`, suffixed if that is already taken. */
function idFor(sessionId: string, taken: string[]): string {
  const base = `case-from-${sessionId}`.toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
  if (!taken.includes(base)) return base;
  for (let suffix = 2; suffix < 100; suffix += 1) {
    if (!taken.includes(`${base}-${suffix}`)) return `${base}-${suffix}`;
  }
  throw new MintError(`Too many cases already minted from session ${sessionId}.`);
}

function expectationsFrom(session: Session): ExpectedFunctionCall[] {
  return session.toolCalls.map((call) =>
    call.status === 'success' && call.arguments
      ? { functionName: call.toolName, arguments: call.arguments }
      : // The rejected call: assert the tool, not the arguments that failed.
        { functionName: call.toolName, arguments: null },
  );
}

function describe(session: Session): string {
  const where = session.failureTool ? ` in ${session.failureTool}` : '';
  const why = session.failureCategory ? `${session.failureCategory}${where}` : `outcome: ${session.outcome}`;
  return `Should complete the request without the failure observed in ${session.id} (${why}).`;
}

/**
 * Builds the case. Throws rather than guessing when the session gives it
 * nothing to replay.
 */
export function buildCaseFromSession(session: Session, options: MintOptions = {}): EvalCase {
  const prompt = (options.prompt ?? session.intent ?? '').trim();
  if (prompt === '') {
    throw new MintError(
      `Session ${session.id} captured no user intent, so there is nothing to replay. ` +
        'Supply a prompt describing what was being asked for.',
    );
  }

  const expectedCall: ExpectedFunctionCall[] =
    options.correctedCalls && options.correctedCalls.length > 0
      ? options.correctedCalls.map((call) => ({
          functionName: call.functionName,
          arguments: call.arguments ?? null,
        }))
      : expectationsFrom(session);

  if (expectedCall.length === 0) {
    throw new MintError(
      `Session ${session.id} made no tool calls, so there is no behaviour to assert. ` +
        'Supply the calls the agent should have made.',
    );
  }

  const derived = !options.correctedCalls || options.correctedCalls.length === 0;
  const missingTool =
    session.failureTool && !session.toolCalls.some((call) => call.toolName === session.failureTool)
      ? session.failureTool
      : null;
  if (derived && missingTool) {
    throw new MintError(
      `Session ${session.id} failed by never calling ${missingTool}, so the calls it did make ` +
        'are the wrong trajectory, not the right one. Minting from them would assert the bug. ' +
        `Pass correctedCalls with the sequence that should have run — it will need ${missingTool} ` +
        `in it. The session made: ${session.toolCalls.map((call) => call.toolName).join(' → ')}.`,
    );
  }

  const caseId = options.caseId ?? idFor(session.id, options.taken ?? []);
  const name = options.name?.trim() || `Regression from ${session.id}`;

  return {
    caseId,
    name,
    prompt,
    expectedCall,
    expectedBehavior: options.expectedBehavior?.trim() || describe(session),
    sourceSessionId: session.id,
  };
}
