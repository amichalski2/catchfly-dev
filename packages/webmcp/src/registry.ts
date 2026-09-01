/**
 * Registration plumbing: registers a group of tools under one AbortController,
 * so a whole group (e.g. the case-detail tools) can be revoked in a single
 * abort — the mechanism the spec defines for unregistration.
 */

import type { ModelContext, ModelContextTool } from '@catchfly/webmcp/spec.ts';

export type GroupOutcome = {
  /** Tools this browser refused. The page reports a partial surface rather than claiming a whole one. */
  failed: number;
};

export type ToolGroup = {
  /** Revokes every tool in the group. Safe to call more than once. */
  revoke: () => void;
  /**
   * Resolves once the browser has had its say: every registration settled, or
   * the grace window passed with no refusal. A registration promise is also the
   * unregistration handle, so a tool the browser accepted leaves it pending for
   * as long as the tool lives — waiting for all of them to resolve would wait
   * forever. A refusal, by contrast, arrives immediately.
   */
  settled: Promise<GroupOutcome>;
};

/** How long a browser gets to refuse a tool before the group counts as registered. */
const SETTLE_GRACE_MS = 150;

export function registerToolGroup(context: ModelContext, tools: ModelContextTool[]): ToolGroup {
  const controller = new AbortController();
  let failed = 0;
  let outstanding = tools.length;
  let announce: (outcome: GroupOutcome) => void = () => {};
  const settled = new Promise<GroupOutcome>((resolve) => {
    announce = resolve;
  });
  const finish = (): void => announce({ failed });

  for (const tool of tools) {
    context.registerTool(tool, { signal: controller.signal }).then(
      () => {
        outstanding -= 1;
        if (outstanding === 0) finish();
      },
      (error: unknown) => {
        // Aborting the signal is the documented way to unregister; the AbortError
        // rejection it causes is expected, not a failure.
        if (!(error instanceof Error && error.name === 'AbortError')) {
          console.error(`WebMCP: failed to register tool "${tool.name}"`, error);
          failed += 1;
        }
        outstanding -= 1;
        if (outstanding === 0) finish();
      },
    );
  }

  if (tools.length === 0) finish();
  else setTimeout(finish, SETTLE_GRACE_MS);

  return {
    revoke: () => controller.abort(),
    settled,
  };
}
