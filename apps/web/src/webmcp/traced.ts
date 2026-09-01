import { catchflyStore, type TraceEntry } from '../state/store.ts';
import type { ModelContextTool } from '@catchfly/webmcp/spec.ts';

let counter = 0;

function traceId(): string {
  counter += 1;
  return `call-${counter}-${Date.now().toString(36)}`;
}

function describe(input: Record<string, unknown> | undefined): string {
  const args = JSON.stringify(input ?? {});
  if (args === '{}') return '';
  return args.length > 80 ? `${args.slice(0, 80)}…` : args;
}

function settledKind(tool: ModelContextTool, result: unknown): TraceEntry['kind'] {
  if (tool.annotations?.destructiveHint !== true) return 'write';
  const pending = (result as { confirmationRequired?: boolean } | null)?.confirmationRequired === true;
  return pending ? 'write' : 'durable';
}

export function traced(tools: ModelContextTool[]): ModelContextTool[] {
  return tools.map((tool) => ({
    ...tool,
    execute: async (input) => {
      const id = traceId();
      const kind = tool.annotations?.readOnlyHint === true ? 'read' : 'write';
      const started = performance.now();
      catchflyStore.getState().beginToolCall({
        id,
        tool: tool.name,
        title: tool.title ?? tool.name,
        kind,
        summary: describe(input),
        at: new Date().toISOString(),
        status: 'pending',
      });
      try {
        const result = await tool.execute(input);
        catchflyStore.getState().finishToolCall(id, {
          status: 'ok',
          durationMs: Math.round(performance.now() - started),
          kind: kind === 'read' ? 'read' : settledKind(tool, result),
        });
        return result;
      } catch (error: unknown) {
        catchflyStore.getState().finishToolCall(id, {
          status: 'failed',
          durationMs: Math.round(performance.now() - started),
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
  }));
}
