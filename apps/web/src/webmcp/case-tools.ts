/**
 * Case-scoped tools — only registered while a case is selected.
 *
 * This is the dynamic half of the WebMCP surface: selecting a case (by either
 * operator) makes these tools appear; deselecting revokes them. They read the
 * selection from the shared state instead of taking a caseId, so the agent's
 * calls always concern the case the user is looking at.
 */

import { getDb } from '@catchfly/core/db.ts';
import { compareTrajectories, getCase } from '@catchfly/core/queries.ts';
import { catchflyStore } from '../state/store.ts';
import { attemptPayload, trajectoryPayload } from '@catchfly/webmcp/payloads.ts';
import { describeSharedState } from './tools.ts';
import type { ModelContextTool } from '@catchfly/webmcp/spec.ts';

function selectedCaseId(): string {
  const caseId = catchflyStore.getState().selectedCaseId;
  if (!caseId) throw new Error('No case is selected any more — call open_case first.');
  return caseId;
}

export function buildCaseTools(): ModelContextTool[] {
  return [
    {
      name: 'inspect_selected_case',
      title: 'Inspect the open case',
      description:
        'Prefer this over get_case while a case is open: it takes no caseId and always describes ' +
        'the case the developer is actually looking at, so it cannot drift from their screen. ' +
        'Reads the full detail of that case: prompt, expected calls, and every attempt in every ' +
        'run — including per-attempt call sequences with arguments, outcomes and failure reasons.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
      execute: async () => {
        const detail = getCase(getDb(), selectedCaseId());
        return {
          caseId: detail.definition.caseId,
          name: detail.definition.name,
          prompt: detail.definition.prompt,
          expectedBehavior: detail.definition.expectedBehavior ?? null,
          expectedCall: detail.definition.expectedCall,
          runs: detail.runs.map((run) => ({
            runId: run.runId,
            appVersion: run.appVersionLabel,
            model: run.model,
            passes: run.passes,
            repeats: run.repeats,
            attempts: run.attempts.map(attemptPayload),
          })),
        };
      },
    },

    {
      name: 'compare_selected_trajectories',
      title: 'Compare the open case',
      description:
        'Prefer this over compare_trajectories while a case is open: it takes no caseId and ' +
        'defaults to the comparison the developer is viewing, so it cannot drift from their ' +
        'screen. Compares the open case\'s trajectory between the two runs of that comparison ' +
        '(override with baselineRunId/candidateRunId): calls side by side, the first divergence, ' +
        'and the tool-manifest delta between the app versions.',
      inputSchema: {
        type: 'object',
        properties: {
          baselineRunId: { type: 'string', description: 'Optional override of the active baseline run.' },
          candidateRunId: { type: 'string', description: 'Optional override of the active candidate run.' },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      execute: async (input) => {
        const state = catchflyStore.getState();
        const baselineRunId = (input.baselineRunId as string | undefined) ?? state.comparison?.baselineRunId;
        const candidateRunId =
          (input.candidateRunId as string | undefined) ?? state.comparison?.candidateRunId;
        if (!baselineRunId || !candidateRunId) {
          throw new Error('No active comparison — pass baselineRunId and candidateRunId explicitly.');
        }
        if (!getDb().runsById.has(baselineRunId)) throw new Error(`Unknown run "${baselineRunId}"`);
        if (!getDb().runsById.has(candidateRunId)) throw new Error(`Unknown run "${candidateRunId}"`);
        return trajectoryPayload(
          compareTrajectories(getDb(), selectedCaseId(), baselineRunId, candidateRunId),
        );
      },
    },

    {
      name: 'close_case',
      title: 'Close the case',
      description:
        'Close the case-detail view and return the user to the case table. The case-scoped tools ' +
        'disappear until a case is opened again. Returns the resulting state.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => {
        catchflyStore.getState().closeCase('agent');
        return describeSharedState();
      },
    },
  ];
}
