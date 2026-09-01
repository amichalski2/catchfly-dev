/**
 * Registry for the analysis artefact, mirroring the dataset registry in db.ts.
 *
 * Kept separate from `CatchflyDb` on purpose: the analysis is a second,
 * optional artefact with its own lifecycle. Folding it into `CatchflyDataset`
 * would make every fixture regeneration and every report import responsible for
 * carrying it, and would turn a missing file into a broken dataset.
 *
 * Three states, not two: *unset* (still loading), *loaded* and *unavailable*.
 * The distinction is what lets a tool answer immediately and honestly instead
 * of hanging on a promise that will never resolve — a page served without the
 * fixture is a degraded page, not a broken one. Both terminal states settle
 * `whenAnalysisSettled()`.
 *
 * Mutable, because analysis for an imported run arrives at runtime from the
 * serverless function. React-free, like the rest of src/data — the UI observes
 * it through `subscribeAnalysis` in src/state/useAnalysis.ts.
 */

import { comparisonKey, type AnalysisEntry, type AnalysisFile, type AnalysisProvenance } from './analysis.ts';

let entries = new Map<string, AnalysisEntry>();
let provenance: AnalysisProvenance | null = null;
let settled = false;
let version = 0;

let announceSettled: () => void = () => {};
const settledPromise = new Promise<void>((resolve) => {
  announceSettled = resolve;
});

const listeners = new Set<() => void>();

function changed(): void {
  version += 1;
  for (const listener of listeners) listener();
}

function settle(): void {
  if (settled) return;
  settled = true;
  announceSettled();
}

/** Registers a loaded analysis file. Wins over a previous "unavailable". */
export function setAnalysis(file: AnalysisFile): void {
  entries = new Map(file.entries.map((entry) => [comparisonKey(entry.baselineRunId, entry.candidateRunId), entry]));
  provenance = file.provenance;
  settle();
  changed();
}

/** The file is absent or failed to load: analysis is a feature the page does without. */
export function setAnalysisUnavailable(): void {
  settle();
  changed();
}

/**
 * Adds analysis produced at runtime — the serverless function answering for an
 * imported run. Replaces any entry for the same comparison.
 */
export function addAnalysisEntry(entry: AnalysisEntry, entryProvenance: AnalysisProvenance): void {
  entries.set(comparisonKey(entry.baselineRunId, entry.candidateRunId), entry);
  provenance = entryProvenance;
  settle();
  changed();
}

/**
 * Resolves once the analysis has either loaded or been declared unavailable.
 * Never hangs: every load path ends in one of the two setters.
 */
export function whenAnalysisSettled(): Promise<void> {
  return settled ? Promise.resolve() : settledPromise;
}

export function getAnalysisEntry(baselineRunId: string, candidateRunId: string): AnalysisEntry | null {
  return entries.get(comparisonKey(baselineRunId, candidateRunId)) ?? null;
}

export function getAnalysisProvenance(): AnalysisProvenance | null {
  return provenance;
}

export function isAnalysisLoaded(): boolean {
  return entries.size > 0;
}

// --- change feed for the UI --------------------------------------------

export function subscribeAnalysis(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Monotonic counter; `useSyncExternalStore` snapshots it to detect changes. */
export function getAnalysisVersion(): number {
  return version;
}
