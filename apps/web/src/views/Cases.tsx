/**
 * Cases — every eval case, filterable.
 *
 * The filter row is the whole point of this view: it is the surface the agent's
 * set_dashboard_filters tool moves, and the one place a human can see exactly
 * which slice both operators are looking at.
 */

import { useState } from 'react';

import { getDb } from '@catchfly/core/db.ts';
import { formatCount } from '@catchfly/core/labels.ts';

import { CaseComposition } from '../components/CaseComposition.tsx';
import { CaseTable } from '../components/CaseTable.tsx';
import { FilterBar } from '../components/FilterBar.tsx';
import { summaryOnlyRuns } from '../data/load.ts';
import { useSelector, visibleCases } from '../state/selectors.ts';
import { useCatchflyStore } from '../state/store.ts';
import { useAgentTouch } from '../state/useAgentTouch.ts';
import { useComparisonEvidence } from '../state/useComparisonEvidence.ts';
import '../styles/cases.css';

const FILTER_ACTIONS = ['set_filters', 'reset_filters'] as const;

const PAGE_SIZE = 10;

export function Cases() {
  // Subscribing to datasetVersion re-renders this view after an import; the
  // selectors then recompute because the store handed out a new state object.
  useCatchflyStore((state) => state.datasetVersion);
  const rows = useSelector(visibleCases);
  const filters = useCatchflyStore((state) => state.filters);
  const openCase = useCatchflyStore((state) => state.openCase);
  const setFilters = useCatchflyStore((state) => state.setFilters);
  const setView = useCatchflyStore((state) => state.setView);
  const touch = useAgentTouch(FILTER_ACTIONS);
  const runCount = getDb().dataset.runs.length;
  const pendingRuns = summaryOnlyRuns(getDb().dataset.runs.map((run) => run.id)).length;
  const loadedRuns = runCount - pendingRuns;
  const evidence = useComparisonEvidence();
  const [paging, setPaging] = useState({ slice: '', page: 1 });

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

  const slice = JSON.stringify(filters);
  const pageCount = Math.max(Math.ceil(rows.length / PAGE_SIZE), 1);
  const page = paging.slice === slice ? Math.min(paging.page, pageCount) : 1;
  const from = (page - 1) * PAGE_SIZE;
  const shown = rows.slice(from, from + PAGE_SIZE);
  const goTo = (next: number) => setPaging({ slice, page: Math.min(Math.max(next, 1), pageCount) });

  return (
    <div className="stack cases-view">
      <FilterBar caseCount={new Set(rows.map((row) => row.caseId)).size} rowCount={rows.length} />

      <section className="panel composition-panel">
        <div className="panel-head">
          <div>
            <h2>What the suite is made of</h2>
            <p className="muted">Every case once, by its most frequent failure mode across loaded runs.</p>
          </div>
        </div>
        <div className="panel-body">
          <CaseComposition
            rows={rows}
            activeCategory={filters.category}
            onSelect={(category) => setFilters({ category }, 'human')}
          />
        </div>
      </section>

      <section key={touch.key} className={`panel catalogue-panel${touch.className}`}>
        <div className="panel-head">
          <div>
            <h2>The catalogue</h2>
            <p className="muted">One row per case and run. Open a row to read its attempts.</p>
          </div>
        </div>
        <div className="panel-body">
          {pendingRuns > 0 ? (
            <p className="table-note">
              Attempts loaded for {loadedRuns} of {runCount} runs; the rest stay summary-only until
              a comparison needs them.
            </p>
          ) : null}
          <CaseTable rows={shown} onOpenCase={(caseId) => openCase(caseId, 'human')} />

          {rows.length > 0 ? (
            <div className="pager">
              <span className="pager-status">
                {formatCount(from + 1)}–{formatCount(Math.min(from + PAGE_SIZE, rows.length))} of{' '}
                {formatCount(rows.length)}
              </span>
              <span className="pager-steps">
                <button
                  type="button"
                  className="btn btn-quiet"
                  disabled={page === 1}
                  onClick={() => goTo(page - 1)}
                >
                  Previous
                </button>
                <span className="pager-page">
                  Page {page} of {pageCount}
                </span>
                <button
                  type="button"
                  className="btn btn-quiet"
                  disabled={page === pageCount}
                  onClick={() => goTo(page + 1)}
                >
                  Next
                </button>
              </span>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}
