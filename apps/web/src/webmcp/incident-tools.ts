import { isSessionsAvailable, sessionsSource } from '@catchfly/core/sessions-db.ts';
import { incidentOverviewPayload } from '@catchfly/webmcp/payloads.ts';
import type { ModelContextTool } from '@catchfly/webmcp/spec.ts';

import { fetchIncidentOverview } from '../data/api.ts';
import { catchflyStore } from '../state/store.ts';
import { asOptionalString, SEES_AND_CAN_UNDO, writeResult } from './tools.ts';

export function buildIncidentTools(): ModelContextTool[] {
  return [
    {
      name: 'get_incident_overview',
      title: 'Read the incident overview',
      description:
        'Start here for "what regressed" and "which change caused it". Returns the ranked ' +
        'incidents for this project, each one a manifest change observed across the release ' +
        'history: how far eval success fell, how far the production failure rate rose, how many ' +
        'models agree, how many times it recurred, and the tools it touched. Every incident also ' +
        'carries the run pair to hand to find_regressions, the app-version pair, and the ' +
        'deployment pair (null when that version never served production) to hand to ' +
        'compare_deployments or open_release_comparison, so this collapses the first three hops ' +
        'of an investigation. corroboration says whether evals and production each confirm it, ' +
        'with the same thresholds the dashboard uses. regressionCount is the headline figure; ' +
        'total also counts decoys and recoveries, and visibleOnScreen lists the incidents the ' +
        'developer currently sees as cards — the rest are behind an "All findings" fold. ' +
        'An incident of kind "decoy" is a release that looks alarming on latency while quality ' +
        'and completion stay flat — weigh it, do not report it as a regression. Also returns the ' +
        'release timeline, newest last.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
      execute: async () => {
        const projectId = catchflyStore.getState().projectId;
        return incidentOverviewPayload(await fetchIncidentOverview(projectId));
      },
    },

    {
      name: 'open_release_comparison',
      title: 'Compare two releases',
      description:
        'Put two releases side by side on the developer\'s screen: production failure rate, ' +
        'execution success per tool worst-first, the failure-category mix, and the manifest diff ' +
        'for the worst-hit tools. Omit both ids to open the two most recent releases, which is ' +
        'what the developer gets from the navigation. This is the production counterpart to ' +
        'set_comparison, which does the same for eval runs. From there, set_session_filters with ' +
        'a category or deploymentId shows the sessions behind a failure mode, and open_tool shows ' +
        'what a release changed about one tool. Returns the resulting shared state.' + SEES_AND_CAN_UNDO,
      inputSchema: {
        type: 'object',
        properties: {
          baselineDeploymentId: { type: 'string', description: 'See list_deployments. Defaults to the second-newest release.' },
          candidateDeploymentId: { type: 'string', description: 'See list_deployments. Defaults to the newest release.' },
        },
        additionalProperties: false,
      },
      execute: async (input) => {
        if (!isSessionsAvailable()) {
          throw new Error(
            'This deployment has no production session data, so releases cannot be compared — ' +
              'the eval tools still work. Do not retry.',
          );
        }
        const known = (await sessionsSource().listDeployments()).map((entry) => entry.id);
        const baselineDeploymentId = asOptionalString(input, 'baselineDeploymentId') ?? known[known.length - 2];
        const candidateDeploymentId = asOptionalString(input, 'candidateDeploymentId') ?? known[known.length - 1];
        if (!baselineDeploymentId || !candidateDeploymentId) {
          throw new Error('Catchfly needs traces from two deployments before releases can be compared.');
        }
        for (const id of [baselineDeploymentId, candidateDeploymentId]) {
          if (!known.includes(id)) {
            throw new Error(`Unknown deployment "${id}". Known deployments: ${known.join(', ')}`);
          }
        }
        if (baselineDeploymentId === candidateDeploymentId) {
          throw new Error('Pass two different deployments — comparing a release with itself says nothing.');
        }
        catchflyStore
          .getState()
          .setReleaseComparison({ baselineDeploymentId, candidateDeploymentId }, 'agent');
        return writeResult();
      },
    },

    {
      name: 'close_tool',
      title: 'Close the tool profile',
      description:
        'Close the tool profile and return the developer to the session list. The counterpart to ' +
        'open_tool, as close_case is to open_case. Returns the resulting state.' + SEES_AND_CAN_UNDO,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => {
        catchflyStore.getState().closeTool('agent');
        return writeResult();
      },
    },
  ];
}
