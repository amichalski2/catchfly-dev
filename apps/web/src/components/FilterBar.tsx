/**
 * The one filter row.
 *
 * Filters live above everything they scope, never inside a chart card, so both
 * operators can see the slice every panel is rendering. Each control writes
 * through the same store action the agent's set_dashboard_filters tool calls.
 */

import { getDb } from '@catchfly/core/db.ts';
import { CATEGORY_LABELS } from '@catchfly/core/labels.ts';
import { listAppVersions, listRuns } from '@catchfly/core/queries.ts';
import { FAILURE_CATEGORIES } from '@catchfly/core/types.ts';
import { useCatchflyStore } from '../state/store.ts';
import { useAgentTouch } from '../state/useAgentTouch.ts';

const FILTER_ACTIONS = ['set_filters', 'reset_filters', 'create_segment'] as const;

export function FilterBar({ resultCount }: { resultCount: number }) {
  const filters = useCatchflyStore((state) => state.filters);
  const setFilters = useCatchflyStore((state) => state.setFilters);
  const resetFilters = useCatchflyStore((state) => state.resetFilters);
  const touch = useAgentTouch(FILTER_ACTIONS);
  const db = getDb();
  const active = Object.keys(filters).length > 0;

  return (
    <div key={touch.key} className={`filterbar${touch.className}`}>
      <label className="field">
        <span>Run</span>
        <select
          value={filters.runId ?? ''}
          onChange={(event) => setFilters({ runId: event.target.value || undefined }, 'human')}
        >
          <option value="">All runs</option>
          {listRuns(db).map((run) => (
            <option key={run.runId} value={run.runId}>
              {run.appVersionLabel} · {run.model}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span>Version</span>
        <select
          value={filters.appVersionId ?? ''}
          onChange={(event) =>
            setFilters({ appVersionId: event.target.value || undefined }, 'human')
          }
        >
          <option value="">Any</option>
          {listAppVersions(db).map((version) => (
            <option key={version.id} value={version.id}>
              {version.label}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span>Failure</span>
        <select
          value={filters.category ?? ''}
          onChange={(event) =>
            setFilters(
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
        <span>Outcome</span>
        <select
          value={filters.outcome ?? ''}
          onChange={(event) =>
            setFilters(
              { outcome: (event.target.value || undefined) as typeof filters.outcome },
              'human',
            )
          }
        >
          <option value="">Any</option>
          <option value="any-failure">Any failure</option>
          <option value="fail">Failed</option>
          <option value="error">Errored</option>
          <option value="pass">Passed at least once</option>
        </select>
      </label>

      <label className="field field-grow">
        <span>Search</span>
        <input
          type="search"
          placeholder="Case name or prompt"
          value={filters.search ?? ''}
          onChange={(event) => setFilters({ search: event.target.value || undefined }, 'human')}
        />
      </label>

      <span className="filterbar-count tabular">
        {resultCount.toLocaleString('en-US')} {resultCount === 1 ? 'case' : 'cases'}
      </span>

      <button
        type="button"
        className="btn btn-quiet"
        onClick={() => resetFilters('human')}
        disabled={!active}
      >
        Clear
      </button>
    </div>
  );
}
