/**
 * The filter row for production sessions.
 *
 * Deliberately the same shape as FilterBar: one row above everything it scopes,
 * every control writing through the store action the agent's
 * `set_session_filters` tool also calls. A reviewer and an agent narrowing the
 * same list end up in the same place.
 */

import { getDb } from '@catchfly/core/db.ts';
import { CATEGORY_LABELS, formatCount } from '@catchfly/core/labels.ts';
import type { DeploymentRollup, SessionFilters } from '@catchfly/core/session-types.ts';
import { FAILURE_CATEGORIES } from '@catchfly/core/types.ts';

import { useCatchflyStore } from '../state/store.ts';
import { useAgentTouch } from '../state/useAgentTouch.ts';

const FILTER_ACTIONS = ['set_session_filters', 'reset_session_filters'] as const;

const HIDDEN_FILTERS: Array<{ key: keyof SessionFilters; label: string }> = [
  { key: 'environment', label: 'Environment' },
  { key: 'from', label: 'From' },
  { key: 'to', label: 'To' },
];

const TOOL_LIST_ID = 'session-tool-names';

export function SessionFilterBar({
  deployments,
  resultCount,
}: {
  deployments: DeploymentRollup[];
  resultCount: number | null;
}) {
  const filters = useCatchflyStore((state) => state.sessionFilters);
  const setSessionFilters = useCatchflyStore((state) => state.setSessionFilters);
  const resetSessionFilters = useCatchflyStore((state) => state.resetSessionFilters);
  const touch = useAgentTouch(FILTER_ACTIONS);
  const active = Object.keys(filters).length > 0;
  const hidden = HIDDEN_FILTERS.filter((entry) => filters[entry.key] !== undefined);
  const toolNames = [
    ...new Set(
      getDb().dataset.project.appVersions.flatMap((version) =>
        version.toolManifest.map((tool) => tool.name),
      ),
    ),
  ].sort();

  return (
    <div key={touch.key} className={`filterbar${touch.className}`}>
      <label className="field">
        <span>Deployment</span>
        <select
          value={filters.deploymentId ?? ''}
          onChange={(event) => setSessionFilters({ deploymentId: event.target.value || undefined }, 'human')}
        >
          <option value="">All deployments</option>
          {deployments.map((deployment) => (
            <option key={deployment.id} value={deployment.id}>
              {deployment.appVersionId} · {deployment.id}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span>Outcome</span>
        <select
          value={filters.outcome ?? ''}
          onChange={(event) =>
            setSessionFilters(
              { outcome: (event.target.value || undefined) as SessionFilters['outcome'] },
              'human',
            )
          }
        >
          <option value="">Any</option>
          <option value="any-failure">Any failure</option>
          <option value="failed">Failed</option>
          <option value="abandoned">Abandoned</option>
          <option value="completed">Completed</option>
          <option value="unknown">Unknown</option>
        </select>
      </label>

      <label className="field">
        <span>Failure mode</span>
        <select
          value={filters.category ?? ''}
          onChange={(event) =>
            setSessionFilters(
              {
                category: event.target.value
                  ? (event.target.value as (typeof FAILURE_CATEGORIES)[number])
                  : undefined,
              },
              'human',
            )
          }
        >
          <option value="">Any</option>
          {FAILURE_CATEGORIES.map((category) => (
            <option key={category} value={category}>
              {CATEGORY_LABELS[category]}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span>Tool called</span>
        <input
          type="search"
          list={toolNames.length > 0 ? TOOL_LIST_ID : undefined}
          placeholder="Any tool"
          value={filters.toolCalled ?? ''}
          onChange={(event) => setSessionFilters({ toolCalled: event.target.value || undefined }, 'human')}
        />
        {toolNames.length > 0 ? (
          <datalist id={TOOL_LIST_ID}>
            {toolNames.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        ) : null}
      </label>

      <label className="field field-grow">
        <span>Search</span>
        <input
          type="search"
          placeholder="Intent or tool name"
          value={filters.search ?? ''}
          onChange={(event) => setSessionFilters({ search: event.target.value || undefined }, 'human')}
        />
      </label>

      <div className="filterbar-tail">
        <span className="filterbar-count tabular">
          {resultCount === null ? '—' : formatCount(resultCount)}{' '}
          {resultCount === 1 ? 'session' : 'sessions'}
        </span>

        <button
          type="button"
          className="btn btn-quiet"
          onClick={() => resetSessionFilters('human')}
          disabled={!active}
        >
          Clear
        </button>
      </div>

      {hidden.length > 0 ? (
        <div className="filter-chips" aria-label="Filters set without a control">
          {hidden.map((entry) => (
            <button
              key={entry.key}
              type="button"
              className="filter-chip"
              onClick={() => setSessionFilters({ [entry.key]: undefined }, 'human')}
              title={`Remove the ${entry.label.toLowerCase()} filter`}
            >
              <span className="filter-chip-label">{entry.label}</span>
              <span className="filter-chip-value">{String(filters[entry.key])}</span>
              <span className="filter-chip-remove" aria-hidden="true">
                ×
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
