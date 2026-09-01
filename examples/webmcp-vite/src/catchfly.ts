import { Catchfly, instrumentWebMCP } from '@catchfly/sdk';

export const catchfly = new Catchfly({
  endpoint: import.meta.env.VITE_CATCHFLY_ENDPOINT,
  projectId: import.meta.env.VITE_CATCHFLY_PROJECT,
  environmentId: import.meta.env.VITE_CATCHFLY_ENVIRONMENT,
  apiKey: import.meta.env.VITE_CATCHFLY_INGEST_KEY,
  deployment: {
    id: import.meta.env.VITE_CATCHFLY_DEPLOYMENT_ID,
    appVersionId: import.meta.env.VITE_CATCHFLY_APP_VERSION,
  },
  onError: (error) => console.error('[Catchfly]', error),
});

// Import this module before registering tools so every later registerTool call is wrapped.
export const stopCatchflyTracing = instrumentWebMCP(catchfly);
