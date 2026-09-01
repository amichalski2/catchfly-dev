/**
 * The worst regressions, as a table.
 *
 * Doubles as the table-view twin for the charts above — every number on this
 * screen is reachable without reading a colour — and as the bridge into the
 * Regression Explorer. Attempt strips carry the pass count in filled cells, so
 * "5/5 → 0/5" is legible without relying on the rose/sage pair.
 */

import { categoryLabel } from '@catchfly/core/labels.ts';
import type { RegressionReport } from '@catchfly/core/queries.ts';
import { AttemptStrip } from './figures.tsx';

export function RegressionPreview({
  report,
  limit = 6,
  onOpenCase,
}: {
  report: RegressionReport;
  limit?: number;
  onOpenCase?: (caseId: string) => void;
}) {
  const rows = report.cases.slice(0, limit);
  if (rows.length === 0) return <p className="muted">Nothing regressed between these runs.</p>;

  return (
    <table className="table">
      <thead>
        <tr>
          <th scope="col">Case</th>
          <th scope="col">Failure</th>
          <th scope="col" className="col-right">
            Baseline
          </th>
          <th scope="col" className="col-right">
            Candidate
          </th>
          <th scope="col" className="col-right">
            Lost
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((entry) => (
          <tr key={entry.caseId}>
            <th scope="row">
              {onOpenCase ? (
                <button type="button" className="linkish" onClick={() => onOpenCase(entry.caseId)}>
                  {entry.name}
                </button>
              ) : (
                entry.name
              )}
            </th>
            <td>{categoryLabel(entry.category)}</td>
            <td className="col-right">
              <AttemptStrip passes={entry.baselinePasses} repeats={entry.repeats} />
            </td>
            <td className="col-right">
              <AttemptStrip passes={entry.candidatePasses} repeats={entry.repeats} />
            </td>
            <td className="col-right col-strong">−{entry.lostAttempts}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
