/**
 * Types for the WebMCP API surface Catchfly targets, transcribed from the
 * WebMCP specification (https://webmachinelearning.github.io/webmcp/):
 *
 *   - the entry point is `document.modelContext` (SecureContext),
 *   - `registerTool(tool, { signal })` resolves on successful registration,
 *   - unregistration is signal-based: aborting the signal removes the tool and
 *     rejects the registration promise,
 *   - `execute` may resolve with any JSON-serializable value; a rejection is
 *     reported to the agent as a tool error.
 *
 * Types only, deliberately: this module carries no reference to `document`, so
 * the tool definitions can be exercised outside a browser.
 */

/** Whether this browser exposes WebMCP to the page. */
export type WebMcpStatus = 'unsupported' | 'registering' | 'active' | 'degraded';

export type ToolAnnotations = {
  readOnlyHint?: boolean;
  untrustedContentHint?: boolean;
  destructiveHint?: boolean;
};

export type ToolExecuteCallback = (input: Record<string, unknown>) => Promise<unknown>;

export type ModelContextTool = {
  name: string;
  description: string;
  title?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: ToolAnnotations;
  execute: ToolExecuteCallback;
};

export type ModelContextRegisterToolOptions = {
  signal?: AbortSignal;
};

export type ModelContext = {
  registerTool: (
    tool: ModelContextTool,
    options?: ModelContextRegisterToolOptions,
  ) => Promise<undefined>;
};
