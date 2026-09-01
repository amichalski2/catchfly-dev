/**
 * Number-shaped figures: the hero, stat tiles, deltas and the attempt strip.
 *
 * Two rules from the mark specs are load-bearing here. The hero figure is set
 * in the sans, never the display serif — a serif at that size reads as
 * decoration rather than data. And a delta's colour is its direction, so it is
 * always paired with a sign and a named comparison rather than standing alone.
 */

import type { ReactNode } from 'react';

// --- hero ---------------------------------------------------------------

export function HeroFigure({
  value,
  label,
  tone = 'neutral',
  caption,
}: {
  value: string;
  label: string;
  tone?: 'neutral' | 'regressed' | 'fixed';
  caption?: ReactNode;
}) {
  return (
    <div className="hero">
      <span className="eyebrow">{label}</span>
      <strong className={`hero-value tone-${tone}`}>{value}</strong>
      {caption ? <span className="hero-caption">{caption}</span> : null}
    </div>
  );
}

// --- delta --------------------------------------------------------------

export type Direction = 'up-good' | 'up-bad';

export function DeltaBadge({
  value,
  format,
  direction = 'up-good',
  versus,
}: {
  value: number;
  format: (value: number) => string;
  direction?: Direction;
  versus?: string;
}) {
  const good = direction === 'up-good' ? value > 0 : value < 0;
  const tone = value === 0 ? 'flat' : good ? 'fixed' : 'regressed';
  const arrow = value === 0 ? '±' : value > 0 ? '▲' : '▼';
  return (
    <span className={`delta tone-${tone}`}>
      <span aria-hidden="true">{arrow}</span>
      <span className="tabular">{format(Math.abs(value))}</span>
      {versus ? <span className="delta-versus">vs {versus}</span> : null}
    </span>
  );
}

// --- stat tile ----------------------------------------------------------

/**
 * A tile with `value: null` renders as "not measured" rather than as a zero.
 * Chrome's eval reports carry no latency or cost, and a confident `0 ms` would
 * be a claim the data does not support.
 */
export function StatTile({
  label,
  value,
  delta,
  footnote,
  unmeasuredNote,
}: {
  label: string;
  value: string | null;
  delta?: ReactNode;
  footnote?: string;
  unmeasuredNote?: string;
}) {
  if (value === null) {
    return (
      <div className="tile is-unmeasured">
        <span className="tile-label">{label}</span>
        <strong className="tile-value">Not measured</strong>
        <span className="tile-foot">
          <span className="muted">{unmeasuredNote ?? 'This run did not record it.'}</span>
        </span>
      </div>
    );
  }

  return (
    <div className="tile">
      <span className="tile-label">{label}</span>
      <strong className="tile-value">{value}</strong>
      <span className="tile-foot">
        {delta}
        {footnote ? <span className="muted">{footnote}</span> : null}
      </span>
    </div>
  );
}

// --- attempt strip ------------------------------------------------------

/**
 * Repeated attempts as filled cells: "3 of 5 passed" is legible from the count
 * of filled cells alone, so the pass/fail colour is never the only channel.
 */
export function AttemptStrip({
  passes,
  repeats,
  size = 'sm',
}: {
  passes: number;
  repeats: number;
  size?: 'sm' | 'md';
}) {
  return (
    <span className={`strip strip-${size}`} title={`${passes} of ${repeats} attempts passed`}>
      {Array.from({ length: repeats }, (_, index) => (
        <span key={index} className={`strip-cell${index < passes ? ' is-pass' : ''}`} />
      ))}
      <span className="strip-count tabular">
        {passes}/{repeats}
      </span>
    </span>
  );
}
