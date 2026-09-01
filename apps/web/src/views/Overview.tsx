/**
 * Overview — the answer to "did the candidate get worse, and by how much?"
 *
 * Every number comes from the query layer; this view only chooses forms. The
 * hero is the delta rather than either rate, because the delta is the question
 * the developer arrived with.
 */

import { BarList, type BarDatum } from '../components/BarList.tsx';
import { DeltaBadge, HeroFigure, StatTile } from '../components/figures.tsx';
import { RegressionPreview } from '../components/RegressionPreview.tsx';
import { getDb } from '@catchfly/core/db.ts';
import { categoryLabel, versionShortener } from '@catchfly/core/labels.ts';
import { VersionColumns, type VersionFacet } from '../components/VersionColumns.tsx';
import { activeComparison, activeRegressions, allRuns, useSelector } from '../state/selectors.ts';
import { useCatchflyStore } from '../state/store.ts';
import { useAgentTouch } from '../state/useAgentTouch.ts';
import { IncidentOverview } from './IncidentOverview.tsx';
import { MeasuredOverview } from './MeasuredOverview.tsx';

/** Actions whose effect is visible in each panel. */
const COMPARISON_ACTIONS = ['set_comparison'] as const;
const FILTER_ACTIONS = ['set_filters', 'reset_filters'] as const;

const points = (value: number) => `${(value * 100).toFixed(1)} pts`;
const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
const money = (value: number) => `$${value.toFixed(2)}`;

