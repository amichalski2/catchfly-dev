/**
 * Deterministic query primitives over the eval dataset.
 *
 * This is the one place that knows how to answer "what regressed?". The UI
 * calls these functions from React components; the WebMCP tools call the very
 * same functions from `execute()`. Interpretation is left to the agent — the
 * rule from the PRD is that Catchfly exposes primitives, not `interpret_data()`.
 */

import { attemptsFor, toolsOf, type CatchflyDb } from './db.ts';
import type {
  AppVersion,
  CaseResult,
  EvalCase,
  EvalRun,
  FailureCategory,
  Outcome,
  RunMetrics,
  ToolCall,
  TrajectoryStep,
} from './types.ts';

// --- runs --------------------------------------------------------------

export type RunSummary = {
  runId: string;
  appVersionId: string;
  appVersionLabel: string;
  model: string;
  backend?: string;
  timestamp: string;
  metrics: RunMetrics;
};

function summarize(db: CatchflyDb, run: EvalRun): RunSummary {
  return {
    runId: run.id,
    appVersionId: run.appVersionId,
    appVersionLabel: db.versionsById.get(run.appVersionId)?.label ?? run.appVersionId,
    model: run.model,
    backend: run.backend,
    timestamp: run.timestamp,
    metrics: run.metrics,
  };
}

