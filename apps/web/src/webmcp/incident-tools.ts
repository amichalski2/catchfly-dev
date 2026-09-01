import { isSessionsAvailable, sessionsSource } from '@catchfly/core/sessions-db.ts';
import { incidentOverviewPayload } from '@catchfly/webmcp/payloads.ts';
import type { ModelContextTool } from '@catchfly/webmcp/spec.ts';

import { fetchIncidentOverview } from '../data/api.ts';
import { catchflyStore } from '../state/store.ts';
import { asString, describeSharedState } from './tools.ts';

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
        'carries the run pair to hand to find_regressions and the app-version pair behind ' +
        'compare_deployments, so this collapses the first three hops of an investigation. ' +
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
        'for the worst-hit tools. This is the production counterpart to set_comparison, which ' +
        'does the same for eval runs. Returns the resulting shared state.',
      inputSchema: {
        type: 'object',
        properties: {
          baselineDeploymentId: { type: 'string', description: 'See list_deployments.' },
          candidateDeploymentId: { type: 'string', description: 'See list_deployments.' },
        },
        required: ['baselineDeploymentId', 'candidateDeploymentId'],
        additionalProperties: false,
      },
      execute: async (input) => {
        const baselineDeploymentId = asString(input, 'baselineDeploymentId');
        const candidateDeploymentId = asString(input, 'candidateDeploymentId');
        if (!isSessionsAvailable()) {
          throw new Error(
            'This deployment has no production session data, so releases cannot be compared — ' +
              'the eval tools still work. Do not retry.',
          );
        }
        const known = (await sessionsSource().listDeployments()).map((entry) => entry.id);
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
        return describeSharedState();
      },
    },

    {
      name: 'close_tool',
      title: 'Close the tool profile',
      description:
        'Close the tool profile and return the developer to the session list. The counterpart to ' +
        'open_tool, as close_case is to open_case.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => {
        catchflyStore.getState().closeTool('agent');
        return describeSharedState();
      },
    },
  ];
}
