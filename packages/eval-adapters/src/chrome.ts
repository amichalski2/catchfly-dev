/**
 * Adapter for the JSON report emitted by the Chrome WebMCP Evals CLI
 * (`npx webmcp-evals ... --reporter json`, written to `.evals/report-*.json`).
 *
 * Shape of the file, from GoogleChromeLabs/webmcp-tools:
 *
 *   { config:  { backend, model, chromeChannel, toolSchemaFile, evalsFile },
 *     results: { results: TestResult[], testCount, passCount, failCount, errorCount } }
 *
 *   TestResult = { test: { name?, messages[], expectedCall }, response, outcome,
 *                  trajectory?, runIndex?, stepIndex? }
 *
 * Two mismatches with Catchfly's model are resolved here rather than in the
 * schema:
 *
 *   1. Chrome scores a *step*; Catchfly scores an *attempt*. A multi-turn case
 *      arrives as several TestResults sharing (name, runIndex) and differing by
 *      stepIndex. They are folded into one attempt — worst outcome wins, calls
 *      and trajectory concatenate in step order. Without this, one multi-step
 *      case would import as several look-alike cases.
 *
 *   2. Chrome measures no latency or cost. Those fields stay undefined rather
 *      than defaulting to zero, so the UI can hide them instead of showing a
 *      confident `0 ms`.
 */

import { categorize } from '@catchfly/core/categorize.ts';
import type {
  CaseResult,
  EvalCase,
  EvalRun,
  ExpectedCallNode,
  Outcome,
  ToolCall,
  ToolSchema,
  TrajectoryStep,
} from '@catchfly/core/types.ts';

// --- the report, as Chrome writes it -----------------------------------

type ChromeMessage = {
  role?: string;
  type?: string;
  content?: string;
  name?: string;
};

type ChromeTestResult = {
  test?: {
    name?: string;
    messages?: ChromeMessage[];
    expectedCall?: ExpectedCallNode[] | null;
  };
  response?: { functionName?: string; args?: Record<string, unknown>; result?: unknown } | null;
  outcome?: string;
  trajectory?: Array<{
    text?: string;
    reasoningText?: string;
    toolCalls?: unknown[];
    toolResults?: unknown[];
    availableTools?: Array<{ functionName?: string; name?: string; description?: string; parameters?: unknown }>;
  }>;
  runIndex?: number;
  stepIndex?: number;
};

export type ChromeReport = {
  config?: { backend?: string; model?: string; chromeChannel?: string; evalsFile?: string };
  results?: {
    results?: ChromeTestResult[];
    testCount?: number;
    passCount?: number;
    failCount?: number;
    errorCount?: number;
  };
};

export class ImportError extends Error {}

export type AdaptOptions = {
  /** Which app version this report describes — Chrome reports do not say. */
  appVersionId: string;
  runId: string;
  /** ISO timestamp; the caller supplies it because the report has none. */
  timestamp: string;
};

export type AdaptedReport = {
  run: EvalRun;
  cases: EvalCase[];
  /** Union of the tools the model could see, if the report recorded them. */
  toolManifest: ToolSchema[];
};

// --- helpers ------------------------------------------------------------

const OUTCOMES: Outcome[] = ['pass', 'fail', 'error'];

/** Worst outcome wins when folding the steps of one attempt. */
function worst(a: Outcome, b: Outcome): Outcome {
  if (a === 'error' || b === 'error') return 'error';
  if (a === 'fail' || b === 'fail') return 'fail';
  return 'pass';
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'case'
  );
}

/** Chrome identifies a case by `name`, falling back to the first user message. */
function caseNameOf(result: ChromeTestResult, index: number): string {
  if (result.test?.name) return result.test.name;
  const first = result.test?.messages?.find((message) => message.type === 'message');
  return first?.content ?? `Test case #${index + 1}`;
}

function promptOf(result: ChromeTestResult): string {
  const first = result.test?.messages?.find(
    (message) => message.type === 'message' && message.role === 'user',
  );
  return first?.content ?? '';
}

function toToolCall(raw: unknown): ToolCall | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Record<string, unknown>;
  // Chrome uses functionName; some SDK shapes carry `name` + `arguments`.
  const functionName = (value.functionName ?? value.name) as string | undefined;
  if (typeof functionName !== 'string') return null;
  const args = (value.args ?? value.arguments ?? {}) as Record<string, unknown>;
  return { functionName, args: typeof args === 'object' && args !== null ? args : {}, result: value.result };
}

