/**
 * The dense case table — and the table view every chart on this screen leans on.
 *
 * Long result sets are capped rather than virtualised, and the cap is stated in
 * the footer: a silently truncated table reads as "this is everything", which
 * is exactly the misreading this product exists to prevent.
 */

import { categoryLabel, versionShortener } from '@catchfly/core/labels.ts';
import type { CaseRow } from '@catchfly/core/queries.ts';
import { AttemptStrip } from './figures.tsx';

export const ROW_CAP = 100;

export function CaseTable({
  rows,
  onOpenCase,
  cap = ROW_CAP,
}: {
  rows: CaseRow[];
  onOpenCase: (caseId: string) => void;
  cap?: number;
}) {
  if (rows.length === 0) {
    return <p className="muted">No cases match these filters.</p>;
  }

  const shortVersion = versionShortener(rows.map((row) => row.appVersionId));

  const shown = rows.slice(0, cap);
  const hasLatency = rows.some((row) => row.avgLatencyMs > 0);

  return (
    <>
      <table className="table table-dense">
        <thead>
          <tr>
            <th scope="col">Case</th>
            <th scope="col">Run</th>
            <th scope="col">Failure</th>
            <th scope="col">Tools called</th>
            <th scope="col" className="col-right">
              Attempts
            </th>
            {hasLatency ? (
              <th scope="col" className="col-right">
                Latency
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {shown.map((row) => (
            <tr key={`${row.runId}::${row.caseId}`}>
              <th scope="row">
                <button type="button" className="linkish" onClick={() => onOpenCase(row.caseId)}>
                  {row.name}
                </button>
                <span className="row-sub">{row.caseId}</span>
              </th>
              <td className="col-nowrap">
                {shortVersion(row.appVersionId)}
                <span className="row-sub">{row.model}</span>
              </td>
              <td>{categoryLabel(row.category)}</td>
              <td className="col-tools">
                {row.tools.slice(0, 3).map((tool) => (
                  <code key={tool} className="chip">
                    {tool}
                  </code>
                ))}
                {row.tools.length > 3 ? (
                  <span className="muted">+{row.tools.length - 3}</span>
                ) : null}
              </td>
              <td className="col-right">
                <AttemptStrip passes={row.passes} repeats={row.repeats} />
              </td>
              {hasLatency ? (
                <td className="col-right tabular">{row.avgLatencyMs} ms</td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>

      {rows.length > cap ? (
        <p className="table-foot">
          Showing the first {cap} of {rows.length.toLocaleString('en-US')} cases — narrow the
          filters to see the rest.
        </p>
      ) : null}
    </>
  );
}
