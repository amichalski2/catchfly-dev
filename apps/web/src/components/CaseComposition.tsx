import { CATEGORY_LABELS } from '@catchfly/core/labels.ts';
import type { CaseRow } from '@catchfly/core/queries.ts';
import type { FailureCategory } from '@catchfly/core/types.ts';

type Segment = {
  key: string;
  label: string;
  cases: number;
  category: FailureCategory | null;
};

const percent = (value: number) => `${(value * 100).toFixed(0)}%`;

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

  const counts = new Map<string, Segment>();
  for (const row of rows) {
    const key = row.category ?? 'passing';
    const segment = counts.get(key) ?? {
      key,
      label: row.category ? CATEGORY_LABELS[row.category] : 'Passing',
      cases: 0,
      category: row.category ?? null,
    };
    segment.cases += 1;
    counts.set(key, segment);
  }

  const passing = counts.get('passing') ?? null;
  const failing = [...counts.values()]
    .filter((segment) => segment.category !== null)
    .sort((a, b) => b.cases - a.cases);
  const segments = passing ? [passing, ...failing] : failing;
  const total = rows.length;
  const failingTotal = total - (passing?.cases ?? 0);

  return (
    <div className="composition">
      <div className="composition-bar">
        {segments.map((segment) => (
          <button
            key={segment.key}
            type="button"
            className={`composition-slice mark ${segment.category ? 'mark-lost' : 'mark-gained'}${
              segment.category && segment.category === activeCategory ? ' is-active' : ''
            }`}
            style={{ flexGrow: segment.cases }}
            aria-pressed={segment.category ? segment.category === activeCategory : undefined}
            disabled={segment.category === null}
            title={`${segment.label} — ${segment.cases} of ${total} cases`}
            onClick={() =>
              segment.category
                ? onSelect(segment.category === activeCategory ? undefined : segment.category)
                : undefined
            }
          >
            <span className="sr-only">
              {segment.label}: {segment.cases} of {total} cases
            </span>
          </button>
        ))}
      </div>

      <ul className="composition-keys">
        {segments.map((segment) => (
          <li key={segment.key}>
            <button
              type="button"
              className={`composition-key${
                segment.category && segment.category === activeCategory ? ' is-active' : ''
              }`}
              disabled={segment.category === null}
              onClick={() =>
                segment.category
                  ? onSelect(segment.category === activeCategory ? undefined : segment.category)
                  : undefined
              }
            >
              <span
                className={`key-swatch mark ${segment.category ? 'mark-lost' : 'mark-gained'}`}
                aria-hidden="true"
              />
              <span className="composition-key-label">{segment.label}</span>
              <span className="composition-key-count tabular">{segment.cases}</span>
            </button>
          </li>
        ))}
      </ul>

      <p className="composition-note muted">
        {failingTotal.toLocaleString('en-US')} of {total.toLocaleString('en-US')} fail at least one
        attempt — {percent(failingTotal / total)}. Each case counts once.
      </p>
    </div>
  );
}
