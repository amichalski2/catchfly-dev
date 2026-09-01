/**
 * Failure clustering — the deterministic half of Catchfly's AI-assisted analysis.
 *
 * The split matters, and it is deliberate. *Which* failures belong together is
 * computed here, in plain code, from the same query primitives the dashboard
 * uses: a cluster is a set of regressed cases that share a failure category, a
 * trajectory divergence and a failure reason. A model never decides membership,
 * so the clusters are reproducible, diffable and identical for every visitor.
 *
 * What a model contributes is prose — a label, a summary, a root-cause
 * hypothesis (`ClusterProse`). That is written once, offline, by
 * `scripts/generate-analysis.ts`, and committed as a fixture; the browser only
 * reads it. Imported runs, which have no precomputed prose, can get it from the
 * Netlify function at runtime.
 *
 * Pure by construction — no React, no fetch, no DOM — so the same code runs in
 * the generator script, in the browser and inside the serverless function.
 */

import type { ClusterBrief, PromptInput } from './analysis-prompt.ts';
export { PROMPT_VERSION } from './analysis-prompt.ts';
import { toolsOf, type CatchflyDb } from './db.ts';
import { compareTrajectories, expectedToolNames, findRegressions, getRun } from './queries.ts';
import type { FailureCategory } from './types.ts';

/** What the model writes. Everything else on a cluster is computed. */
export type ClusterProse = {
  /** Short human label, e.g. "Catalog search shadowed". */
  label: string;
  /** One or two sentences describing what the cluster has in common. */
  summary: string;
  /** A hypothesis, phrased as such — never presented as a verified finding. */
  rootCause: string;
};

/** Where the first call of the candidate stops matching the baseline. */
export type ClusterDivergence = {
  baselineTool: string | null;
  candidateTool: string | null;
};

/**
 * A group of regressed cases that failed the same way.
 *
 * The counting fields mirror `Group` in queries.ts so a cluster reads like any
 * other grouping in the product, plus `lostAttempts` — the regression unit the
 * whole dashboard counts in.
 */
export type FailureCluster = ClusterProse & {
  /** Stable identity of the cluster; also the join key for prose. */
  signature: string;
  category: FailureCategory;
  divergence: ClusterDivergence;
  /** A representative raw failure reason, kept unnormalized for display. */
  failureReason: string | null;
  /** Member cases, sorted — feeds set_dashboard_filters({ caseIds }). */
  caseIds: string[];
  cases: number;
  attempts: number;
  passes: number;
  passRate: number;
  /** Passing attempts these cases lost in the candidate run. */
  lostAttempts: number;
};

/** A cluster before a model has written anything about it. */
export type DerivedCluster = Omit<FailureCluster, keyof ClusterProse>;

export type AnalysisEntry = {
  baselineRunId: string;
  candidateRunId: string;
  clusters: FailureCluster[];
};

export type AnalysisProvenance = {
  /** Model that wrote the prose, or 'none' when it was generated offline. */
  model: string;
  promptVersion: string;
  generatedAt: string;
  source: 'script' | 'function';
};

/** A set of analysed comparisons, as /api/analyze returns them. */
export type AnalysisFile = {
  version: 1;
  provenance: AnalysisProvenance;
  entries: AnalysisEntry[];
};

/** Mirrors `attemptKey` in db.ts: one comparison, one key. */
export const comparisonKey = (baselineRunId: string, candidateRunId: string) =>
  `${baselineRunId}::${candidateRunId}`;

/**
 * Collapses the variable parts of a failure reason so that two attempts that
 * failed for the same reason land in the same cluster — "timed out after 30000
 * ms" and "timed out after 45000 ms" are one failure mode, not two.
 */
export function normalizeReason(reason: string): string {
  return reason
    .toLowerCase()
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
}

export function clusterSignature(
  category: FailureCategory,
  divergence: ClusterDivergence,
  reason: string | null,
): string {
  const from = divergence.baselineTool ?? '-';
  const to = divergence.candidateTool ?? '-';
  return `${category} | ${from}→${to} | ${normalizeReason(reason ?? '')}`;
}

/** The most frequent value, ties broken alphabetically so runs are reproducible. */
function mostCommon(values: string[]): string | null {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  const ranked = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return ranked[0]?.[0] ?? null;
}

/**
 * Groups the regressions between two runs into failure clusters.
 *
 * Deterministic: same dataset in, byte-identical clusters out. Cases that
 * cannot be compared (not executed in both runs) are grouped by category and
 * reason alone rather than dropped — a case that vanished from a run is still a
 * regression the developer needs to see.
 */
