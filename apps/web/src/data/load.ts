/**
 * Browser-side dataset bootstrap and switching.
 *
 * Datasets come from the API, not from a bundled file: what a visitor sees is
 * what is stored, including whatever anyone has imported since. Once a project
 * resolves, everything downstream — the UI, the query layer and the WebMCP
 * tools — reads it synchronously via `getDb()`, exactly as before.
 */

import { createDb, getDb, setDb, withRunResults, type CatchflyDb } from '@catchfly/core/db.ts';
import { listRuns } from '@catchfly/core/queries.ts';

import { catchflyStore, type ActionSource, type Comparison } from '../state/store.ts';
import {
  fetchDataset,
  fetchEvalBootstrap,
  fetchEvalCasesPage,
  fetchEvalResultsPage,
  fetchEvalRunsPage,
} from './api.ts';
import { projectInfo, registerProjectSwitcher } from './projects.ts';
import { connectSessions } from './sessions-remote.ts';

/** Built once per project, so switching back is instant and keeps any imports. */
const loaded = new Map<string, CatchflyDb>();

/** A project above this size uses bounded API pages instead of `/dataset`. */
const PAGED_RUN_THRESHOLD = 30;

/**
 * Result pages are fetched a run at a time. Two at once left the connection
 * mostly idle waiting on round trips; six saturates it without asking the
 * server for more concurrency than its pool will hand out.
 */
const RESULT_FETCH_CONCURRENCY = 6;

async function allPages<T>(read: (cursor: string | null) => Promise<{ items: T[]; nextCursor: string | null }>): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | null = null;
  do {
    const page = await read(cursor);
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

async function mapConcurrent<T, R>(items: T[], concurrency: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      output[index] = await work(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return output;
}

async function fetchPagedProject(projectId: string): Promise<CatchflyDb> {
  const bootstrap = await fetchEvalBootstrap(projectId);
  const [cases, runSummaries] = await Promise.all([
    allPages(async (cursor) => {
      const page = await fetchEvalCasesPage(projectId, cursor);
      return { items: page.cases, nextCursor: page.nextCursor };
    }),
    allPages(async (cursor) => {
      const page = await fetchEvalRunsPage(projectId, cursor);
      return { items: page.runs, nextCursor: page.nextCursor };
    }),
  ]);
  // Large projects boot from summaries. Loading every trajectory here made a
  // 27k-attempt project issue hundreds of requests before it could render.
  // Run bodies are filled only when a comparison is opened.
  const runs = runSummaries.map((summary) => ({ ...summary, results: [] }));
  return createDb({ project: bootstrap.project, cases, runs });
}

function currentDb(projectId: string): CatchflyDb | undefined {
  const cached = loaded.get(projectId);
  if (cached) return cached;
  try {
    const active = getDb();
    return active.dataset.project.id === projectId ? active : undefined;
  } catch {
    return undefined;
  }
}

function needsHydration(db: CatchflyDb, runId: string): boolean {
  const run = db.runsById.get(runId);
  return Boolean(run && run.results.length !== run.metrics.testCount);
}

export function summaryOnlyRuns(runIds: string[]): string[] {
  const db = currentDb(catchflyStore.getState().projectId);
  if (!db) return runIds;
  return runIds.filter((runId) => needsHydration(db, runId));
}

export function comparisonResultsLoaded(comparison: Comparison): boolean {
  const db = currentDb(catchflyStore.getState().projectId);
  if (!db) return false;
  return ![comparison.baselineRunId, comparison.candidateRunId].some((runId) =>
    needsHydration(db, runId),
  );
}

export async function ensureRunResults(runIds: string[]): Promise<void> {
  const projectId = catchflyStore.getState().projectId;
  const db = currentDb(projectId);
  if (!db) throw new Error(`Project ${projectId} is not loaded.`);
  const missing = Array.from(new Set(runIds)).filter((runId) => needsHydration(db, runId));
  if (missing.length === 0) return;
  const hydrated = await mapConcurrent(missing, RESULT_FETCH_CONCURRENCY, async (runId) => ({
    runId,
    results: await allPages(async (cursor) => {
      const page = await fetchEvalResultsPage(projectId, runId, cursor, 200);
      return { items: page.results, nextCursor: page.nextCursor };
    }),
  }));
  const byRun = new Map(hydrated.map((entry) => [entry.runId, entry.results]));
  const next = withRunResults(db, byRun);
  loaded.set(projectId, next);
  setDb(next);
  catchflyStore.getState().refreshDataset();
}

export async function ensureComparisonResults(comparison: Comparison): Promise<void> {
  await ensureRunResults([comparison.baselineRunId, comparison.candidateRunId]);
}

export async function activateComparison(
  comparison: Comparison,
  source: ActionSource = 'human',
): Promise<void> {
  await ensureComparisonResults(comparison);
  catchflyStore.getState().setComparison(comparison, source);
}

async function fetchProject(projectId: string): Promise<CatchflyDb> {
  const cached = loaded.get(projectId);
  if (cached) return cached;
  const info = projectInfo(projectId);
  const db =
    (info?.runCount ?? 0) > PAGED_RUN_THRESHOLD
      ? await fetchPagedProject(projectId)
      : createDb(await fetchDataset(projectId));
  loaded.set(projectId, db);
  return db;
}

/** Drops a project's cache, so the next load sees what the server now holds. */
export function invalidateProject(projectId: string): void {
  loaded.delete(projectId);
}

/**
 * Production against the candidate, on the model both were evaluated with.
 *
 * A project with a single run is a normal state — someone has just imported
 * their first report — so it compares that run with itself rather than refusing
 * to load. Only an empty project has nothing to show.
 */
export function defaultComparison(db: CatchflyDb): Comparison | null {
  const runs = listRuns(db, { model: db.models[0] });
  if (runs.length === 0) return null;
  return { baselineRunId: runs[0].runId, candidateRunId: runs[runs.length > 1 ? 1 : 0].runId };
}

export async function loadDb(projectId: string): Promise<CatchflyDb> {
  return setDb(await fetchProject(projectId));
}

/** Loads (or revives) a project and resets the shared state onto it. */
export async function switchProject(projectId: string, source: ActionSource = 'human'): Promise<void> {
  const store = catchflyStore.getState();
  if (store.projectId === projectId) return;
  const info = projectInfo(projectId);
  if (!info) throw new Error(`Unknown project "${projectId}" — see list_projects.`);
  const db = await fetchProject(projectId);
  setDb(db);
  // Sessions belong to a project, so the cached ones are wrong the moment the
  // dashboard points somewhere else.
  connectSessions(projectId);
  catchflyStore.getState().switchDataset(projectId, info.name, defaultComparison(db), source);
}

// The WebMCP layer and the URL sync switch projects through the registry, so
// they never import this module.
registerProjectSwitcher(switchProject);
