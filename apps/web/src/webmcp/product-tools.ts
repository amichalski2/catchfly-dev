import type { ModelContextTool } from '@catchfly/webmcp/spec.ts';

import { fetchProjectOverview, fetchSourceHealth } from '../data/api.ts';
import { catchflyStore } from '../state/store.ts';
import { SEES_AND_CAN_UNDO, writeResult } from './tools.ts';

export function buildProductTools(): ModelContextTool[] {
  return [
    {
      name: 'get_source_health',
      title: 'Check source health',
      description:
        'Read whether each environment is sending telemetry: last event and batch times, accepted, ' +
        'duplicate and rejected counts, and active project keys. Start here when data looks missing or stale.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
      execute: async () => fetchSourceHealth(catchflyStore.getState().projectId),
    },
    {
      name: 'get_operational_overview',
      title: 'Read the ops overview',
      description:
        'Read the measured project health: telemetry freshness, outcome coverage, task success, tool ' +
        'execution success, latest eval movement and deterministic findings. Unknown outcomes stay separate.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
      execute: async () => fetchProjectOverview(catchflyStore.getState().projectId),
    },
    {
      name: 'open_sources',
      title: 'Open Connection settings',
      description:
        'Open Project settings → Connection, where the developer connects runtime telemetry and ' +
        'CI eval keys. Returns the resulting state.' + SEES_AND_CAN_UNDO,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => {
        catchflyStore.getState().setView('sources', 'agent');
        return writeResult();
      },
    },
    {
      name: 'open_data_settings',
      title: 'Open data settings',
      description:
        'Open the shared data-policy settings. This only navigates; it never changes collection ' +
        'rules. Returns the resulting state.' + SEES_AND_CAN_UNDO,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => {
        catchflyStore.getState().setView('settings', 'agent');
        return writeResult();
      },
    },
    {
      name: 'open_system_health',
      title: 'Open system health',
      description:
        'Open the installation health view for database readiness and migration state. ' +
        'Returns the resulting state.' + SEES_AND_CAN_UNDO,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => {
        catchflyStore.getState().setView('system', 'agent');
        return writeResult();
      },
    },
  ];
}
