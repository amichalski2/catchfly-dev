/**
 * Human-readable names for the failure categories Catchfly derives.
 *
 * `error` is the one category that is not inferred from the calls: it maps
 * directly to Chrome's `outcome: 'error'`, which means the attempt did not
 * complete — a timeout or a harness failure — rather than the model choosing
 * badly. It is labelled accordingly, so it is never read as "the app's tool
 * returned an error".
 */

import type { FailureCategory } from './types.ts';

export const CATEGORY_LABELS: Record<FailureCategory, string> = {
  'tool-selection': 'Tool selection',
  'structured-output': 'Structured output',
  'argument-errors': 'Argument errors',
  'hallucinated-tool': 'Hallucinated tool',
  sequencing: 'Sequencing',
  error: 'Execution error',
};

const COUNT_FORMAT = new Intl.NumberFormat('en-US');
const MINUS = '\u2212';

export function formatCount(value: number): string {
  return COUNT_FORMAT.format(value);
}

export function signed(value: number, digits = 0): string {
  const magnitude = Math.abs(value).toFixed(digits);
  if (Number(magnitude) === 0) return `\u00b1${magnitude}`;
  return value > 0 ? `+${magnitude}` : `${MINUS}${magnitude}`;
}

export function formatPoints(deltaPoints: number): string {
  return `${signed(deltaPoints, 1)} pts`;
}

export function formatPercent(rate: number, digits = 1): string {
  return `${(rate * 100).toFixed(digits)}%`;
}

export function categoryLabel(category: string | undefined): string {
  if (!category) return '—';
  return CATEGORY_LABELS[category as FailureCategory] ?? category;
}

/**
 * App versions usually repeat the project name (`checkout-v42`, `catchfly-v1`).
 * Charts and dense tables only need the part that differs, so strip the prefix
 * every label shares — whole segments only, and only when there is one.
 */
export function versionShortener(labels: string[]): (label: string) => string {
  const distinct = [...new Set(labels)];
  if (distinct.length < 2) return (label) => label;

  let prefix = distinct[0];
  for (const label of distinct.slice(1)) {
    while (prefix && !label.startsWith(prefix)) prefix = prefix.slice(0, -1);
  }
  const cut = prefix.lastIndexOf('-') + 1;
  return cut > 0 ? (label) => label.slice(cut) : (label) => label;
}
