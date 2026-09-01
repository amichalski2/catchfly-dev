import { CATEGORY_LABELS, formatCount, formatPercent } from '@catchfly/core/labels.ts';
import type { CaseRow } from '@catchfly/core/queries.ts';
import type { FailureCategory } from '@catchfly/core/types.ts';

type Slice = {
  key: string;
  label: string;
  cases: number;
  category: FailureCategory | null;
};

function dominantCategories(rows: CaseRow[]): Map<string, FailureCategory | null> {
  const tallies = new Map<string, Map<FailureCategory, number>>();
  const dominant = new Map<string, FailureCategory | null>();
  for (const row of rows) {
    if (!dominant.has(row.caseId)) dominant.set(row.caseId, null);
    if (!row.category) continue;
    const tally = tallies.get(row.caseId) ?? new Map<FailureCategory, number>();
    tally.set(row.category, (tally.get(row.category) ?? 0) + 1);
    tallies.set(row.caseId, tally);
  }
  for (const [caseId, tally] of tallies) {
    let best: FailureCategory | null = null;
    let bestCount = 0;
    for (const [category, count] of tally) {
      if (count > bestCount) {
        best = category;
        bestCount = count;
      }
    }
    dominant.set(caseId, best);
  }
  return dominant;
}

export function CaseComposition({
  rows,
  activeCategory,
  onSelect,
}: {
  rows: CaseRow[];
  activeCategory: FailureCategory | undefined;
  onSelect: (category: FailureCategory | undefined) => void;
}) {
  if (rows.length === 0) return null;

  const dominant = dominantCategories(rows);
  const counts = new Map<string, Slice>();
  for (const category of dominant.values()) {
    const key = category ?? 'passing';
    const slice = counts.get(key) ?? {
      key,
      label: category ? CATEGORY_LABELS[category] : 'Passing',
      cases: 0,
      category,
    };
    slice.cases += 1;
    counts.set(key, slice);
  }

  const passing = counts.get('passing') ?? null;
  const failing = [...counts.values()]
    .filter((slice) => slice.category !== null)
    .sort((a, b) => b.cases - a.cases);
  const slices = passing ? [passing, ...failing] : failing;
  const total = dominant.size;
  const failingTotal = total - (passing?.cases ?? 0);

  return (
    <div className="composition">
      <div className="composition-bar">
        {slices.map((slice) => (
          <button
            key={slice.key}
            type="button"
            className={`composition-slice mark ${slice.category ? 'mark-lost' : 'mark-gained'}${
              slice.category && slice.category === activeCategory ? ' is-active' : ''
            }`}
            style={{ flexGrow: slice.cases }}
            aria-pressed={slice.category ? slice.category === activeCategory : undefined}
            disabled={slice.category === null}
            title={`${slice.label} — ${slice.cases} of ${total} cases`}
            onClick={() =>
              slice.category
                ? onSelect(slice.category === activeCategory ? undefined : slice.category)
                : undefined
            }
          >
            <span className="sr-only">
              {slice.label}: {slice.cases} of {total} cases
            </span>
          </button>
        ))}
      </div>

      <ul className="composition-keys">
        {slices.map((slice) => (
          <li key={slice.key}>
            <button
              type="button"
              className={`composition-key${
                slice.category && slice.category === activeCategory ? ' is-active' : ''
              }`}
              disabled={slice.category === null}
              onClick={() =>
                slice.category
                  ? onSelect(slice.category === activeCategory ? undefined : slice.category)
                  : undefined
              }
            >
              <span
                className={`key-swatch mark ${slice.category ? 'mark-lost' : 'mark-gained'}`}
                aria-hidden="true"
              />
              <span className="composition-key-label">{slice.label}</span>
              <span className="composition-key-count tabular">{slice.cases}</span>
            </button>
          </li>
        ))}
      </ul>

      <p className="composition-note muted">
        {formatCount(failingTotal)} of {formatCount(total)} cases fail at least one attempt in a loaded
        run — {formatPercent(failingTotal / total, 0)}. Each case counts once, under its most frequent
        failure mode.
      </p>
    </div>
  );
}
