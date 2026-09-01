/**
 * Cases — every eval case, filterable.
 *
 * The filter row is the whole point of this view: it is the surface the agent's
 * set_dashboard_filters tool moves, and the one place a human can see exactly
 * which slice both operators are looking at.
 */

import { getDb } from '@catchfly/core/db.ts';

import { CaseTable } from '../components/CaseTable.tsx';
import { FilterBar } from '../components/FilterBar.tsx';
import { summaryOnlyRuns } from '../data/load.ts';
import { useSelector, visibleCases } from '../state/selectors.ts';
import { useCatchflyStore } from '../state/store.ts';
import { useAgentTouch } from '../state/useAgentTouch.ts';
import { useComparisonEvidence } from '../state/useComparisonEvidence.ts';

const FILTER_ACTIONS = ['set_filters', 'reset_filters', 'create_segment'] as const;

export function Cases() {
  // Subscribing to datasetVersion re-renders this view after an import; the
  // selectors then recompute because the store handed out a new state object.
  useCatchflyStore((state) => state.datasetVersion);
  const rows = useSelector(visibleCases);
  const filters = useCatchflyStore((state) => state.filters);
  const segments = useCatchflyStore((state) => state.segments);
  const openCase = useCatchflyStore((state) => state.openCase);
  const setFilters = useCatchflyStore((state) => state.setFilters);
  const setView = useCatchflyStore((state) => state.setView);
  const touch = useAgentTouch(FILTER_ACTIONS);
  const runCount = getDb().dataset.runs.length;
  const pendingRuns = summaryOnlyRuns(getDb().dataset.runs.map((run) => run.id)).length;
  const loadedRuns = runCount - pendingRuns;
  const evidence = useComparisonEvidence();

  if (runCount === 0) {
    return (
      <section className="panel">
        <div className="panel-body empty-good">
          <strong>No eval runs yet.</strong> Run the Chrome WebMCP suite from CI, then Catchfly will
          keep the cases and attempts here.{' '}
          <button type="button" className="linkish" onClick={() => setView('sources', 'human')}>
            Open Connection
          </button>
        </div>
      </section>
    );
  }

  if (evidence.error) return <p className="boot-error">Could not load case evidence: {evidence.error}</p>;
  if (!evidence.ready) return <section className="panel"><div className="panel-body muted">Loading cases for the selected comparison…</div></section>;

  return (
    <div className="stack">
      <FilterBar resultCount={rows.length} />

      {segments.length > 0 ? (
        <div className="segments">
          <span className="eyebrow">Saved segments</span>
          {segments.map((segment) => (
            <button
              key={segment.id}
              type="button"
              className="chip chip-button"
              onClick={() => setFilters(segment.filters, 'human')}
            >
              {segment.name}
              {segment.createdBy === 'agent' ? <span className="who who-agent">Agent</span> : null}
            </button>
          ))}
        </div>
      ) : null}

      <section key={touch.key} className={`panel${touch.className}`}>
        <div className="panel-body">
          {pendingRuns > 0 ? (
            <p className="table-note">
              Attempts are loaded for {loadedRuns} of {runCount} runs — the rest are summary-only
              until a comparison needs them. Open an incident from Incidents, or pick a pair in the
              Regression Explorer, to load another.
            </p>
          ) : Object.keys(filters).length === 0 ? (
            <p className="table-note">
              Showing every case across {runCount === 1 ? 'the one run' : `all ${runCount} runs`}.
              {runCount > 1 ? ' Pick a run to compare like for like.' : ''}
            </p>
          ) : null}
          <CaseTable rows={rows} onOpenCase={(caseId) => openCase(caseId, 'human')} />
        </div>
      </section>
    </div>
  );
}
