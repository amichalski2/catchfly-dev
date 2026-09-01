/**
 * Converts a Catchfly run back into the Chrome WebMCP Evals report shape.
 *
 * Shared by the sample export and the test-data generator so both exercise the
 * adapter's contract from the same side: whatever this writes,
 * `adaptChromeReport` must be able to read.
 */

import type { CatchflyDb } from '@catchfly/core/db.ts';
import { getRun } from '@catchfly/core/queries.ts';

export type ChromeReport = {
  config: Record<string, unknown>;
  results: {
    results: unknown[];
    testCount: number;
    passCount: number;
    failCount: number;
    errorCount: number;
  };
};

export function toChromeReport(db: CatchflyDb, runId: string, caseLimit?: number): ChromeReport {
  const run = getRun(db, runId);
  const version = db.versionsById.get(run.appVersionId)!;

  const availableTools = version.toolManifest.map((tool) => ({
    functionName: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  }));

  const kept =
    caseLimit === undefined
      ? null
      : new Set(db.dataset.cases.slice(0, caseLimit).map((entry) => entry.caseId));

  const results = run.results
    .filter((result) => kept === null || kept.has(result.caseId))
    .map((result) => {
      const definition = db.casesById.get(result.caseId)!;
      return {
        test: {
          name: definition.name,
          messages: [{ role: 'user', type: 'message', content: definition.prompt }],
          expectedCall: definition.expectedCall,
        },
        response:
          result.actualCalls.length > 0
            ? {
                functionName: result.actualCalls[0].functionName,
                args: result.actualCalls[0].args,
                result: result.actualCalls[0].result,
              }
            : null,
        outcome: result.outcome,
        runIndex: result.runIndex,
        trajectory: result.trajectory
          .filter((step) => (step.toolCalls?.length ?? 0) > 0)
          .map((step) => ({
            reasoningText: step.reasoningText,
            toolCalls: step.toolCalls?.map((call) => ({
              functionName: call.functionName,
              args: call.args,
            })),
            toolResults: step.toolResults,
            availableTools,
          })),
      };
    });

  const passCount = results.filter((result) => result.outcome === 'pass').length;
  const errorCount = results.filter((result) => result.outcome === 'error').length;

  return {
    config: {
      backend: run.backend ?? 'gemini',
      model: run.model,
      chromeChannel: 'chrome-canary',
      evalsFile: 'evals.json',
      toolSchemaFile: 'schema.json',
    },
    results: {
      results,
      testCount: results.length,
      passCount,
      failCount: results.length - passCount - errorCount,
      errorCount,
    },
  };
}
