/**
 * The one filter row.
 *
 * Filters live above everything they scope, never inside a chart card, so both
 * operators can see the slice every panel is rendering. Each control writes
 * through the same store action the agent's set_dashboard_filters tool calls.
 */

import { getDb } from '@catchfly/core/db.ts';
import { CATEGORY_LABELS, formatCount } from '@catchfly/core/labels.ts';
import { listAppVersions, listRuns, type CaseFilters } from '@catchfly/core/queries.ts';
import { FAILURE_CATEGORIES } from '@catchfly/core/types.ts';
import { summaryOnlyRuns } from '../data/load.ts';
import { useCatchflyStore } from '../state/store.ts';
import { useAgentTouch } from '../state/useAgentTouch.ts';

const FILTER_ACTIONS = ['set_filters', 'reset_filters'] as const;

const HIDDEN_FILTERS: Array<{ key: keyof CaseFilters; label: string }> = [
  { key: 'model', label: 'Model' },
  { key: 'toolCalled', label: 'Tool called' },
  { key: 'caseIds', label: 'Cases' },
];

function describe(value: CaseFilters[keyof CaseFilters]): string {
  if (Array.isArray(value)) return `${formatCount(value.length)} pinned`;
  return String(value);
}

export function FilterBar({ caseCount, rowCount }: { caseCount: number; rowCount: number }) {
  const filters = useCatchflyStore((state) => state.filters);
  const setFilters = useCatchflyStore((state) => state.setFilters);
  const resetFilters = useCatchflyStore((state) => state.resetFilters);
  const touch = useAgentTouch(FILTER_ACTIONS);
  const db = getDb();
  const active = Object.keys(filters).length > 0;
  const runs = listRuns(db);
  const pending = summaryOnlyRuns(runs.map((run) => run.runId)).length;
  const hidden = HIDDEN_FILTERS.filter((entry) => filters[entry.key] !== undefined);

  return (
    <div key={touch.key} className={`filterbar${touch.className}`}>
      <label className="field">
        <span>Run</span>
        <select
          value={filters.runId ?? ''}
          onChange={(event) => setFilters({ runId: event.target.value || undefined }, 'human')}
        >
          <option value="">
            {pending > 0 ? `Loaded runs (${runs.length - pending} of ${runs.length})` : 'All runs'}
          </option>
          {runs.map((run) => (
            <option key={run.runId} value={run.runId} title={run.runId}>
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
        <span>Failure mode</span>
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

      <div className="filterbar-tail">
        <span className="filterbar-count tabular">
          {formatCount(caseCount)} {caseCount === 1 ? 'case' : 'cases'}
          {rowCount !== caseCount ? ` · ${formatCount(rowCount)} rows` : ''}
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

      {hidden.length > 0 ? (
        <div className="filter-chips" aria-label="Filters set without a control">
          {hidden.map((entry) => (
            <button
              key={entry.key}
              type="button"
              className="filter-chip"
              onClick={() => setFilters({ [entry.key]: undefined }, 'human')}
              title={`Remove the ${entry.label.toLowerCase()} filter`}
            >
              <span className="filter-chip-label">{entry.label}</span>
              <span className="filter-chip-value">{describe(filters[entry.key])}</span>
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
