/**
 * Regression Explorer — what broke, ignoring what was already broken.
 *
 * The run pair is a control, not a fixed heading: comparing v43 against v44 is
 * how the demo shows the fix landing, and the agent's set_comparison tool drives
 * exactly the same state.
 */


import { CaseField } from '../components/CaseField.tsx';
import { DivergingBars, type DivergingDatum } from '../components/DivergingBars.tsx';
import { FailureClusters } from '../components/FailureClusters.tsx';
import { RunPairPicker } from '../components/RunPairPicker.tsx';
import { DeltaBadge } from '../components/figures.tsx';
import { StatusMark, type StatusKind } from '../components/StatusMark.tsx';
import { getAnalysisProvenance } from '@catchfly/core/analysis-db.ts';
import { categoryLabel, signed } from '@catchfly/core/labels.ts';
import { activeComparison, activeRegressions, allRuns, useSelector } from '../state/selectors.ts';
import { useAnalysisEntry } from '../state/useAnalysis.ts';
import { useCatchflyStore } from '../state/store.ts';
import { useAgentTouch } from '../state/useAgentTouch.ts';
import { useComparisonEvidence } from '../state/useComparisonEvidence.ts';
import { activateComparison } from '../data/load.ts';
import '../styles/regressions.css';

const COMPARISON_ACTIONS = ['set_comparison'] as const;

export function Regressions() {
  const comparison = useSelector(activeComparison);
  const regressions = useSelector(activeRegressions);
  const storeComparison = useCatchflyStore((state) => state.comparison);
  const analysis = useAnalysisEntry(storeComparison);
  const setFilters = useCatchflyStore((state) => state.setFilters);
  const openCase = useCatchflyStore((state) => state.openCase);
  const setView = useCatchflyStore((state) => state.setView);
  const touch = useAgentTouch(COMPARISON_ACTIONS);
  const evidence = useComparisonEvidence();

  const pinInCases = (next: Parameters<typeof setFilters>[0]) =>
    setFilters(next, 'human', { view: 'cases', reset: true });

  if (evidence.error) return <p className="boot-error">Could not load comparison evidence: {evidence.error}</p>;
  if (!evidence.ready) return <section className="panel"><div className="panel-body muted">Loading the two runs behind this comparison…</div></section>;

  if (!comparison || !regressions) {
    const runCount = allRuns().length;
    return (
      <section className="panel">
        <div className="panel-body muted">
          {runCount < 2 ? (
            <>
              Catchfly needs two eval runs before it can isolate a regression.{' '}
              <button type="button" className="linkish" onClick={() => setView('sources', 'human')}>
                Open Connection
              </button>
            </>
          ) : 'Pick two runs to compare.'}
        </div>
      </section>
    );
  }

  const runs = allRuns();
  const { baseline, candidate } = comparison;

  // Recovered attempts are read off the per-category failure counts: a category
  // with fewer failures in the candidate recovered that many attempts.
  const diverging: DivergingDatum[] = comparison.byCategory
    .map((entry) => {
      const lost = regressions.byCategory.find((item) => item.category === entry.category);
      return {
        key: entry.category,
        label: categoryLabel(entry.category),
        lost: lost?.attempts ?? 0,
        gained: Math.max(entry.baselineFailures - entry.candidateFailures, 0),
      };
    })
    .filter((datum) => datum.lost > 0 || datum.gained > 0)
    .sort((a, b) => b.lost - a.lost || b.gained - a.gained);

  const candidateStatus: StatusKind =
    comparison.delta.successRate < -0.01
      ? 'regression'
      : comparison.delta.successRate > 0.01
        ? 'recovery'
        : 'control';
  const statusLabel =
    candidateStatus === 'regression'
      ? 'Regression'
      : candidateStatus === 'recovery'
        ? 'Recovery'
        : 'No material change';

  const clustersPanel = analysis ? (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>Failure clusters</h2>
          <p className="muted">Open a cluster to read its cases.</p>
        </div>
      </div>
      <div className="panel-body">
        <FailureClusters
          entry={analysis}
          provenance={getAnalysisProvenance()}
          onSelect={(cluster) =>
            pinInCases({ runId: candidate.runId, caseIds: cluster.caseIds })
          }
        />
      </div>
    </section>
  ) : null;

  return (
    <div className="stack">
      <section key={touch.key} className={`panel release-pair-panel run-pair-panel${touch.className}`}>
        <div className="panel-head">
          <div>
            <h2>Compared runs</h2>
            <p className="muted">The baseline run and the run being investigated, attempt by attempt.</p>
          </div>
          <span className="runlens-status">
            <StatusMark kind={candidateStatus} detail={statusLabel} size={16} />
            <DeltaBadge
              value={comparison.delta.successRate}
              format={(value) => `${(value * 100).toFixed(1)} pts`}
              versus="baseline"
            />
          </span>
        </div>
        <div className="panel-body">
          <RunPairPicker
            baseline={baseline}
            candidate={candidate}
            runs={runs}
            candidateStatus={candidateStatus}
            candidateLabel={statusLabel}
            onChange={(pair) => void activateComparison(pair, 'human')}
          />
        </div>
      </section>

      <div className="regress-row">
      <section className="panel casefield-panel">
        <div className="panel-head">
          <div>
            <h2>The case field</h2>
            <p className="muted">Every case, worst regression first. Open a cell to read the case.</p>
          </div>
        </div>
        <div className="panel-body">
          <p className="field-readout">
            <b className="tone-regressed">{regressions.regressedAttempts}</b> attempts stopped
            passing across <b>{regressions.affectedCases}</b>{' '}
            {regressions.affectedCases === 1 ? 'case' : 'cases'};{' '}
            <b className="tone-fixed">{regressions.fixedAttempts}</b> started.
            <span className="field-readout-rates">
              {(baseline.metrics.successRate * 100).toFixed(1)}% →{' '}
              {(candidate.metrics.successRate * 100).toFixed(1)}%
              <span className="muted">
                {' · '}net {signed(regressions.netAttemptDelta)} of {candidate.metrics.testCount} attempts
              </span>
            </span>
          </p>

          {regressions.cases.length === 0 ? (
            <div className="regress-clear">
              <img src="/brand/cards/field-clear.webp" alt="" aria-hidden="true" />
              <div>
                <strong>Nothing regressed between these runs.</strong>
                <p className="muted">
                  Every case that passed on {baseline.appVersionLabel} still passes on{' '}
                  {candidate.appVersionLabel}.
                </p>
              </div>
            </div>
          ) : null}

          <CaseField report={regressions} onOpenCase={(caseId) => openCase(caseId, 'human')} />
        </div>
      </section>

      <section className="panel diverge-panel">
        <div className="panel-head">
          <div>
            <h2>Lost and recovered by failure mode</h2>
            <p className="muted">Attempts the candidate lost against attempts it recovered.</p>
          </div>
        </div>
        <div className="panel-body">
          <div className="diverge-cap">
            <DivergingBars
              data={diverging}
              onSelect={(key) => {
                const entry = comparison.byCategory.find((item) => item.category === key);
                if (entry) pinInCases({ runId: candidate.runId, category: entry.category });
              }}
            />
          </div>
          <p className="chart-note">
            <span className="muted">Select a failure mode to open its cases.</span>
          </p>
        </div>
      </section>
      </div>

      {clustersPanel}

    </div>
  );
}
