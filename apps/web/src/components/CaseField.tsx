import { useMemo } from 'react';

import { getDb } from '@catchfly/core/db.ts';
import type { RegressionReport } from '@catchfly/core/queries.ts';

type CellKind = 'regressed' | 'recovered' | 'unchanged';

type Cell = {
  caseId: string;
  label: string;
  kind: CellKind;
  weight: number;
};

export function CaseField({
  report,
  onOpenCase,
}: {
  report: RegressionReport;
  onOpenCase: (caseId: string) => void;
}) {
  const cells = useMemo<Cell[]>(() => {
    const regressed = new Map(report.cases.map((entry) => [entry.caseId, entry]));
    const recovered = new Map(report.fixedCases.map((entry) => [entry.caseId, entry]));
    const wounded: Cell[] = [];
    const healed: Cell[] = [];
    const rest: Cell[] = [];
    for (const [caseId, kase] of getDb().casesById) {
      const lost = regressed.get(caseId);
      if (lost) {
        wounded.push({
          caseId,
          label: `${kase.name} — lost ${lost.lostAttempts} of ${lost.repeats} attempts`,
          kind: 'regressed',
          weight: lost.lostAttempts / lost.repeats,
        });
        continue;
      }
      const gained = recovered.get(caseId);
      if (gained) {
        healed.push({
          caseId,
          label: `${kase.name} — recovered ${gained.gainedAttempts} ${gained.gainedAttempts === 1 ? 'attempt' : 'attempts'}`,
          kind: 'recovered',
          weight: 1,
        });
        continue;
      }
      rest.push({ caseId, label: `${kase.name} — unchanged`, kind: 'unchanged', weight: 0 });
    }
    wounded.sort((a, b) => b.weight - a.weight);
    return [...wounded, ...healed, ...rest];
  }, [report]);

  const regressedCount = report.cases.length;
  const recoveredCount = report.fixedCases.length;
  const unchangedCount = cells.length - regressedCount - recoveredCount;

  return (
    <div className="casefield">
      <div className="casefield-grid">
        {cells.map((cell) => (
          <button
            key={cell.caseId}
            type="button"
            className={`casefield-cell${
              cell.kind === 'regressed'
                ? ' mark mark-lost'
                : cell.kind === 'recovered'
                  ? ' mark mark-gained'
                  : ' is-unchanged'
            }`}
            style={cell.kind === 'regressed' ? { opacity: 0.55 + cell.weight * 0.45 } : undefined}
            aria-label={cell.label}
            title={cell.label}
            onClick={() => onOpenCase(cell.caseId)}
          />
        ))}
      </div>
      <div className="casefield-legend">
        <span className="key">
          <span className="key-swatch mark mark-lost" /> {regressedCount}{' '}
          {regressedCount === 1 ? 'case' : 'cases'} regressed ({report.regressedAttempts} attempts)
        </span>
        <span className="key">
          <span className="key-swatch mark mark-gained" /> {recoveredCount}{' '}
          {recoveredCount === 1 ? 'case' : 'cases'} recovered ({report.fixedAttempts} attempts)
        </span>
        <span className="key">
          <span className="key-swatch casefield-swatch-unchanged" /> {unchangedCount} unchanged
        </span>
      </div>
    </div>
  );
}
