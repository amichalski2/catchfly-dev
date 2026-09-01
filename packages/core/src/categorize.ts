/**
 * Failure classification — Catchfly's own layer on top of a Chrome eval report.
 *
 * Chrome tells you an attempt was `fail`. Catchfly answers *why*, by comparing
 * the expected calls against what the model actually did. The same function is
 * used by the fixture generator and (later) by the Chrome report importer, so
 * generated and imported data are classified identically.
 */

import { matchArgs, matchResult } from './matchers.ts';
import type {
  ExpectedCallNode,
  ExpectedFunctionCall,
  FailureCategory,
  Outcome,
  ToolCall,
} from './types.ts';

/** Flattens ordered/unordered groups into the individual expected calls. */
export function flattenExpected(nodes: ExpectedCallNode[]): ExpectedFunctionCall[] {
  const out: ExpectedFunctionCall[] = [];
  for (const node of nodes) {
    if ('ordered' in node) out.push(...flattenExpected(node.ordered));
    else if ('unordered' in node) out.push(...flattenExpected(node.unordered));
    else out.push(node);
  }
  return out;
}

/** Expected calls whose relative order is enforced, in order. */
function orderedSequences(nodes: ExpectedCallNode[]): ExpectedFunctionCall[][] {
  const sequences: ExpectedFunctionCall[][] = [];
  const walk = (list: ExpectedCallNode[], enforced: boolean) => {
    const direct: ExpectedFunctionCall[] = [];
    for (const node of list) {
      if ('ordered' in node) walk(node.ordered, true);
      else if ('unordered' in node) walk(node.unordered, false);
      else direct.push(node);
    }
    if (enforced && direct.length > 1) sequences.push(direct);
  };
  // The top level of `expectedCall` is an ordered sequence in Chrome's semantics.
  walk(nodes, true);
  return sequences;
}

function violatesOrder(sequence: ExpectedFunctionCall[], actual: ToolCall[]): boolean {
  const positions = sequence.map((expected) =>
    actual.findIndex((call) => call.functionName === expected.functionName),
  );
  const present = positions.filter((index) => index >= 0);
  if (present.length < 2) return false;
  return present.some((index, i) => i > 0 && index < present[i - 1]);
}

export type CategorizeInput = {
  expectedCall: ExpectedCallNode[];
  actualCalls: ToolCall[];
  outcome: Outcome;
  /** Tool names the app exposed for this run — enables hallucinated-tool detection. */
  knownTools?: string[];
};

/**
 * Returns the failure category, or `undefined` for a passing attempt.
 *
 * The checks are ordered from the most specific signal to the least: a call to
 * a tool that does not exist outranks a wrong tool choice, which outranks bad
 * arguments, which outranks a malformed result.
 */
export function categorize({
  expectedCall,
  actualCalls,
  outcome,
  knownTools,
}: CategorizeInput): FailureCategory | undefined {
  if (outcome === 'pass') return undefined;
  if (outcome === 'error') return 'error';

  const expected = flattenExpected(expectedCall).filter((call) => !call.optional);
  const actualNames = actualCalls.map((call) => call.functionName);

  if (knownTools && actualNames.some((name) => !knownTools.includes(name))) {
    return 'hallucinated-tool';
  }

  // Count occurrences, so a case expecting two get_product calls is not
  // satisfied by a single one.
  const required = new Map<string, number>();
  for (const call of expected) {
    required.set(call.functionName, (required.get(call.functionName) ?? 0) + 1);
  }
  for (const [name, count] of required) {
    if (actualNames.filter((actual) => actual === name).length < count) {
      // Reaching for a different tool instead of the expected one, or reaching
      // for nothing at all, is a tool-selection failure either way.
      return 'tool-selection';
    }
  }

  if (orderedSequences(expectedCall).some((sequence) => violatesOrder(sequence, actualCalls))) {
    return 'sequencing';
  }

  // Pair each expectation with a distinct actual call before checking details,
  // so repeated calls to the same tool are compared one-to-one.
  const consumed = new Set<number>();
  const pairs: Array<{ expected: ExpectedFunctionCall; actual: ToolCall }> = [];
  for (const call of expected) {
    let matched = -1;
    for (let index = 0; index < actualCalls.length; index += 1) {
      if (consumed.has(index) || actualCalls[index].functionName !== call.functionName) continue;
      if (matchArgs(call.arguments, actualCalls[index].args)) {
        matched = index;
        break;
      }
    }
    // The tool was called (the occurrence check above passed) but no remaining
    // call satisfies the expected arguments.
    if (matched < 0) return 'argument-errors';
    consumed.add(matched);
    pairs.push({ expected: call, actual: actualCalls[matched] });
  }

  for (const pair of pairs) {
    if (!matchResult(pair.expected.result, pair.actual.result)) return 'structured-output';
  }

  // Every structural check passed yet the attempt was marked failed — the model
  // made the right calls but did not deliver a usable answer.
  return 'structured-output';
}
