/**
 * Two runs of one case, call by call.
 *
 * The divergence is the point, so it is marked structurally — a labelled rule
 * between the last agreeing call and the first disagreeing one — rather than
 * left for the reader to spot by comparing two lists.
 */

import type { TrajectoryComparison, TrajectorySide } from '@catchfly/core/queries.ts';

function argSummary(args: Record<string, unknown>): string {
  const entries = Object.entries(args);
  if (entries.length === 0) return '';
  return entries
    .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(', ');
}

function Side({
  side,
  divergenceIndex,
  expectedTools,
  /**
   * Only the run that went wrong gets the failure tint. The baseline reaches
   * the same step index, but it made the right call there — colouring it as a
   * divergence would read as "both runs are broken".
   */
  highlight,
}: {
  side: TrajectorySide;
  divergenceIndex: number;
  expectedTools: string[];
  highlight: boolean;
}) {
  return (
    <div className="traj">
      <div className="traj-head">
        <span className="traj-version">{side.appVersionLabel}</span>
        <span className={`pill pill-${side.outcome}`}>{side.outcome}</span>
        <span className="muted">attempt {side.runIndex}</span>
      </div>

      <ol className="traj-calls">
        {side.calls.map((call, index) => {
          const atOrAfterDivergence = divergenceIndex >= 0 && index >= divergenceIndex;
          const diverged = atOrAfterDivergence && highlight;
          const expected = expectedTools.includes(call.functionName);
          return (
            <li key={`${call.functionName}-${index}`}>
              {/* Only the failing run is annotated; both lists start at step 1,
                  so the reader can already line them up. */}
              {highlight && index === divergenceIndex ? (
                <span className="traj-divider">diverges here</span>
              ) : null}
              <div className={`traj-call${diverged ? ' is-diverged' : ''}`}>
                <code className={expected ? '' : 'is-unexpected'}>{call.functionName}</code>
                {argSummary(call.args) ? (
                  <span className="traj-args">{argSummary(call.args)}</span>
                ) : null}
                {call.result && typeof call.result === 'object' && 'error' in call.result ? (
                  <span className="traj-error">{String((call.result as { error: unknown }).error)}</span>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>

      {side.failureReason ? <p className="traj-reason">{side.failureReason}</p> : null}
    </div>
  );
}

export function TrajectoryDiff({ comparison }: { comparison: TrajectoryComparison }) {
  return (
    <div className="traj-wrap">
      <p className="traj-expected">
        <span className="eyebrow">Expected</span>{' '}
        {comparison.expectedTools.map((tool, index) => (
          <span key={`${tool}-${index}`}>
            {index > 0 ? <span className="traj-arrow"> → </span> : null}
            <code>{tool}</code>
          </span>
        ))}
      </p>

      <div className="traj-grid">
        <Side
          side={comparison.baseline}
          divergenceIndex={comparison.firstDivergenceIndex}
          expectedTools={comparison.expectedTools}
          highlight={false}
        />
        <Side
          side={comparison.candidate}
          divergenceIndex={comparison.firstDivergenceIndex}
          expectedTools={comparison.expectedTools}
          highlight
        />
      </div>

      {comparison.toolManifestDelta.added.length > 0 ||
      comparison.toolManifestDelta.removed.length > 0 ? (
        <p className="traj-manifest">
          Between these versions the app{' '}
          {comparison.toolManifestDelta.added.length > 0 ? (
            <>
              gained{' '}
              {comparison.toolManifestDelta.added.map((tool) => (
                <code key={tool}>{tool}</code>
              ))}
            </>
          ) : null}
          {comparison.toolManifestDelta.added.length > 0 &&
          comparison.toolManifestDelta.removed.length > 0
            ? ' and '
            : null}
          {comparison.toolManifestDelta.removed.length > 0 ? (
            <>
              dropped{' '}
              {comparison.toolManifestDelta.removed.map((tool) => (
                <code key={tool}>{tool}</code>
              ))}
            </>
          ) : null}
          .
        </p>
      ) : null}
    </div>
  );
}
