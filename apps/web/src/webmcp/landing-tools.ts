import type { ModelContextTool } from '@catchfly/webmcp/spec.ts';

export type OpenDevpostAnalytics = () => void;

/** The one tool exposed by the public landing page. */
export function buildLandingTools(openDevpostAnalytics: OpenDevpostAnalytics): ModelContextTool[] {
  return [
    {
      name: 'open_devpost_analytics',
      title: 'Open Devpost analytics',
      description:
        'Open the Catchfly Devpost analytics workspace when the user wants to inspect the demo, ' +
        'analyze WebMCP eval regressions, compare releases, or explore agent sessions. This ' +
        'navigates the current page from the public Catchfly landing page to the interactive ' +
        'workspace; it does not modify any analytics data. Call this before attempting analytics ' +
        'tools, which register after the workspace opens.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => {
        openDevpostAnalytics();
        return {
          opening: true,
          destination: 'Catchfly Devpost analytics workspace',
          hint: 'Continue after the workspace finishes loading; its analytics tools will then be available.',
        };
      },
    },
  ];
}