export function listRuns(
  db: CatchflyDb,
  filter: { appVersionId?: string; model?: string } = {},
): RunSummary[] {
  return db.dataset.runs
    .filter((run) => !filter.appVersionId || run.appVersionId === filter.appVersionId)
    .filter((run) => !filter.model || run.model === filter.model)
    .map((run) => summarize(db, run))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

export function getRun(db: CatchflyDb, runId: string): EvalRun {
  const run = db.runsById.get(runId);
  if (!run) throw new Error(`Unknown run: ${runId}`);
  return run;
}

function failuresByCategory(run: EvalRun): Map<FailureCategory, number> {
  const counts = new Map<FailureCategory, number>();
  for (const result of run.results) {
    if (!result.category) continue;
    counts.set(result.category, (counts.get(result.category) ?? 0) + 1);
  }
  return counts;
}

export type RunComparison = {
  baseline: RunSummary;
  candidate: RunSummary;
  delta: {
    successRate: number;
    passCount: number;
    /** Zero when either run did not record the measurement. */
    avgLatencyMs: number;
    totalCostUsd: number;
  };
  byCategory: Array<{
    category: FailureCategory;
    baselineFailures: number;
    candidateFailures: number;
    delta: number;
  }>;
};

export function compareRuns(db: CatchflyDb, baselineRunId: string, candidateRunId: string): RunComparison {
  const baseline = getRun(db, baselineRunId);
  const candidate = getRun(db, candidateRunId);
  const before = failuresByCategory(baseline);
  const after = failuresByCategory(candidate);
  const categories = [...new Set([...before.keys(), ...after.keys()])];

  return {
    baseline: summarize(db, baseline),
    candidate: summarize(db, candidate),
    delta: {
      successRate: candidate.metrics.successRate - baseline.metrics.successRate,
      passCount: candidate.metrics.passCount - baseline.metrics.passCount,
      avgLatencyMs:
        candidate.metrics.avgLatencyMs === undefined || baseline.metrics.avgLatencyMs === undefined
          ? 0
          : candidate.metrics.avgLatencyMs - baseline.metrics.avgLatencyMs,
      totalCostUsd:
        candidate.metrics.totalCostUsd === undefined || baseline.metrics.totalCostUsd === undefined
          ? 0
          : Math.round((candidate.metrics.totalCostUsd - baseline.metrics.totalCostUsd) * 1e4) / 1e4,
    },
    byCategory: categories
      .map((category) => ({
        category,
        baselineFailures: before.get(category) ?? 0,
        candidateFailures: after.get(category) ?? 0,
        delta: (after.get(category) ?? 0) - (before.get(category) ?? 0),
      }))
      .sort((a, b) => b.delta - a.delta),
  };
}

// --- regressions -------------------------------------------------------

function passCountsByCase(run: EvalRun): Map<string, number> {
  const counts = new Map<string, number>();
  for (const result of run.results) {
    const current = counts.get(result.caseId) ?? 0;
    counts.set(result.caseId, current + (result.outcome === 'pass' ? 1 : 0));
  }
  return counts;
}

export type RegressedCase = {
  caseId: string;
  name: string;
  category: FailureCategory;
  baselinePasses: number;
  candidatePasses: number;
  /** Passing attempts the candidate lost — the unit the dashboard counts. */
  lostAttempts: number;
  repeats: number;
  failureReason?: string;
};

export type RegressionReport = {
  baselineRunId: string;
  candidateRunId: string;
  /** Attempts that passed in the baseline and no longer pass. */
  regressedAttempts: number;
  /** Attempts that failed in the baseline and now pass. */
  fixedAttempts: number;
  netAttemptDelta: number;
  affectedCases: number;
  byCategory: Array<{ category: FailureCategory; attempts: number; cases: number }>;
  cases: RegressedCase[];
  fixedCases: Array<{ caseId: string; name: string; gainedAttempts: number }>;
};

/**
 * A regression is a *lost passing attempt*: the case used to pass N times out
 * of `repeats` and now passes fewer. Counting attempts rather than cases keeps
 * flaky behaviour visible instead of rounding it away, and it is what makes the
 * headline number reconcile with the success-rate delta.
 *
 * Failures already present in the baseline are ignored by construction.
 */
export function findRegressions(
  db: CatchflyDb,
  baselineRunId: string,
  candidateRunId: string,
): RegressionReport {
  const baseline = getRun(db, baselineRunId);
  const candidate = getRun(db, candidateRunId);
  const before = passCountsByCase(baseline);
  const after = passCountsByCase(candidate);

  const dominantCategory = new Map<string, { category: FailureCategory; reason?: string }>();
  for (const result of candidate.results) {
    if (result.category && !dominantCategory.has(result.caseId)) {
      dominantCategory.set(result.caseId, { category: result.category, reason: result.failureReason });
    }
  }

  const cases: RegressedCase[] = [];
  const fixedCases: RegressionReport['fixedCases'] = [];
  let regressedAttempts = 0;
  let fixedAttempts = 0;

  for (const [caseId, baselinePasses] of before) {
    const candidatePasses = after.get(caseId) ?? 0;
    const delta = baselinePasses - candidatePasses;
    if (delta > 0) {
      regressedAttempts += delta;
      const dominant = dominantCategory.get(caseId);
      cases.push({
        caseId,
        name: db.casesById.get(caseId)?.name ?? caseId,
        category: dominant?.category ?? 'error',
        baselinePasses,
        candidatePasses,
        lostAttempts: delta,
        repeats: db.repeats,
        failureReason: dominant?.reason,
      });
    } else if (delta < 0) {
      fixedAttempts += -delta;
      fixedCases.push({
        caseId,
        name: db.casesById.get(caseId)?.name ?? caseId,
        gainedAttempts: -delta,
      });
    }
  }

  const byCategory = new Map<FailureCategory, { attempts: number; cases: number }>();
  for (const entry of cases) {
    const bucket = byCategory.get(entry.category) ?? { attempts: 0, cases: 0 };
    bucket.attempts += entry.lostAttempts;
    bucket.cases += 1;
    byCategory.set(entry.category, bucket);
  }

  cases.sort((a, b) => b.lostAttempts - a.lostAttempts || a.caseId.localeCompare(b.caseId));
  fixedCases.sort((a, b) => b.gainedAttempts - a.gainedAttempts || a.caseId.localeCompare(b.caseId));

  return {
    baselineRunId,
    candidateRunId,
    regressedAttempts,
    fixedAttempts,
    netAttemptDelta: fixedAttempts - regressedAttempts,
    affectedCases: cases.length,
    byCategory: [...byCategory]
      .map(([category, bucket]) => ({ category, ...bucket }))
      .sort((a, b) => b.attempts - a.attempts),
    cases,
    fixedCases,
  };
}

// --- cases -------------------------------------------------------------

export type CaseFilters = {
  runId?: string;
  appVersionId?: string;
  model?: string;
  category?: FailureCategory;
  outcome?: Outcome | 'any-failure';
  /** Free text over case name and prompt. */
  search?: string;
  /** Restricts to an explicit set — how the agent pins a regression list into the table. */
  caseIds?: string[];
  toolCalled?: string;
};

export type CaseRow = {
  caseId: string;
  name: string;
  prompt: string;
  runId: string;
  appVersionId: string;
  appVersionLabel: string;
  model: string;
  repeats: number;
  passes: number;
  failures: number;
  errors: number;
  passRate: number;
  category?: FailureCategory;
  categories: FailureCategory[];
  tools: string[];
  avgLatencyMs: number;
  costUsd: number;
};

function buildRow(db: CatchflyDb, run: EvalRun, evalCase: EvalCase, attempts: CaseResult[]): CaseRow {
  const passes = attempts.filter((attempt) => attempt.outcome === 'pass').length;
  const errors = attempts.filter((attempt) => attempt.outcome === 'error').length;
  const categoryCounts = new Map<FailureCategory, number>();
  const tools = new Set<string>();
  let latency = 0;
  let cost = 0;

  for (const attempt of attempts) {
    if (attempt.category) categoryCounts.set(attempt.category, (categoryCounts.get(attempt.category) ?? 0) + 1);
    for (const call of attempt.actualCalls) tools.add(call.functionName);
    latency += attempt.latencyMs ?? 0;
    cost += attempt.costUsd ?? 0;
  }

  const categories = [...categoryCounts].sort((a, b) => b[1] - a[1]).map(([category]) => category);

  return {
    caseId: evalCase.caseId,
    name: evalCase.name,
    prompt: evalCase.prompt,
    runId: run.id,
    appVersionId: run.appVersionId,
    appVersionLabel: db.versionsById.get(run.appVersionId)?.label ?? run.appVersionId,
    model: run.model,
    repeats: attempts.length,
    passes,
    failures: attempts.length - passes - errors,
    errors,
    passRate: attempts.length === 0 ? 0 : passes / attempts.length,
    category: categories[0],
    categories,
    tools: [...tools],
    avgLatencyMs: attempts.length === 0 ? 0 : Math.round(latency / attempts.length),
    costUsd: Math.round(cost * 1e6) / 1e6,
  };
}

export function filterCases(db: CatchflyDb, filters: CaseFilters = {}): CaseRow[] {
  const runs = db.dataset.runs.filter(
    (run) =>
      (!filters.runId || run.id === filters.runId) &&
      (!filters.appVersionId || run.appVersionId === filters.appVersionId) &&
      (!filters.model || run.model === filters.model),
  );
  const allowed = filters.caseIds ? new Set(filters.caseIds) : null;
  const needle = filters.search?.trim().toLowerCase();
  const rows: CaseRow[] = [];

  for (const run of runs) {
    for (const evalCase of db.dataset.cases) {
      if (allowed && !allowed.has(evalCase.caseId)) continue;
      if (needle && !`${evalCase.name} ${evalCase.prompt}`.toLowerCase().includes(needle)) continue;

      const attempts = attemptsFor(db, run.id, evalCase.caseId);
      if (attempts.length === 0) continue;

      if (filters.category && !attempts.some((attempt) => attempt.category === filters.category)) continue;
      if (filters.outcome === 'any-failure' && attempts.every((attempt) => attempt.outcome === 'pass')) {
        continue;
      }
      if (
        filters.outcome &&
        filters.outcome !== 'any-failure' &&
        !attempts.some((attempt) => attempt.outcome === filters.outcome)
      ) {
        continue;
      }
      if (
        filters.toolCalled &&
        !attempts.some((attempt) =>
          attempt.actualCalls.some((call) => call.functionName === filters.toolCalled),
        )
      ) {
        continue;
      }

      rows.push(buildRow(db, run, evalCase, attempts));
    }
  }

  return rows.sort((a, b) => a.passRate - b.passRate || a.caseId.localeCompare(b.caseId));
}

export type GroupBy = 'category' | 'outcome' | 'model' | 'appVersion' | 'tool';

export type Group = {
  key: string;
  cases: number;
  attempts: number;
  passes: number;
  passRate: number;
};

export function groupResults(rows: CaseRow[], groupBy: GroupBy): Group[] {
  const keysOf = (row: CaseRow): string[] => {
    switch (groupBy) {
      case 'category':
        return row.categories.length > 0 ? row.categories : ['passing'];
      case 'outcome':
        return [row.passRate === 1 ? 'pass' : row.errors > 0 ? 'error' : 'fail'];
      case 'model':
        return [row.model];
      case 'appVersion':
        return [row.appVersionId];
      case 'tool':
        return row.tools;
    }
  };

  const groups = new Map<string, Group>();
  for (const row of rows) {
    for (const key of keysOf(row)) {
      const group = groups.get(key) ?? { key, cases: 0, attempts: 0, passes: 0, passRate: 0 };
      group.cases += 1;
      group.attempts += row.repeats;
      group.passes += row.passes;
      groups.set(key, group);
    }
  }

  return [...groups.values()]
    .map((group) => ({ ...group, passRate: group.attempts === 0 ? 0 : group.passes / group.attempts }))
    .sort((a, b) => b.cases - a.cases || a.key.localeCompare(b.key));
}

// --- one case ----------------------------------------------------------

export type CaseDetail = {
  definition: EvalCase;
  runs: Array<{
    runId: string;
    appVersionId: string;
    appVersionLabel: string;
    model: string;
    passes: number;
    repeats: number;
    attempts: CaseResult[];
  }>;
};

export function getCase(db: CatchflyDb, caseId: string, runId?: string): CaseDetail {
  const definition = db.casesById.get(caseId);
  if (!definition) throw new Error(`Unknown case: ${caseId}`);

  const runs = db.dataset.runs
    .filter((run) => !runId || run.id === runId)
    .map((run) => {
      const attempts = attemptsFor(db, run.id, caseId);
      return {
        runId: run.id,
        appVersionId: run.appVersionId,
        appVersionLabel: db.versionsById.get(run.appVersionId)?.label ?? run.appVersionId,
        model: run.model,
        passes: attempts.filter((attempt) => attempt.outcome === 'pass').length,
        repeats: attempts.length,
        attempts,
      };
    })
    .filter((entry) => entry.repeats > 0);

  return { definition, runs };
}

// --- trajectories ------------------------------------------------------

export type TrajectorySide = {
  runId: string;
  appVersionLabel: string;
  runIndex: number;
  outcome: Outcome;
  calls: ToolCall[];
  trajectory: TrajectoryStep[];
  failureReason?: string;
  availableTools: string[];
};

export type TrajectoryComparison = {
  caseId: string;
  name: string;
  prompt: string;
  expectedTools: string[];
  baseline: TrajectorySide;
  candidate: TrajectorySide;
  /** Index of the first call where the two runs stop agreeing, or -1. */
  firstDivergenceIndex: number;
  divergence?: { baselineTool?: string; candidateTool?: string };
  /** Tools the candidate could call but the baseline could not, and vice versa. */
  toolManifestDelta: { added: string[]; removed: string[] };
};

/** Prefers an attempt with the given outcome, falling back to the first one. */
function pickAttempt(attempts: CaseResult[], preferred: Outcome): CaseResult {
  return attempts.find((attempt) => attempt.outcome === preferred) ?? attempts[0];
}

export function compareTrajectories(
  db: CatchflyDb,
  caseId: string,
  baselineRunId: string,
  candidateRunId: string,
): TrajectoryComparison {
  const definition = db.casesById.get(caseId);
  if (!definition) throw new Error(`Unknown case: ${caseId}`);

  const baselineRun = getRun(db, baselineRunId);
  const candidateRun = getRun(db, candidateRunId);
  const baselineAttempts = attemptsFor(db, baselineRunId, caseId);
  const candidateAttempts = attemptsFor(db, candidateRunId, caseId);
  if (baselineAttempts.length === 0 || candidateAttempts.length === 0) {
    throw new Error(`Case ${caseId} was not executed in both runs`);
  }

  const baselineAttempt = pickAttempt(baselineAttempts, 'pass');
  const candidateAttempt = pickAttempt(candidateAttempts, 'fail');

  const side = (run: EvalRun, attempt: CaseResult): TrajectorySide => ({
    runId: run.id,
    appVersionLabel: db.versionsById.get(run.appVersionId)?.label ?? run.appVersionId,
    runIndex: attempt.runIndex,
    outcome: attempt.outcome,
    calls: attempt.actualCalls,
    trajectory: attempt.trajectory,
    failureReason: attempt.failureReason,
    availableTools: toolsOf(db, run.appVersionId).map((tool) => tool.name),
  });

  const baseline = side(baselineRun, baselineAttempt);
  const candidate = side(candidateRun, candidateAttempt);

  let firstDivergenceIndex = -1;
  const longest = Math.max(baseline.calls.length, candidate.calls.length);
  for (let index = 0; index < longest; index += 1) {
    if (baseline.calls[index]?.functionName !== candidate.calls[index]?.functionName) {
      firstDivergenceIndex = index;
      break;
    }
  }

  const baselineTools = new Set(baseline.availableTools);
  const candidateTools = new Set(candidate.availableTools);

  return {
    caseId,
    name: definition.name,
    prompt: definition.prompt,
    expectedTools: expectedToolNames(definition),
    baseline,
    candidate,
    firstDivergenceIndex,
    divergence:
      firstDivergenceIndex < 0
        ? undefined
        : {
            baselineTool: baseline.calls[firstDivergenceIndex]?.functionName,
            candidateTool: candidate.calls[firstDivergenceIndex]?.functionName,
          },
    toolManifestDelta: {
      added: [...candidateTools].filter((tool) => !baselineTools.has(tool)),
      removed: [...baselineTools].filter((tool) => !candidateTools.has(tool)),
    },
  };
}

export function expectedToolNames(evalCase: EvalCase): string[] {
  const names: string[] = [];
  const walk = (nodes: EvalCase['expectedCall']) => {
    for (const node of nodes) {
      if ('ordered' in node) walk(node.ordered);
      else if ('unordered' in node) walk(node.unordered);
      else names.push(node.functionName);
    }
  };
  walk(evalCase.expectedCall);
  return names;
}

export function listAppVersions(db: CatchflyDb): AppVersion[] {
  return db.dataset.project.appVersions;
}
