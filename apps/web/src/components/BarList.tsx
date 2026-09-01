/**
 * Sorted horizontal bars in a single hue — the form for "compare magnitude".
 *
 * Failure categories are a magnitude ranking, not six identities, so they get
 * one sequential hue and a sort order rather than six colours. (The brand's
 * pastel range cannot carry six categorical hues: every candidate palette fails
 * the chroma floor and reads as grey.)
 *
 * Mark spec: bars capped at 24px, 4px rounded data-end square at the baseline,
 * a 2px surface gap between neighbours, value labelled at the tip.
 */

import { useId, useState } from 'react';

export type BarDatum = {
  key: string;
  label: string;
  value: number;
  /** Optional second line in the tooltip. */
  detail?: string;
};

type Props = {
  data: BarDatum[];
  /** Formats the value at the bar tip. */
  format?: (value: number) => string;
  /** Marks one bar as the one the story is about. */
  emphasisKey?: string;
  onSelect?: (key: string) => void;
  emptyLabel?: string;
};

const BAR_HEIGHT = 20;
const GAP = 10;
const LABEL_WIDTH = 148;
const VALUE_WIDTH = 56;

export function BarList({ data, format = String, emphasisKey, onSelect, emptyLabel }: Props) {
  const [hovered, setHovered] = useState<string | null>(null);
  const clipId = useId();

  if (data.length === 0) {
    return <p className="muted">{emptyLabel ?? 'Nothing to show.'}</p>;
  }

  const max = Math.max(...data.map((datum) => datum.value), 1);
  const rowHeight = BAR_HEIGHT + GAP;

  return (
    <div className="barlist">
      {data.map((datum) => {
        const share = datum.value / max;
        const emphasised = emphasisKey === undefined || emphasisKey === datum.key;
        const interactive = onSelect !== undefined;
        const Row = interactive ? 'button' : 'div';

        return (
          <Row
            key={datum.key}
            className={`barlist-row${interactive ? ' is-interactive' : ''}`}
            style={{ height: rowHeight, gridTemplateColumns: `${LABEL_WIDTH}px 1fr ${VALUE_WIDTH}px` }}
            onMouseEnter={() => setHovered(datum.key)}
            onMouseLeave={() => setHovered(null)}
            onFocus={() => setHovered(datum.key)}
            onBlur={() => setHovered(null)}
            {...(interactive ? { type: 'button' as const, onClick: () => onSelect(datum.key) } : {})}
          >
            <span className="barlist-label">{datum.label}</span>
            <span className="barlist-track">
              <span
                className={`barlist-bar mark ${emphasised ? 'mark-emphasis' : 'mark-quiet'}`}
                style={{
                  width: `${Math.max(share * 100, 1.5)}%`,
                  height: BAR_HEIGHT,
                  opacity: hovered === null || hovered === datum.key ? 1 : 0.55,
                }}
              />
            </span>
            <span className="barlist-value tabular">{format(datum.value)}</span>
            {hovered === datum.key && datum.detail ? (
              <span className="barlist-tip" role="tooltip" id={clipId}>
                {datum.detail}
              </span>
            ) : null}
          </Row>
        );
      })}
    </div>
  );
}
