/**
 * Briefly marks a panel that the agent just changed.
 *
 * Fully derived during render: the store already records who performed each
 * action and when, so this needs no state, effect or timer. The returned `key`
 * changes with the action's timestamp, which remounts the panel and replays the
 * one-shot CSS animation — including when two agent actions land in a row.
 *
 * The highlight signals authorship, not data, which is why it fades on its own.
 */

import { useCatchflyStore } from './store.ts';

export type AgentTouch = {
  /** Appended to the panel's className. */
  className: string;
  /** Spread as the element's key so the animation replays. */
  key?: string;
};

export function useAgentTouch(actionNames: readonly string[]): AgentTouch {
  const lastAction = useCatchflyStore((state) => state.lastAction);
  const touched = lastAction?.source === 'agent' && actionNames.includes(lastAction.name);
  return touched ? { className: ' agent-touched', key: lastAction.at } : { className: '' };
}
