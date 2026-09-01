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
import { DeltaBadge, HeroFigure, StatTile } from '../components/figures.tsx';
import { RegressionPreview } from '../components/RegressionPreview.tsx';
import { StatusMark, type StatusKind } from '../components/StatusMark.tsx';
import { getAnalysisProvenance } from '@catchfly/core/analysis-db.ts';
import { categoryLabel } from '@catchfly/core/labels.ts';
import { activeComparison, activeRegressions, allRuns, useSelector } from '../state/selectors.ts';
import { useAnalysisEntry } from '../state/useAnalysis.ts';
import { useCatchflyStore } from '../state/store.ts';
import { useAgentTouch } from '../state/useAgentTouch.ts';
import { useComparisonEvidence } from '../state/useComparisonEvidence.ts';
import { activateComparison } from '../data/load.ts';

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

  const lostTotal = diverging.reduce((sum, datum) => sum + datum.lost, 0);
  const gainedTotal = diverging.reduce((sum, datum) => sum + datum.gained, 0);
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
          <p className="muted">
            Regressed cases grouped by category, by where their calls diverge from{' '}
            {baseline.appVersionLabel}, and by why they failed. Click a cluster to pin its cases in
            the table.
          </p>
        </div>
      </div>
      <div className="panel-body">
        <FailureClusters
          entry={analysis}
          provenance={getAnalysisProvenance()}
          onSelect={(cluster) =>
            setFilters({ runId: candidate.runId, caseIds: cluster.caseIds }, 'human')
          }
        />
      </div>
    </section>
  ) : null;

  return (
    <div className="stack">
      <div key={touch.key} className={`runlens${touch.className}`}>
        <label className="runlens-side">
          <span className="sr-only">Baseline run</span>
          <select
            value={baseline.runId}
            onChange={(event) =>
              void activateComparison(
                { baselineRunId: event.target.value, candidateRunId: candidate.runId },
                'human',
              )
            }
          >
            {runs.map((run) => (
              <option
                key={run.runId}
                value={run.runId}
                disabled={run.runId === candidate.runId}
              >
                {run.appVersionLabel} · {run.model}
              </option>
            ))}
          </select>
        </label>

        <span className="runlens-arrow" aria-hidden="true">
          →
        </span>

        <label className="runlens-side">
          <span className="sr-only">Candidate run</span>
          <select
            value={candidate.runId}
            onChange={(event) =>
              void activateComparison(
                { baselineRunId: baseline.runId, candidateRunId: event.target.value },
                'human',
              )
            }
          >
            {runs.map((run) => (
              <option
                key={run.runId}
                value={run.runId}
                disabled={run.runId === baseline.runId}
              >
                {run.appVersionLabel} · {run.model}
              </option>
            ))}
          </select>
        </label>

        <span className="runlens-status">
          <StatusMark kind={candidateStatus} detail={statusLabel} size={16} />
          <DeltaBadge
            value={comparison.delta.successRate}
            format={(value) => `${(value * 100).toFixed(1)} pts`}
            versus="baseline"
          />
        </span>
      </div>

      <section className="panel panel-hero">
        <div className="panel-head">
          <div>
            <h2>Case field</h2>
            <p className="muted">
              Each cell is one case in the suite, coloured by what happened to it between these
              runs. Select a cell to open the case.
            </p>
          </div>
        </div>
        <div className="panel-body">
          <div className="hero-row">
          <HeroFigure
            label="Regressed attempts"
            value={String(regressions.regressedAttempts)}
            tone={regressions.regressedAttempts > 0 ? 'regressed' : 'fixed'}
            caption={
              <>
                across {regressions.affectedCases} cases · {regressions.fixedAttempts} attempts
                recovered
                <br />
                <span className="muted">
                  net {regressions.netAttemptDelta >= 0 ? '+' : ''}
                  {regressions.netAttemptDelta} of {candidate.metrics.testCount}
                </span>
              </>
            }
          />
          <div className="tiles">
            <StatTile
              label="Baseline"
              value={`${(baseline.metrics.successRate * 100).toFixed(1)}%`}
              footnote={baseline.appVersionLabel}
            />
            <StatTile
              label="Candidate"
              value={`${(candidate.metrics.successRate * 100).toFixed(1)}%`}
              footnote={candidate.appVersionLabel}
            />
            <StatTile
              label="Cases touched"
              value={String(regressions.affectedCases + regressions.fixedCases.length)}
              footnote={`${regressions.affectedCases} worse · ${regressions.fixedCases.length} better`}
            />
          </div>
          </div>
          <CaseField report={regressions} onOpenCase={(caseId) => openCase(caseId, 'human')} />
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Lost and recovered by category</h2>
            <p className="muted">
              Attempts that stopped passing, against attempts that started.
            </p>
          </div>
        </div>
        <div className="panel-body">
          <div className="diverge-cap">
            <DivergingBars
              data={diverging}
              onSelect={(key) => {
                const entry = comparison.byCategory.find((item) => item.category === key);
                if (entry) setFilters({ runId: candidate.runId, category: entry.category }, 'human');
              }}
            />
          </div>
          <p className="chart-note">
            <span className="muted">Select a category to filter the case table.</span>
            <span className="chart-net">
              <span className="tone-regressed">−{lostTotal.toLocaleString()} lost</span>
              <span className="muted"> · </span>
              <span className="tone-fixed">+{gainedTotal.toLocaleString()} recovered</span>
            </span>
          </p>
        </div>
      </section>

      {clustersPanel}

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Every regressed case</h2>
            <p className="muted">
              Sorted by attempts lost. Failures already present in {baseline.appVersionLabel} are
              excluded by construction.
            </p>
          </div>
        </div>
        <div className="panel-body">
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
          ) : (
            <RegressionPreview
              report={regressions}
              limit={regressions.cases.length}
              onOpenCase={(caseId) => openCase(caseId, 'human')}
            />
          )}
        </div>
      </section>
    </div>
  );
}
