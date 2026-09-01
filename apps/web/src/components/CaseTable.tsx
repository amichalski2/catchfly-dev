/**
 * The dense case table — and the table view every chart on this screen leans on.
 */

import { getDb } from '@catchfly/core/db.ts';
import { categoryLabel, versionShortener } from '@catchfly/core/labels.ts';
import type { CaseRow } from '@catchfly/core/queries.ts';
import { AttemptStrip } from './figures.tsx';

export function CaseTable({
  rows,
  onOpenCase,
}: {
  rows: CaseRow[];
  onOpenCase: (caseId: string) => void;
}) {
  if (rows.length === 0) {
    return <p className="muted">No cases match these filters.</p>;
  }

  const versions = getDb().versionsById;
  const labelOf = (appVersionId: string) => versions.get(appVersionId)?.label ?? appVersionId;
  const shortVersion = versionShortener(rows.map((row) => labelOf(row.appVersionId)));

  return (
    <table className="table table-dense">
      <thead>
        <tr>
          <th scope="col">Case</th>
          <th scope="col">Run</th>
          <th scope="col">Failure mode</th>
          <th scope="col">Tools called</th>
          <th scope="col" className="col-right">
            Attempts
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={`${row.runId}::${row.caseId}`} className="row-link" onClick={() => onOpenCase(row.caseId)}>
            <th scope="row">
              <button
                type="button"
                className="row-name"
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenCase(row.caseId);
                }}
              >
                {row.name}
              </button>
            </th>
            <td className="col-nowrap" title={row.appVersionId}>
              {shortVersion(labelOf(row.appVersionId))}
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
          </tr>
        ))}
      </tbody>
    </table>
  );
}
