# `@catchfly/sdk`

Capture production WebMCP traces without making Catchfly part of the agent's critical path.
The SDK batches events in memory, retries delivery within a fixed budget, and reports terminal
delivery errors through `onError`.

## Automatic WebMCP tracing

Call `instrumentWebMCP` before your app registers its tools:

```ts
import { Catchfly, instrumentWebMCP } from '@catchfly/sdk';

const catchfly = new Catchfly({
  endpoint: 'https://catchfly.example.com',
  projectId: 'checkout',
  environmentId: 'production',
  apiKey: import.meta.env.VITE_CATCHFLY_INGEST_KEY,
  deployment: {
    id: import.meta.env.VITE_DEPLOYMENT_ID,
    appVersionId: import.meta.env.VITE_APP_VERSION,
  },
  onError: (error) => console.warn('Catchfly delivery failed', error),
});

const stopTracing = instrumentWebMCP(catchfly);
```

The wrapper records arguments and results, plus timing and thrown errors. It does not guess whether
the user's task succeeded. Automatic traces keep the task outcome unknown.

The ingest key is publishable and limited to telemetry writes. Restrict browser keys to your app's
origin in Catchfly. Never put an installation admin key or an `evals:write` key in application code.

Call `stopTracing()` when your app tears down. The SDK flushes queued events without inventing a
task outcome.

## Report a measured task outcome

Use the session API when your application knows whether the task succeeded:

```ts
const session = catchfly.startSession({
  model: 'gpt-5.6',
  intent: userRequest,
});

const callId = session.toolCalled({
  toolName: 'find_products',
  arguments: { query },
});

try {
  const result = await findProducts(query);
  session.toolCompleted({ callId, toolName: 'find_products', result, durationMs: 34 });
  session.complete();
} catch (error) {
  session.toolFailed({
    callId,
    toolName: 'find_products',
    errorType: error instanceof Error ? error.name : 'Error',
    errorMessage: error instanceof Error ? error.message : String(error),
  });
  session.fail({ failureTool: 'find_products' });
}
```

Use `session.abandon()` when the task ends without a measured success or failure. Configure
server-side redaction in Catchfly before sending production arguments or results.

## Delivery behavior

Events retry three times by default with exponential backoff and one idempotency key. Only network
errors, 408, 429 and 5xx responses are retried. A transiently failed batch returns to the in-memory
queue for the next flush; permanent 4xx failures are reported through `onError` and discarded.
Tune delivery with `maxRetries`, `retryBaseMs`, `batchSize`, `maxBatchBytes`, `flushIntervalMs`, and
`maxBufferSize`.

Call `await catchfly.shutdown()` during graceful server shutdown. Browser integrations normally
rely on the automatic size-bounded keepalive flush during `pagehide`. Delivery receipts with
partially rejected events are also surfaced through `onError`, including the server's rejection
reasons.
