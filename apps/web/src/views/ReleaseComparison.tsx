import { useEffect, useMemo, useState } from 'react';

import { getDb } from '@catchfly/core/db.ts';
import { categoryLabel, formatCount, formatPercent, formatPoints, signed } from '@catchfly/core/labels.ts';
import type { DeploymentComparison } from '@catchfly/core/session-types.ts';
import type { FailureCategory } from '@catchfly/core/types.ts';

import { DivergingBars } from '../components/DivergingBars.tsx';
import { DeltaBadge, HeroFigure, StatTile } from '../components/figures.tsx';
import { ReleaseEvidence } from '../components/ReleaseEvidence.tsx';
import { ReleasePairPicker } from '../components/ReleasePairPicker.tsx';
import type { StatusKind } from '../components/StatusMark.tsx';
import { fetchDeploymentComparison } from '../data/api.ts';
import { useCatchflyStore } from '../state/store.ts';
import { useAgentTouch } from '../state/useAgentTouch.ts';
import { useDeployments, useSessionsAvailable } from '../state/useSessions.ts';
import {
  deploymentFailureRate,
  releaseFindings,
  releaseTone,
  releaseToolChanges,
  type ReleaseFinding,
} from './release-comparison-model.ts';
import '../styles/release-comparison.css';

const RELEASE_ACTIONS = ['set_release_comparison'] as const;


const statusFor = (tone: ReturnType<typeof releaseTone>): StatusKind =>
  tone === 'regressed' ? 'regression' : tone === 'fixed' ? 'recovery' : 'control';

