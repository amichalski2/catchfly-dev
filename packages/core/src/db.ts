/**
 * In-memory index over the dataset. Pure — no React, no fetch, no WebMCP — so
 * the query layer can run identically in the browser and in a Node script.
 */

import type {
  AppVersion,
  CaseResult,
  CatchflyDataset,
  EvalCase,
  EvalRun,
  ToolSchema,
} from './types.ts';

export type CatchflyDb = {
  dataset: CatchflyDataset;
  versionsById: Map<string, AppVersion>;
  runsById: Map<string, EvalRun>;
  casesById: Map<string, EvalCase>;
  /** Attempts for one case inside one run, keyed `${runId}::${caseId}`. */
  attemptsByRunCase: Map<string, CaseResult[]>;
  runIdsByVersion: Map<string, string[]>;
  models: string[];
  /** How many times each case was repeated per run (the CLI's `--runs`). */
  repeats: number;
};

export const attemptKey = (runId: string, caseId: string) => `${runId}::${caseId}`;

export function createDb(dataset: CatchflyDataset): CatchflyDb {
  const versionsById = new Map(dataset.project.appVersions.map((version) => [version.id, version]));
  const runsById = new Map(dataset.runs.map((run) => [run.id, run]));
  const casesById = new Map(dataset.cases.map((evalCase) => [evalCase.caseId, evalCase]));

  const attemptsByRunCase = new Map<string, CaseResult[]>();
  const runIdsByVersion = new Map<string, string[]>();
  let repeats = 0;

  for (const run of dataset.runs) {
    runIdsByVersion.set(run.appVersionId, [...(runIdsByVersion.get(run.appVersionId) ?? []), run.id]);
    for (const result of run.results) {
      const key = attemptKey(run.id, result.caseId);
      const bucket = attemptsByRunCase.get(key);
      if (bucket) bucket.push(result);
      else attemptsByRunCase.set(key, [result]);
      if (result.runIndex > repeats) repeats = result.runIndex;
    }
  }

  const models = [...new Set(dataset.runs.map((run) => run.model))];

  return { dataset, versionsById, runsById, casesById, attemptsByRunCase, runIdsByVersion, models, repeats };
}

/** The same index with `results` filled in for the given runs. */
export function withRunResults(db: CatchflyDb, resultsByRun: Map<string, CaseResult[]>): CatchflyDb {
  if (resultsByRun.size === 0) return db;

  const attemptsByRunCase = new Map(db.attemptsByRunCase);
  const runsById = new Map(db.runsById);
  let repeats = db.repeats;

  for (const [runId, results] of resultsByRun) {
    const run = db.runsById.get(runId);
    if (!run) continue;
    for (const stale of run.results) attemptsByRunCase.delete(attemptKey(runId, stale.caseId));
    for (const result of results) {
      const key = attemptKey(runId, result.caseId);
      const bucket = attemptsByRunCase.get(key);
      if (bucket) bucket.push(result);
      else attemptsByRunCase.set(key, [result]);
      if (result.runIndex > repeats) repeats = result.runIndex;
    }
    runsById.set(runId, { ...run, results });
  }

  const runs = db.dataset.runs.map((run) => runsById.get(run.id) ?? run);
  return {
    ...db,
    dataset: { ...db.dataset, runs },
    runsById,
    attemptsByRunCase,
    repeats,
  };
}

// --- the active dataset ------------------------------------------------
//
// One process holds one dataset. Keeping the registry here — rather than in the
// browser loader — means the query layer, the selectors and the WebMCP tools
// depend only on pure code, and can be driven from a Node script just as well
// as from the page.

let active: CatchflyDb | null = null;

/**
 * Resolves once a dataset is registered. WebMCP tools are registered with the
 * page before the data finishes loading — a browser that snapshots the tool
 * list at load time must not find an empty page — so a tool invoked in that
 * window awaits this rather than failing.
 */
let announceReady: (db: CatchflyDb) => void = () => {};
const ready = new Promise<CatchflyDb>((resolve) => {
  announceReady = resolve;
});

export function setDb(db: CatchflyDb): CatchflyDb {
  active = db;
  announceReady(db);
  return db;
}

export function whenDbReady(): Promise<CatchflyDb> {
  return active ? Promise.resolve(active) : ready;
}

/** Synchronous access for callers that run after boot — UI and WebMCP tools. */
export function getDb(): CatchflyDb {
  if (!active) throw new Error('No dataset is loaded');
  return active;
}

export function isDbLoaded(): boolean {
  return active !== null;
}

export function attemptsFor(db: CatchflyDb, runId: string, caseId: string): CaseResult[] {
  return db.attemptsByRunCase.get(attemptKey(runId, caseId)) ?? [];
}

export function toolsOf(db: CatchflyDb, appVersionId: string): ToolSchema[] {
  return db.versionsById.get(appVersionId)?.toolManifest ?? [];
}
