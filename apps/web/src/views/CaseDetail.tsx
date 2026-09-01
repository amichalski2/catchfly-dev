/**
 * Case detail — one case, across every run.
 *
 * While this view is open, Catchfly registers its case-scoped WebMCP tools, so
 * an agent can inspect and diff exactly the case the developer is looking at
 * without being told which one it is.
 */

import { AttemptStrip } from '../components/figures.tsx';
import { TrajectoryDiff } from '../components/TrajectoryDiff.tsx';
import { categoryLabel } from '@catchfly/core/labels.ts';
import { selectedCase, selectedTrajectory, useSelector } from '../state/selectors.ts';
import { useCatchflyStore } from '../state/store.ts';
import { useAgentTouch } from '../state/useAgentTouch.ts';

const SELECTION_ACTIONS = ['open_case', 'set_comparison'] as const;

export function CaseDetail() {
  const detail = useSelector(selectedCase);
  const trajectory = useSelector(selectedTrajectory);
  const closeCase = useCatchflyStore((state) => state.closeCase);
  const touch = useAgentTouch(SELECTION_ACTIONS);

  if (!detail) return <p className="muted">No case selected.</p>;

  return (
    <div className="stack">
      <section key={touch.key} className={`panel${touch.className}`}>
        <div className="panel-head">
          <div>
            <h2>{detail.definition.name}</h2>
            <p className="muted">{detail.definition.expectedBehavior}</p>
          </div>
          <button type="button" className="btn" onClick={() => closeCase('human')}>
            Back to cases
          </button>
        </div>
        <div className="panel-body">
          <blockquote className="prompt">{detail.definition.prompt}</blockquote>

          <table className="table table-dense">
            <thead>
              <tr>
                <th scope="col">Run</th>
                <th scope="col">Model</th>
                <th scope="col">Failure</th>
                <th scope="col" className="col-right">
                  Attempts
                </th>
              </tr>
            </thead>
            <tbody>
              {detail.runs.map((run) => {
                const failing = run.attempts.find((attempt) => attempt.category);
                return (
                  <tr key={run.runId}>
                    <th scope="row">{run.appVersionLabel}</th>
                    <td>{run.model}</td>
                    <td>{categoryLabel(failing?.category)}</td>
                    <td className="col-right">
                      <AttemptStrip passes={run.passes} repeats={run.repeats} size="md" />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {trajectory ? (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>What the model did</h2>
              <p className="muted">
                A passing baseline attempt against a failing candidate attempt, call by call.
              </p>
            </div>
          </div>
          <div className="panel-body">
            <TrajectoryDiff comparison={trajectory} />
          </div>
        </section>
      ) : null}
    </div>
  );
}
