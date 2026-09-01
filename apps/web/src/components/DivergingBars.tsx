/**
 * Lost against recovered attempts, per category, centred on zero.
 *
 * Polarity is the job here, so this is the one chart that spends the semantic
 * pair: rose left for attempts the candidate lost, sage right for attempts it
 * recovered, with a neutral rule at the midpoint. Both directions carry a
 * signed number, because sage sits at 2.39:1 against the page and must never be
 * the only thing distinguishing a bar.
 */

import { useState } from 'react';

export type DivergingDatum = {
  key: string;
  label: string;
  /** Attempts that stopped passing. */
  lost: number;
  /** Attempts that started passing. */
  gained: number;
};

const BAR_HEIGHT = 18;

export type Polarity = 'attempts' | 'failures' | 'traffic';

const POLARITY: Record<Polarity, { lost: string; gained: string; lostSign: string; gainedSign: string }> = {
  attempts: { lost: 'Lost', gained: 'Recovered', lostSign: '−', gainedSign: '+' },
  failures: { lost: 'More failures', gained: 'Fewer failures', lostSign: '+', gainedSign: '−' },
  traffic: { lost: 'Fewer calls', gained: 'More calls', lostSign: '−', gainedSign: '+' },
};

export function DivergingBars({
  data,
  onSelect,
  polarity = 'attempts',
  emptyLabel = 'No change between these runs.',
  limit,
  moreLabel = 'rows',
}: {
  data: DivergingDatum[];
  onSelect?: (key: string) => void;
  polarity?: Polarity;
  emptyLabel?: string;
  limit?: number;
  moreLabel?: string;
}) {
  const words = POLARITY[polarity];
  const [hovered, setHovered] = useState<string | null>(null);
  if (data.length === 0) return <p className="muted">{emptyLabel}</p>;

  const max = Math.max(...data.flatMap((datum) => [datum.lost, datum.gained]), 1);
  const cut = limit !== undefined && data.length > limit ? limit : data.length;
  const shown = data.slice(0, cut);
  const rest = data.slice(cut);

  const renderRow = (datum: DivergingDatum) => {
    const interactive = onSelect !== undefined;
    const Row = interactive ? 'button' : 'div';
    const dim = hovered !== null && hovered !== datum.key ? 0.55 : 1;
    return (
      <Row
        key={datum.key}
        className={`diverge-row${interactive ? ' is-interactive' : ''}`}
        onMouseEnter={() => setHovered(datum.key)}
        onMouseLeave={() => setHovered(null)}
        onFocus={() => setHovered(datum.key)}
        onBlur={() => setHovered(null)}
        {...(interactive ? { type: 'button' as const, onClick: () => onSelect(datum.key) } : {})}
      >
        <span className="diverge-label">{datum.label}</span>

        <span className="diverge-side is-left">
          {datum.lost > 0 ? (
            <span className="diverge-count tabular">
              {words.lostSign}
              {datum.lost}
            </span>
          ) : null}
          <span
            className="diverge-bar is-lost mark mark-lost"
            style={{
              width: `${(datum.lost / max) * 100}%`,
              height: BAR_HEIGHT,
              opacity: dim,
            }}
          />
        </span>

        <span className="diverge-axis" aria-hidden="true" />

        <span className="diverge-side is-right">
          <span
            className="diverge-bar is-gained mark mark-gained"
            style={{
              width: `${(datum.gained / max) * 100}%`,
              height: BAR_HEIGHT,
              opacity: dim,
            }}
          />
          {datum.gained > 0 ? (
            <span className="diverge-count tabular">
              {words.gainedSign}
              {datum.gained}
            </span>
          ) : null}
        </span>
      </Row>
    );
  };

  return (
    <div className="diverge">
      <div className="diverge-legend">
        <span className="key">
          <span className="key-swatch mark mark-lost" />
          {words.lost}
        </span>
        <span className="key">
          <span className="key-swatch mark mark-gained" />
          {words.gained}
        </span>
      </div>

      {shown.map(renderRow)}

      {rest.length > 0 ? (
        <details className="findings-more diverge-more">
          <summary>All {data.length} {moreLabel}</summary>
          {rest.map(renderRow)}
        </details>
      ) : null}
    </div>
  );
}
