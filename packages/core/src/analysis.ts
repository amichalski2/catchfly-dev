/**
 * Deterministic failure clustering for Catchfly comparisons.
 *
 * The split matters, and it is deliberate. *Which* failures belong together is
 * computed here, in plain code, from the same query primitives the dashboard
 * uses: a cluster is a set of regressed cases that share a failure category, a
 * trajectory divergence and a failure reason. Cluster membership is reproducible,
 * diffable and identical for every visitor.
 *
 * Optional prose can be attached by offline tooling. The application itself
 * performs no model calls; without attached prose it reports the deterministic
 * cluster and marks the root cause as not analyzed.
 *
 * Pure by construction — no React, no fetch, no DOM — so the same code runs in
 * offline tooling and in the browser.
 */

import type { CatchflyDb } from './db.ts';
import { compareTrajectories, findRegressions } from './queries.ts';
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

/** A cluster before display copy is attached. */
export type DerivedCluster = Omit<FailureCluster, keyof ClusterProse>;

export type AnalysisEntry = {
  baselineRunId: string;
  candidateRunId: string;
  clusters: FailureCluster[];
};

export type AnalysisProvenance = {
  /** Kept for file compatibility; this build always uses 'none'. */
  model: string;
  promptVersion: string;
  generatedAt: string;
  source: 'script';
};

/** A set of deterministically grouped comparisons. */
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
 * Deterministic display copy for a cluster. It states plainly that no root-cause
 * analysis was performed rather than inventing one.
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

/** Joins computed clusters with optional static prose, falling back per cluster. */
export function applyProse(
  clusters: DerivedCluster[],
  prose: Map<string, ClusterProse>,
): FailureCluster[] {
  return clusters.map((cluster) => ({ ...cluster, ...(prose.get(cluster.signature) ?? fallbackProse(cluster)) }));
}