function callsOf(result: ChromeTestResult): ToolCall[] {
  const fromTrajectory = (result.trajectory ?? []).flatMap((step) =>
    (step.toolCalls ?? [])
      .map(toToolCall)
      .filter((call): call is ToolCall => call !== null)
      // A step records calls and results in matching order.
      .map((call, callIndex) => ({ ...call, result: call.result ?? step.toolResults?.[callIndex] })),
  );
  if (fromTrajectory.length > 0) return fromTrajectory;

  const single = toToolCall(result.response);
  return single ? [single] : [];
}

function trajectoryOf(result: ChromeTestResult): TrajectoryStep[] {
  return (result.trajectory ?? []).map((step) => ({
    text: step.text,
    reasoningText: step.reasoningText,
    toolCalls: (step.toolCalls ?? [])
      .map(toToolCall)
      .filter((call): call is ToolCall => call !== null),
    toolResults: step.toolResults,
  }));
}

function manifestFrom(results: ChromeTestResult[]): ToolSchema[] {
  const byName = new Map<string, ToolSchema>();
  for (const result of results) {
    for (const step of result.trajectory ?? []) {
      for (const tool of step.availableTools ?? []) {
        const name = tool.name ?? tool.functionName;
        if (!name || byName.has(name)) continue;
        byName.set(name, {
          name,
          description: tool.description ?? '',
          inputSchema: (tool.parameters as Record<string, unknown> | undefined) ?? null,
        });
      }
    }
  }
  return [...byName.values()];
}

// --- the adapter --------------------------------------------------------

export function adaptChromeReport(report: ChromeReport, options: AdaptOptions): AdaptedReport {
  const results = report.results?.results;
  if (!Array.isArray(results)) {
    throw new ImportError(
      'Not a Chrome WebMCP Evals report: expected a `results.results` array. ' +
        'Run the CLI with `--reporter json` and upload `.evals/report-*.json`.',
    );
  }
  if (results.length === 0) throw new ImportError('The report contains no test results.');

  const toolManifest = manifestFrom(results);
  const knownTools = toolManifest.length > 0 ? toolManifest.map((tool) => tool.name) : undefined;

  const definitions = new Map<string, EvalCase>();
  /** Steps of one attempt, keyed `${caseId}::${runIndex}`. */
  const attempts = new Map<string, { caseId: string; runIndex: number; steps: ChromeTestResult[] }>();

  results.forEach((result, index) => {
    const name = caseNameOf(result, index);
    const caseId = slugify(name);
    const runIndex = result.runIndex ?? 1;

    if (!definitions.has(caseId)) {
      definitions.set(caseId, {
        caseId,
        name,
        prompt: promptOf(result),
        expectedCall: result.test?.expectedCall ?? [],
      });
    }

    const key = `${caseId}::${runIndex}`;
    const bucket = attempts.get(key);
    if (bucket) bucket.steps.push(result);
    else attempts.set(key, { caseId, runIndex, steps: [result] });
  });

  const caseResults: CaseResult[] = [...attempts.values()].map((attempt) => {
    // Steps arrive in file order; stepIndex makes that explicit when present.
    const steps = [...attempt.steps].sort(
      (a, b) => (a.stepIndex ?? 0) - (b.stepIndex ?? 0),
    );

    const outcome = steps.reduce<Outcome>((acc, step) => {
      const raw = OUTCOMES.find((candidate) => candidate === step.outcome) ?? 'fail';
      return worst(acc, raw);
    }, 'pass');

    const actualCalls = steps.flatMap(callsOf);
    const trajectory = steps.flatMap(trajectoryOf);
    const definition = definitions.get(attempt.caseId)!;

    return {
      caseId: attempt.caseId,
      runIndex: attempt.runIndex,
      outcome,
      category: categorize({
        expectedCall: definition.expectedCall,
        actualCalls,
        outcome,
        knownTools,
      }),
      actualCalls,
      trajectory,
      // Latency and cost stay undefined: Chrome does not measure them, and a
      // zero here would read as a measurement.
    };
  });

  const passCount = caseResults.filter((result) => result.outcome === 'pass').length;
  const errorCount = caseResults.filter((result) => result.outcome === 'error').length;

  const run: EvalRun = {
    id: options.runId,
    appVersionId: options.appVersionId,
    model: report.config?.model ?? 'unknown model',
    backend: report.config?.backend,
    timestamp: options.timestamp,
    metrics: {
      testCount: caseResults.length,
      passCount,
      failCount: caseResults.length - passCount - errorCount,
      errorCount,
      successRate: caseResults.length === 0 ? 0 : passCount / caseResults.length,
    },
    results: caseResults,
  };

  return { run, cases: [...definitions.values()], toolManifest };
}
