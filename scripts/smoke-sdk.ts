import { Catchfly, instrumentWebMCP, type InstrumentableTool } from '../packages/sdk/src/index.ts';

const failures: string[] = [];
function check(label: string, condition: boolean, detail = ''): void {
  const status = condition ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  ${status} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures.push(label);
}

type SentEvent = { type: string; sessionId: string; sequence: number };

const sent: SentEvent[] = [];
const fakeFetch: typeof fetch = async (_url, init) => {
  const body = JSON.parse(String(init?.body)) as { events: SentEvent[] };
  sent.push(...body.events);
  return new Response(JSON.stringify({ accepted: body.events.length }), { status: 202 });
};

class FakeModelContext {
  readonly tools = new Map<string, InstrumentableTool>();

  registerTool(tool: InstrumentableTool): Promise<undefined> {
    this.tools.set(tool.name, tool);
    return Promise.resolve(undefined);
  }

  call(name: string, input: Record<string, unknown>): Promise<unknown> {
    return this.tools.get(name)!.execute(input);
  }
}

console.log('\n\x1b[1minstrumentWebMCP\x1b[0m');

const context = new FakeModelContext();
const client = new Catchfly({
  endpoint: 'http://smoke.local',
  projectId: 'smoke',
  environmentId: 'production',
  apiKey: 'cfly_smoke.key',
  fetch: fakeFetch,
});

const unpatch = instrumentWebMCP(client, context);

await context.registerTool({
  name: 'find_item',
  execute: async (input) => ({ found: input.query }),
});
await context.registerTool({
  name: 'explode',
  execute: async () => {
    throw new Error('boom');
  },
});

const result = (await context.call('find_item', { query: 'roses' })) as { found: string };
check('the wrapped tool still returns its result', result.found === 'roses');

let thrown = '';
try {
  await context.call('explode', {});
} catch (error) {
  thrown = error instanceof Error ? error.message : String(error);
}
check('the wrapped tool still throws', thrown === 'boom');

unpatch();
await client.flush();

const types = sent.map((event) => event.type);
check(
  'events arrive in order',
  types.join(' → ') ===
    'session.started → tool.called → tool.completed → tool.called → tool.failed → task.completed',
  types.join(' → '),
);
check('every event shares one session', new Set(sent.map((event) => event.sessionId)).size === 1);
check(
  'sequences are gapless',
  sent.every((event, index) => event.sequence === index),
);

const raw: InstrumentableTool = { name: 'raw', execute: async () => 'untouched' };
await context.registerTool(raw);
check('unpatch restores the original registerTool', context.tools.get('raw') === raw);

await client.shutdown();

if (failures.length > 0) {
  console.error(`\n\x1b[31m${failures.length} check(s) failed:\x1b[0m`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('\n\x1b[32mAll SDK instrumentation checks passed.\x1b[0m');
