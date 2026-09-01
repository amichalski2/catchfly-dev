import type { Catchfly, CatchflySession } from './index.js';

type ToolExecute = (input: Record<string, unknown>) => Promise<unknown>;

export type InstrumentableTool = {
  name: string;
  execute: ToolExecute;
  [key: string]: unknown;
};

export type InstrumentableContext = {
  registerTool: (tool: InstrumentableTool, ...rest: unknown[]) => Promise<unknown>;
};

type Listenerish = {
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
};

const g = globalThis as {
  window?: Listenerish;
  document?: Listenerish & { visibilityState?: string; modelContext?: InstrumentableContext };
  navigator?: { modelContext?: InstrumentableContext };
};

function resolveContext(explicit?: InstrumentableContext): InstrumentableContext | null {
  if (explicit) return explicit;
  const candidates = [g.navigator?.modelContext, g.document?.modelContext];
  return candidates.find((context) => typeof context?.registerTool === 'function') ?? null;
}

export function instrumentWebMCP(client: Catchfly, context?: InstrumentableContext): () => void {
  const target = resolveContext(context);
  if (!target) return () => {};

  let session: CatchflySession | null = null;
  const ensureSession = (): CatchflySession => {
    session ??= client.startSession({ agent: 'webmcp' });
    return session;
  };
  const flush = (): void => {
    void client.flush();
  };

  const wrap = (tool: InstrumentableTool): InstrumentableTool => ({
    ...tool,
    execute: async (input: Record<string, unknown>) => {
      const active = ensureSession();
      const callId = active.toolCalled({ toolName: tool.name, arguments: input });
      const startedAt = Date.now();
      try {
        const result = await tool.execute(input);
        active.toolCompleted({
          callId,
          toolName: tool.name,
          result,
          durationMs: Date.now() - startedAt,
        });
        return result;
      } catch (error) {
        active.toolFailed({
          callId,
          toolName: tool.name,
          durationMs: Date.now() - startedAt,
          errorType: error instanceof Error ? error.name : 'Error',
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
  });

  const originalRegisterTool = target.registerTool.bind(target);
  target.registerTool = (tool, ...rest) => originalRegisterTool(wrap(tool), ...rest);

  const onPageHide = (): void => {
    // WebMCP exposes tool execution, not whether the user's task succeeded.
    // Flush the trace, but leave its outcome unknown instead of inventing a
    // task.completed event when a tab closes or navigates away.
    session = null;
    flush();
  };
  const onVisibilityChange = (): void => {
    if (!g.document || g.document.visibilityState === 'hidden') flush();
  };
  g.window?.addEventListener('pagehide', onPageHide);
  g.document?.addEventListener('visibilitychange', onVisibilityChange);

  return () => {
    target.registerTool = originalRegisterTool;
    g.window?.removeEventListener('pagehide', onPageHide);
    g.document?.removeEventListener('visibilitychange', onVisibilityChange);
    session = null;
    flush();
  };
}