export function deriveClusters(
  db: CatchflyDb,
  baselineRunId: string,
  candidateRunId: string,
): DerivedCluster[] {
  const report = findRegressions(db, baselineRunId, candidateRunId);

  type Bucket = {
    category: FailureCategory;
    divergence: ClusterDivergence;
    caseIds: string[];
    reasons: string[];
    lostAttempts: number;
    attempts: number;
    passes: number;
  };
  const buckets = new Map<string, Bucket>();

  for (const entry of report.cases) {
    let divergence: ClusterDivergence = { baselineTool: null, candidateTool: null };
    try {
      const comparison = compareTrajectories(db, entry.caseId, baselineRunId, candidateRunId);
      divergence = {
        baselineTool: comparison.divergence?.baselineTool ?? null,
        candidateTool: comparison.divergence?.candidateTool ?? null,
      };
    } catch {
      // The case is not comparable across the two runs; category and reason
      // still identify the failure mode.
    }

    const reason = entry.failureReason ?? null;
    const signature = clusterSignature(entry.category, divergence, reason);
    const bucket = buckets.get(signature) ?? {
      category: entry.category,
      divergence,
      caseIds: [],
      reasons: [],
      lostAttempts: 0,
      attempts: 0,
      passes: 0,
    };
    bucket.caseIds.push(entry.caseId);
    if (reason) bucket.reasons.push(reason);
    bucket.lostAttempts += entry.lostAttempts;
    bucket.attempts += entry.repeats;
    bucket.passes += entry.candidatePasses;
    buckets.set(signature, bucket);
  }

  return [...buckets]
    .map(([signature, bucket]): DerivedCluster => ({
      signature,
      category: bucket.category,
      divergence: bucket.divergence,
      failureReason: mostCommon(bucket.reasons),
      caseIds: [...bucket.caseIds].sort((a, b) => a.localeCompare(b)),
      cases: bucket.caseIds.length,
      attempts: bucket.attempts,
      passes: bucket.passes,
      passRate: bucket.attempts === 0 ? 0 : Number((bucket.passes / bucket.attempts).toFixed(4)),
      lostAttempts: bucket.lostAttempts,
    }))
    .sort((a, b) => b.lostAttempts - a.lostAttempts || a.signature.localeCompare(b.signature));
}

/**
 * Prose for a cluster no model has looked at — used by `--offline` generation
 * and as a per-cluster fallback when a model reply comes back incomplete.
 * States plainly that nothing was analyzed, rather than inventing a cause.
 */
export function fallbackProse(cluster: DerivedCluster): ClusterProse {
  const { baselineTool, candidateTool } = cluster.divergence;
  // The tool swap identifies a cluster far better than its category does, and
  // fits the bar labels; the category is the fallback's fallback.
  const label =
    baselineTool && candidateTool ? `${baselineTool} → ${candidateTool}` : cluster.category;
  return {
    label,
    summary:
      `${cluster.cases} case${cluster.cases === 1 ? '' : 's'} lost ${cluster.lostAttempts} ` +
      `passing attempt${cluster.lostAttempts === 1 ? '' : 's'}` +
      (cluster.failureReason ? `. ${cluster.failureReason}` : '.'),
    rootCause: 'Not analyzed — no root-cause hypothesis was written for this cluster.',
  };
}

/** Joins computed clusters with model-written prose, falling back per cluster. */
export function applyProse(
  clusters: DerivedCluster[],
  prose: Map<string, ClusterProse>,
): FailureCluster[] {
  return clusters.map((cluster) => ({ ...cluster, ...(prose.get(cluster.signature) ?? fallbackProse(cluster)) }));
}

// --- model input -------------------------------------------------------

/** Enough cases for the model to see the pattern, few enough to stay cheap. */
export const SAMPLE_CASE_LIMIT = 3;

/**
 * Describes one comparison for a model: the two versions, what changed in the
 * tool manifest between them, and the clusters with a few sample cases each.
 *
 * Everything here is derived from the dataset, which is what lets the
 * serverless function compose its prompt from validated facts rather than from
 * caller-supplied text.
 */
export function buildPromptInput(
  db: CatchflyDb,
  baselineRunId: string,
  candidateRunId: string,
  clusters: DerivedCluster[],
): PromptInput {
  const baseline = getRun(db, baselineRunId);
  const candidate = getRun(db, candidateRunId);
  const baselineTools = new Set(toolsOf(db, baseline.appVersionId).map((tool) => tool.name));
  const candidateTools = new Set(toolsOf(db, candidate.appVersionId).map((tool) => tool.name));

  return {
    baselineLabel: db.versionsById.get(baseline.appVersionId)?.label ?? baseline.appVersionId,
    candidateLabel: db.versionsById.get(candidate.appVersionId)?.label ?? candidate.appVersionId,
    toolManifestDelta: {
      added: [...candidateTools].filter((tool) => !baselineTools.has(tool)),
      removed: [...baselineTools].filter((tool) => !candidateTools.has(tool)),
    },
    clusters: clusters.map((cluster) => clusterBrief(db, cluster)),
  };
}

export function clusterBrief(db: CatchflyDb, cluster: DerivedCluster): ClusterBrief {
  return {
    signature: cluster.signature,
    category: cluster.category,
    divergence: cluster.divergence,
    failureReason: cluster.failureReason,
    cases: cluster.cases,
    lostAttempts: cluster.lostAttempts,
    sampleCases: cluster.caseIds.slice(0, SAMPLE_CASE_LIMIT).flatMap((caseId) => {
      const definition = db.casesById.get(caseId);
      if (!definition) return [];
      return [
        {
          name: definition.name,
          prompt: definition.prompt,
          expectedTools: expectedToolNames(definition),
        },
      ];
    }),
  };
}
