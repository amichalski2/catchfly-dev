import { Catchfly } from '../packages/sdk/src/index.ts';
import type { TelemetryEvent } from '@catchfly/core/product-types.ts';

import { parseTelemetryEvent, redactEvent } from '../netlify/functions/lib/telemetry.ts';

const failures: string[] = [];
const check = (label: string, ok: boolean): void => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) failures.push(label);
};

console.log('\nTelemetry contract');
const event: TelemetryEvent = {
  schemaVersion: '1',
  eventId: 'evt-1',
  sessionId: 'ses-1',
  sequence: 0,
  type: 'session.started',
  occurredAt: '2026-09-01T12:00:00.000Z',
  payload: { deploymentId: 'dep-1', appVersionId: 'v1', intent: 'Buy shoes' },
};
check('accepts a valid session event', !('error' in parseTelemetryEvent(event, 0)));
check('rejects a missing deployment', 'error' in parseTelemetryEvent({ ...event, payload: {} }, 0));

const redacted = redactEvent({
  ...event,
  type: 'tool.called',
  payload: { toolName: 'checkout', arguments: { authorization: 'Bearer secret', email: 'a@b.test', nested: { api_key: 'secret' } } },
}, [{ path: 'payload.arguments.email', action: 'mask' }]);
check('applies safe default redaction', !('authorization' in (redacted.payload.arguments ?? {})));
check('applies project redaction', redacted.payload.arguments?.email === '[REDACTED]');
check('masks nested secrets by key name', (redacted.payload.arguments?.nested as { api_key?: string })?.api_key === '[REDACTED]');

console.log('\nSDK batching');
const requests: Array<{ url: string; body: { events: TelemetryEvent[] } }> = [];
const sdk = new Catchfly({
  endpoint: 'https://catchfly.test/',
  projectId: 'shop',
  environmentId: 'production',
  apiKey: 'secret',
  batchSize: 10,
  flushIntervalMs: 60_000,
  deployment: { id: 'deploy-1', appVersionId: 'v1' },
  fetch: (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) as { events: TelemetryEvent[] } });
    return new Response('{}', { status: 202 });
  }) as typeof fetch,
});
const session = sdk.startSession({ id: 'ses-sdk', model: 'gpt-test', intent: 'Test the SDK' });
const callId = session.toolCalled({ toolName: 'search', arguments: { query: 'shoes' } });
session.toolCompleted({ callId, toolName: 'search', result: { matches: 2 }, durationMs: 12 });
session.complete();
await sdk.shutdown();
check('sends one batch', requests.length === 1);
check('normalizes the endpoint URL', requests[0]?.url === 'https://catchfly.test/api/v1/projects/shop/events');
check('sends a complete ordered trace', requests[0]?.body.events.map((entry) => entry.type).join(',') ===
  'session.started,tool.called,tool.completed,task.completed');

console.log('\nSDK retry bounds');
const retryKeys: string[] = [];
let retryAttempts = 0;
const retrySdk = new Catchfly({
  endpoint: 'https://catchfly.test', projectId: 'shop', environmentId: 'production', apiKey: 'secret',
  batchSize: 10, flushIntervalMs: 60_000, maxRetries: 2, retryBaseMs: 50,
  deployment: { id: 'deploy-1', appVersionId: 'v1' },
  fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
    retryAttempts += 1;
    retryKeys.push(new Headers(init?.headers).get('idempotency-key') ?? '');
    return new Response('{}', { status: retryAttempts < 3 ? 503 : 202 });
  }) as typeof fetch,
});
retrySdk.startSession({ id: 'ses-retry' }).complete();
await retrySdk.shutdown();
check('retries transient failures up to the configured bound', retryAttempts === 3);
check('uses one idempotency key across retries', new Set(retryKeys).size === 1 && retryKeys[0].startsWith('batch_'));

let terminalError = '';
const failingSdk = new Catchfly({
  endpoint: 'https://catchfly.test', projectId: 'shop', environmentId: 'production', apiKey: 'secret',
  batchSize: 10, flushIntervalMs: 60_000, maxRetries: 0,
  deployment: { id: 'deploy-1', appVersionId: 'v1' },
  fetch: (async () => new Response('{}', { status: 503 })) as typeof fetch,
  onError: (error) => { terminalError = error.message; },
});
failingSdk.startSession({ id: 'ses-terminal' }).complete();
await failingSdk.shutdown();
check('shutdown completes after a terminal delivery failure', terminalError.includes('503'));

if (failures.length > 0) {
  console.error(`\n${failures.length} telemetry check(s) failed.`);
  process.exit(1);
}
console.log('\nAll telemetry checks passed.\n');