export function Overview() {
  const comparison = useSelector(activeComparison);
  const regressions = useSelector(activeRegressions);
  const setComparison = useCatchflyStore((state) => state.setComparison);
  const setFilters = useCatchflyStore((state) => state.setFilters);
  const openCase = useCatchflyStore((state) => state.openCase);
  const setView = useCatchflyStore((state) => state.setView);
  const comparisonTouch = useAgentTouch(COMPARISON_ACTIONS);
  const filterTouch = useAgentTouch(FILTER_ACTIONS);

  if (getDb().dataset.project.generatorVersion?.startsWith('scale-world')) {
    return <IncidentOverview />;
  }

  if (getDb().dataset.project.dataOrigin !== 'synthetic') {
    return <MeasuredOverview />;
  }

  if (!comparison || !regressions) return <p className="muted">Pick two runs to compare.</p>;

  const { baseline, candidate, delta } = comparison;
  const repeats = getDb().repeats;

  const shortVersion = versionShortener(allRuns().map((run) => run.appVersionLabel));
  const facets: VersionFacet[] = [...new Set(allRuns().map((run) => run.model))].map((model) => ({
    model,
    columns: allRuns()
      .filter((run) => run.model === model)
      .map((run) => {
        const attempts = `${run.metrics.passCount} of ${run.metrics.testCount} attempts passed`;
        return {
          runId: run.runId,
          version: shortVersion(run.appVersionLabel),
          value: run.metrics.successRate,
          // Imported reports carry no timings, so the latency clause is optional.
          detail:
            run.metrics.avgLatencyMs === undefined
              ? attempts
              : `${attempts} · ${run.metrics.avgLatencyMs} ms avg`,
        };
      }),
  }));

  const categories: BarDatum[] = comparison.byCategory
    .filter((entry) => entry.candidateFailures > 0)
    .map((entry) => ({
      key: entry.category,
      label: categoryLabel(entry.category),
      value: entry.candidateFailures,
      detail: `${entry.baselineFailures} in ${baseline.appVersionLabel} → ${entry.candidateFailures} in ${candidate.appVersionLabel}`,
    }))
    .sort((a, b) => b.value - a.value);

  return (
    <div className="stack">
      <section key={comparisonTouch.key} className={`panel panel-hero${comparisonTouch.className}`}>
        <div className="panel-body hero-row">
          <HeroFigure
            label="Quality change"
            value={`${delta.successRate >= 0 ? '+' : '−'}${points(Math.abs(delta.successRate))}`}
            tone={delta.successRate < 0 ? 'regressed' : 'fixed'}
            caption={
              <>
                <span className="nowrap">
                  {baseline.appVersionLabel} {percent(baseline.metrics.successRate)}
                </span>
                {' → '}
                <span className="nowrap">
                  {candidate.appVersionLabel} {percent(candidate.metrics.successRate)}
                </span>
                <br />
                <span className="muted">evaluated with {candidate.model}</span>
              </>
            }
          />
          <div className="tiles">
            <StatTile
              label="Candidate success rate"
              value={percent(candidate.metrics.successRate)}
              delta={
                <DeltaBadge
                  value={delta.successRate}
                  format={points}
                  versus={baseline.appVersionLabel}
                />
              }
            />
            <StatTile
              label="Regressed attempts"
              value={String(regressions.regressedAttempts)}
              footnote={`across ${regressions.affectedCases} cases · ${regressions.fixedAttempts} fixed`}
            />
            {/* Latency and cost are Catchfly's own fields: an imported Chrome
                report has neither, and the tiles say so instead of showing 0. */}
            <StatTile
              label="Average latency"
              value={
                candidate.metrics.avgLatencyMs === undefined
                  ? null
                  : `${candidate.metrics.avgLatencyMs} ms`
              }
              unmeasuredNote="Chrome eval reports carry no timings."
              delta={
                baseline.metrics.avgLatencyMs === undefined ? undefined : (
                  <DeltaBadge
                    value={delta.avgLatencyMs}
                    format={(value) => `${Math.round(value)} ms`}
                    direction="up-bad"
                    versus={baseline.appVersionLabel}
                  />
                )
              }
            />
            <StatTile
              label="Run cost"
              value={
                candidate.metrics.totalCostUsd === undefined
                  ? null
                  : money(candidate.metrics.totalCostUsd)
              }
              unmeasuredNote="Chrome eval reports carry no cost."
              delta={
                baseline.metrics.totalCostUsd === undefined ? undefined : (
                  <DeltaBadge
                    value={delta.totalCostUsd}
                    format={money}
                    direction="up-bad"
                    versus={baseline.appVersionLabel}
                  />
                )
              }
            />
          </div>
        </div>
      </section>

      <div className="split">
        <section key={comparisonTouch.key} className={`panel${comparisonTouch.className}`}>
          <div className="panel-head">
            <div>
              <h2>Success rate by version</h2>
              <p className="muted">
                {repeats === 1
                  ? 'Each version evaluated once per case. Click a column to compare against it.'
                  : `Each version evaluated ${repeats} times per case. Click a column to compare against it.`}
              </p>
            </div>
          </div>
          <div className="panel-body">
            <VersionColumns
              facets={facets}
              emphasisRunId={candidate.runId}
              onSelect={(runId) =>
                runId !== candidate.runId &&
                setComparison({ baselineRunId: runId, candidateRunId: candidate.runId }, 'human')
              }
            />
          </div>
        </section>

        <section key={filterTouch.key} className={`panel${filterTouch.className}`}>
          <div className="panel-head">
            <div>
              <h2>Where {candidate.appVersionLabel} fails</h2>
              <p className="muted">Failing attempts by category. Click a bar to filter the cases.</p>
            </div>
          </div>
          <div className="panel-body">
            <BarList
              data={categories}
              emptyLabel="No failures in this run."
              onSelect={(key) => {
                const entry = comparison.byCategory.find((item) => item.category === key);
                if (entry) setFilters({ runId: candidate.runId, category: entry.category }, 'human');
              }}
            />
          </div>
        </section>
      </div>

      <section key={comparisonTouch.key} className={`panel${comparisonTouch.className}`}>
        <div className="panel-head">
          <div>
            <h2>Worst regressions</h2>
            <p className="muted">
              Cases that passed in {baseline.appVersionLabel} and stopped passing in{' '}
              {candidate.appVersionLabel}. Failures already present in the baseline are excluded.
            </p>
          </div>
          <button type="button" className="btn" onClick={() => setView('regressions', 'human')}>
            All {regressions.affectedCases} cases
          </button>
        </div>
        <div className="panel-body">
          <RegressionPreview report={regressions} onOpenCase={(caseId) => openCase(caseId, 'human')} />
        </div>
      </section>
    </div>
  );
}