export function ReleaseComparison() {
  const projectId = useCatchflyStore((state) => state.projectId);
  const pair = useCatchflyStore((state) => state.releaseComparison);
  const setReleaseComparison = useCatchflyStore((state) => state.setReleaseComparison);
  const openTool = useCatchflyStore((state) => state.openTool);
  const setSessionFilters = useCatchflyStore((state) => state.setSessionFilters);
  const setView = useCatchflyStore((state) => state.setView);
  const touch = useAgentTouch(RELEASE_ACTIONS);
  const available = useSessionsAvailable();
  const deployments = useDeployments();
  const rollups = deployments?.status === 'ready' ? deployments.value : [];

  const [request, setRequest] = useState<{
    key: string;
    data: DeploymentComparison | null;
    error: string | null;
  }>({ key: '', data: null, error: null });

  const baselineId = pair?.baselineDeploymentId ?? rollups[rollups.length - 2]?.id;
  const candidateId = pair?.candidateDeploymentId ?? rollups[rollups.length - 1]?.id;

  useEffect(() => {
    if (!baselineId || !candidateId || baselineId === candidateId) return;
    const key = `${projectId}::${baselineId}::${candidateId}`;
    let active = true;
    void fetchDeploymentComparison(projectId, baselineId, candidateId)
      .then((value) => {
        if (active) setRequest({ key, data: value, error: null });
      })
      .catch((reason: unknown) => {
        if (active) {
          setRequest({
            key,
            data: null,
            error: reason instanceof Error ? reason.message : String(reason),
          });
        }
      });
    return () => {
      active = false;
    };
  }, [projectId, baselineId, candidateId]);

  const key = baselineId && candidateId ? `${projectId}::${baselineId}::${candidateId}` : '';
  const comparison = request.key === key ? request.data : null;
  const error = request.key === key ? request.error : null;

  const presentation = useMemo(() => {
    if (!comparison) return null;
    const db = getDb();
    const manifestOf = (appVersionId: string) =>
      db.versionsById.get(appVersionId)?.toolManifest ?? [];
    const toolChanges = releaseToolChanges(
      comparison,
      manifestOf(comparison.baseline.appVersionId),
      manifestOf(comparison.candidate.appVersionId),
    );
    return {
      toolChanges,
      findings: releaseFindings(comparison, toolChanges, categoryLabel),
    };
  }, [comparison]);

  if (!available) {
    return (
      <section className="panel">
        <div className="panel-body muted">
          This deployment has no production session data, so releases cannot be compared. The eval
          half of the dashboard still works.
        </div>
      </section>
    );
  }

  if (rollups.length < 2) {
    return (
      <section className="panel">
        <div className="panel-body muted">
          {deployments?.status === 'ready' ? (
            <>
              Catchfly needs traces from two deployments before it can show what changed.{' '}
              <button type="button" className="linkish" onClick={() => setView('sources', 'human')}>
                Open Connection
              </button>
            </>
          ) : 'Loading deployments…'}
        </div>
      </section>
    );
  }

  const baseline = rollups.find((deployment) => deployment.id === baselineId);
  const candidate = rollups.find((deployment) => deployment.id === candidateId);
  if (!baseline || !candidate) {
    return (
      <section className="panel">
        <div className="panel-body boot-error">
          One of the selected releases is not available in this project.
        </div>
      </section>
    );
  }

  const choose = (next: { baselineDeploymentId: string; candidateDeploymentId: string }) =>
    setReleaseComparison(next, 'human');

  const previewDelta = deploymentFailureRate(candidate) - deploymentFailureRate(baseline);
  const pairPicker = (
    <ReleasePairPicker
      baseline={baseline}
      candidate={candidate}
      deployments={rollups}
      candidateStatus={statusFor(releaseTone(previewDelta))}
      onChange={choose}
    />
  );
  const releasePairPanel = (
    <section key={touch.key} className={`panel release-pair-panel${touch.className}`}>
      <div className="panel-head">
        <div>
          <h2>Compared releases</h2>
          <p className="muted">The production baseline and the release being investigated.</p>
        </div>
      </div>
      <div className="panel-body">{pairPicker}</div>
    </section>
  );

  if (baseline.id === candidate.id) {
    return (
      <div className="stack release-comparison">
        {releasePairPanel}
        <section className="panel">
          <div className="panel-body muted">Choose two different releases to compare.</div>
        </section>
      </div>
    );
  }

  if (error) {
    return (
      <div className="stack release-comparison">
        {releasePairPanel}
        <section className="panel">
          <div className="panel-body boot-error">Could not compare these releases: {error}</div>
        </section>
      </div>
    );
  }

  if (!comparison || !presentation) {
    return (
      <div className="stack release-comparison">
        {releasePairPanel}
        <section className="panel">
          <div className="panel-body muted">Comparing releases…</div>
        </section>
      </div>
    );
  }

  const baselineRate = deploymentFailureRate(comparison.baseline);
  const candidateRate = deploymentFailureRate(comparison.candidate);
  const rateDelta = candidateRate - baselineRate;
  const tone = releaseTone(rateDelta);
  const volumeShifts = comparison.tools
    .map((tool) => ({ toolName: tool.toolName, delta: tool.candidateCalls - tool.baselineCalls }))
    .filter((entry) => entry.delta !== 0)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 10);
  const categoryShifts = [...comparison.categories]
    .filter((entry) => entry.delta !== 0)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  const failureNet = categoryShifts.reduce((sum, entry) => sum + entry.delta, 0);
  const callsMoved = volumeShifts.reduce((sum, entry) => sum + Math.abs(entry.delta), 0);
  const manifestChangeCount = presentation.toolChanges.filter(
    (entry) => entry.schemaChangeCount > 0,
  ).length;

  const openFinding = (finding: ReleaseFinding) => {
    if (finding.action.kind === 'tool') {
      openTool(finding.action.toolName, 'human');
      return;
    }
    setSessionFilters(
      {
        deploymentId: comparison.candidate.id,
        category: finding.action.category as FailureCategory,
        outcome: 'any-failure',
      },
      'human',
    );
  };

  return (
    <div className="stack release-comparison">
      <div className="release-summary-grid">
        {releasePairPanel}

        <section className="panel panel-hero release-overview">
          <div className="panel-head">
            <div>
              <h2>Production impact</h2>
              <p className="muted">What changed after the candidate reached production.</p>
            </div>
          </div>
          <div className="panel-body hero-row">
            <HeroFigure
              label="Failure-rate change"
              value={formatPoints(rateDelta * 100)}
              tone={tone}
              caption={`${formatPercent(baselineRate)} → ${formatPercent(candidateRate)} of sessions failed`}
            />
            <div className="tiles">
              <StatTile
                label="Production sessions"
                value={formatCount(comparison.candidate.sessionCount)}
                footnote={`${formatCount(comparison.candidate.failedCount)} failed · ${formatCount(comparison.baseline.sessionCount)} in baseline`}
              />
              <StatTile
                label="Tool calls"
                value={formatCount(comparison.candidate.toolCallCount)}
                footnote={`${formatCount(comparison.candidate.errorCallCount)} rejected · ${formatCount(comparison.baseline.toolCallCount)} in baseline`}
              />
              <StatTile
                label="Tools with changed traffic"
                value={formatCount(presentation.toolChanges.length)}
                footnote={`${manifestChangeCount} changed their manifest`}
              />
            </div>
          </div>
        </section>
      </div>

      <div className="release-analysis-grid">
        <section className="panel release-analysis-panel">
          <div className="panel-head">
            <div>
              <h2>Failure mix shift</h2>
              <p className="muted">Which failure modes became more or less common.</p>
            </div>
          </div>
          <div className="panel-body">
            <DivergingBars
              data={categoryShifts.map((entry) => ({
                key: entry.category,
                label: categoryLabel(entry.category),
                lost: entry.delta > 0 ? entry.delta : 0,
                gained: entry.delta < 0 ? -entry.delta : 0,
              }))}
              polarity="failures"
              emptyLabel="No change between these releases."
              onSelect={(category) =>
                setSessionFilters(
                  {
                    deploymentId: comparison.candidate.id,
                    category: category as FailureCategory,
                    outcome: 'any-failure',
                  },
                  'human',
                )
              }
            />
            <p className="chart-note">
              <span className="muted">
                Select a failure mode to read the candidate sessions behind it.
              </span>
              <span
                className={`chart-net ${
                  failureNet > 0 ? 'tone-regressed' : failureNet < 0 ? 'tone-fixed' : 'muted'
                }`}
              >
                {signed(failureNet)} failures net vs baseline
              </span>
            </p>
          </div>
        </section>

        <section className="panel release-analysis-panel">
          <div className="panel-head">
            <div>
              <h2>Where agents went instead</h2>
              <p className="muted">How production calls moved between tools.</p>
            </div>
          </div>
          <div className="panel-body">
            <DivergingBars
              data={volumeShifts.map((entry) => ({
                key: entry.toolName,
                label: entry.toolName,
                lost: entry.delta < 0 ? -entry.delta : 0,
                gained: entry.delta > 0 ? entry.delta : 0,
              }))}
              polarity="traffic"
              emptyLabel="No change between these releases."
              limit={6}
              moreLabel="tools"
              onSelect={(toolName) => openTool(toolName, 'human')}
            />
            <p className="chart-note">
              <span className="muted">Select a tool to open its production and eval profile.</span>
              <span className="chart-net muted">
                {formatCount(callsMoved)} calls changed tools
              </span>
            </p>
          </div>
        </section>
      </div>

      <section className="panel release-attention">
        <div className="panel-head">
          <div>
            <h2>Evidence chain</h2>
            <p className="muted">
              Outcome, tool routing and manifest evidence for this release pair.
            </p>
          </div>
        </div>
        <div className="panel-body">
          <ReleaseEvidence findings={presentation.findings} onOpen={openFinding} />

          {presentation.toolChanges.length > 0 ? (
            <div className="release-tool-strip-block">
              <h3 className="release-tool-strip-head">
                All {presentation.toolChanges.length} changed tools
              </h3>
              <div className="release-tool-shelf">
                <div className="release-tool-strip">
                  {presentation.toolChanges.map(
                    ({ tool, callDelta, undeclared, schemaChangeCount }) => (
                      <button
                        key={tool.toolName}
                        type="button"
                        className="release-tool-card"
                        onClick={() => openTool(tool.toolName, 'human')}
                      >
                        <code className="release-tool-name">{tool.toolName}</code>
                        <span className="release-tool-calls tabular">
                          {formatCount(tool.baselineCalls)} → {formatCount(tool.candidateCalls)}
                        </span>
                        <DeltaBadge
                          value={callDelta}
                          format={(value) => `${formatCount(value)} calls`}
                          versus="baseline"
                        />
                        <span
                          className={`release-tool-foot${undeclared ? ' tone-regressed' : ''}`}
                        >
                          {undeclared
                            ? 'never declared — agents invented it'
                            : `${formatPercent(tool.candidateSuccessRate)} success · ${
                                schemaChangeCount > 0
                                  ? `${schemaChangeCount} manifest ${schemaChangeCount === 1 ? 'change' : 'changes'}`
                                  : 'manifest unchanged'
                              }`}
                        </span>
                      </button>
                    ),
                  )}
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}
