/**
 * The one place that knows how to ask a model to describe a failure cluster.
 *
 * Shared verbatim by the offline generator (scripts/generate-analysis.ts) and
 * the serverless function (netlify/functions/analyze.ts), so precomputed prose
 * and prose written for an imported report are produced the same way and carry
 * the same `promptVersion`.
 *
 * The prompt is composed here, from validated facts — never assembled from
 * text a caller supplied. That is what stops the public endpoint from being
 * usable as a general-purpose model proxy.
 *
 * Pure strings and JSON: no db, no fetch, no DOM.
 */

import type { ClusterDivergence, ClusterProse } from './analysis.ts';

/** What the model is told about one cluster. Sample cases are capped by callers. */
export type ClusterBrief = {
  signature: string;
  category: string;
  divergence: ClusterDivergence;
  failureReason: string | null;
  cases: number;
  lostAttempts: number;
  sampleCases: Array<{ name: string; prompt: string; expectedTools: string[] }>;
};

export type PromptInput = {
  baselineLabel: string;
  candidateLabel: string;
  toolManifestDelta: { added: string[]; removed: string[] };
  clusters: ClusterBrief[];
};

/** Bumped whenever the wording below changes, so provenance stays meaningful. */
export const PROMPT_VERSION = 'cluster-v1';

export const SYSTEM_PROMPT = [
  'You label failure clusters from an automated evaluation of a WebMCP application.',
  'The clusters are already computed: each one is a set of test cases that regressed the same way.',
  'Describe the clusters you are given. Do not invent, merge or split clusters, and do not add any.',
  'Reply with JSON only, shaped {"clusters":[{"signature":"...","label":"...","summary":"...","rootCause":"..."}]},',
  'echoing each signature back exactly as given.',
  'label: at most 5 words, no trailing punctuation.',
  'summary: one or two sentences stating what the member cases have in common.',
  'rootCause: one sentence, phrased as a hypothesis ("likely", "suggests"), naming a concrete mechanism',
  'such as overlapping tool descriptions, a renamed tool, or a changed argument contract.',
].join(' ');

export function buildUserPrompt(input: PromptInput): string {
  return JSON.stringify(
    {
      baselineVersion: input.baselineLabel,
      candidateVersion: input.candidateLabel,
      toolManifestDelta: input.toolManifestDelta,
      clusters: input.clusters,
    },
    null,
    2,
  );
}

export type ProseReply = {
  prose: Map<string, ClusterProse>;
  /** Signatures the model was asked about and did not return. */
  missing: string[];
  /** Signatures the model returned that were never asked about. */
  unexpected: string[];
};

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Parses a model reply against the signatures it was asked about.
 *
 * Deliberately lenient per cluster and strict overall: callers decide whether a
 * partial answer is a hard failure (the generator script, writing a committed
 * artefact) or something to patch with `fallbackProse` (the function, answering
 * a live request).
 */
export function parseProseReply(text: string, askedFor: string[]): ProseReply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Model reply was not JSON: ${text.slice(0, 200)}`);
  }

  const clusters = (parsed as { clusters?: unknown }).clusters;
  if (!Array.isArray(clusters)) {
    throw new Error('Model reply has no "clusters" array.');
  }

  const asked = new Set(askedFor);
  const prose = new Map<string, ClusterProse>();
  const unexpected: string[] = [];

  for (const raw of clusters) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    const signature = asText(entry.signature);
    if (!asked.has(signature)) {
      if (signature) unexpected.push(signature);
      continue;
    }
    const label = asText(entry.label);
    const summary = asText(entry.summary);
    const rootCause = asText(entry.rootCause);
    if (!label || !summary || !rootCause) continue;
    prose.set(signature, { label, summary, rootCause });
  }

  return {
    prose,
    missing: askedFor.filter((signature) => !prose.has(signature)),
    unexpected,
  };
}
