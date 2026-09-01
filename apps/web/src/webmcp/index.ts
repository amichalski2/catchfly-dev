/**
 * Wires Catchfly's WebMCP surface to the page.
 *
 * Global tools are registered as soon as the page has a model context. Case-
 * scoped tools track the shared state: registered when a case becomes selected,
 * revoked (via the spec's AbortSignal mechanism) when the selection clears — by
 * either operator. The registry the agent sees is itself a function of
 * application state.
 *
 * Support is *watched for*, not sampled once. A browser may install
 * `document.modelContext` after the page's own scripts have run, and a single
 * check at boot would then report "unsupported" forever. Callers get a status
 * callback instead of a return value so the UI can correct itself if the API
 * turns up late.
 */

import { whenDbReady } from '@catchfly/core/db.ts';
import { whenSessionsSettled } from '@catchfly/core/sessions-db.ts';
import { catchflyStore } from '../state/store.ts';
import { buildCaseTools } from './case-tools.ts';
import { buildIncidentTools } from './incident-tools.ts';
import { buildLandingTools, type OpenDevpostAnalytics } from './landing-tools.ts';
import { buildSessionScopedTools } from './session-scoped-tools.ts';
import { buildSessionTools } from './session-tools.ts';
import { buildProductTools } from './product-tools.ts';
import { traced } from './traced.ts';
import { registerToolGroup, type ToolGroup } from '@catchfly/webmcp/registry.ts';
import type { ModelContext, ModelContextTool, WebMcpStatus } from '@catchfly/webmcp/spec.ts';
import { buildGlobalTools } from './tools.ts';

declare global {
  interface Document {
    readonly modelContext?: ModelContext;
  }
}

export type { WebMcpStatus };

/** How long to keep watching for a late-installed model context. */
const WATCH_WINDOW_MS = 10_000;
const WATCH_INTERVAL_MS = 250;

/** The page's WebMCP entry point, or null in a browser without support. */
function getModelContext(): ModelContext | null {
  return typeof document.modelContext?.registerTool === 'function' ? document.modelContext : null;
}

/**
 * Tools are registered before the dataset finishes downloading, so a browser
 * that reads the tool list at page load finds a complete surface. An agent that
 * calls one during that window waits for the data rather than getting an error.
 */
function gated(tools: ModelContextTool[]): ModelContextTool[] {
  return tools.map((tool) => ({
    ...tool,
    execute: async (input) => {
      await whenDbReady();
      return tool.execute(input);
    },
  }));
}

/**
 * The same idea for the session tools, but waiting on the session registry.
 * Both terminal states settle it — configured, or declared unavailable — so
 * this resolves on a deployment with no database rather than waiting forever.
 */
function sessionGated(tools: ModelContextTool[]): ModelContextTool[] {
  return tools.map((tool) => ({
    ...tool,
    execute: async (input) => {
      await whenDbReady();
      await whenSessionsSettled();
      return tool.execute(input);
    },
  }));
}

async function attach(context: ModelContext): Promise<Exclude<WebMcpStatus, 'unsupported' | 'registering'>> {
  const boot = [
    registerToolGroup(context, traced(gated(buildGlobalTools()))),
    registerToolGroup(context, traced(gated(buildProductTools()))),
    registerToolGroup(context, traced(sessionGated(buildIncidentTools()))),
    // Session tools wait on the session registry rather than the dataset: a
    // deployment without a database settles it as unavailable, and the tools then
    // say so immediately instead of hanging.
    registerToolGroup(context, traced(sessionGated(buildSessionTools()))),
  ];

  /** Registers a group while `active` holds, revokes it when it stops. */
  const scope = (active: () => boolean, build: () => ModelContextTool[], gate: typeof gated): ((now: boolean) => void) => {
    let group: ToolGroup | null = null;
    const sync = (now: boolean): void => {
      if (now && !group) group = registerToolGroup(context, traced(gate(build())));
      else if (!now && group) {
        group.revoke();
        group = null;
      }
    };
    sync(active());
    return sync;
  };

  const syncCaseTools = scope(
    () => catchflyStore.getState().selectedCaseId !== null,
    buildCaseTools,
    gated,
  );
  const syncSessionTools = scope(
    () => catchflyStore.getState().selectedSessionId !== null,
    buildSessionScopedTools,
    sessionGated,
  );

  catchflyStore.subscribe((state, previous) => {
    const caseSelected = state.selectedCaseId !== null;
    if (caseSelected !== (previous.selectedCaseId !== null)) syncCaseTools(caseSelected);
    const sessionSelected = state.selectedSessionId !== null;
    if (sessionSelected !== (previous.selectedSessionId !== null)) syncSessionTools(sessionSelected);
  });

  const settled = await Promise.all(boot.map((group) => group.settled));
  return settled.some((group) => group.failed > 0) ? 'degraded' : 'active';
}

function watchForModelContext(
  attachContext: (context: ModelContext) => Promise<WebMcpStatus>,
  onStatus: (status: WebMcpStatus) => void,
): void {
  const begin = (context: ModelContext): void => {
    onStatus('registering');
    void attachContext(context).then(onStatus);
  };

  const immediate = getModelContext();
  if (immediate) {
    begin(immediate);
    return;
  }

  onStatus('unsupported');

  const deadline = Date.now() + WATCH_WINDOW_MS;
  const timer = setInterval(() => {
    const context = getModelContext();
    if (context) {
      clearInterval(timer);
      begin(context);
      return;
    }
    if (Date.now() > deadline) clearInterval(timer);
  }, WATCH_INTERVAL_MS);
}

/**
 * Registers the tool surface, reporting status as it settles: 'unsupported'
 * immediately when the API is absent, then 'registering' once a context turns
 * up, and finally 'active' or 'degraded' when every tool has been acknowledged
 * or refused.
 */
export function initWebMcp(onStatus: (status: WebMcpStatus) => void): void {
  watchForModelContext(attach, onStatus);
}

/** Registers the landing page's single hand-off tool without loading dashboard data. */
export function initLandingWebMcp(
  openDevpostAnalytics: OpenDevpostAnalytics,
  onStatus: (status: WebMcpStatus) => void,
): void {
  watchForModelContext(
    async (context) => {
      const group = registerToolGroup(context, buildLandingTools(openDevpostAnalytics));
      return (await group.settled).failed > 0 ? 'degraded' : 'active';
    },
    onStatus,
  );
}
