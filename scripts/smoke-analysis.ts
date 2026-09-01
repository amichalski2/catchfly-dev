/**
 * Checks the failure-clustering layer: that clustering is deterministic, that it
 * accounts for exactly the regressions the query layer reports, and that a
 * registered analysis reaches the agent with its provenance intact.
 *
 * Nothing here reads a committed analysis artefact. Prose is produced at runtime
 * by /api/analyze, so the suite registers an analysis the same way the runtime
 * does — deterministic clusters plus prose — and asserts the serving path.
 *
 * Order matters: the registry is a per-process singleton, so the degraded path
 * is exercised first, before an analysis is registered over it.
 *
 * Run with: npm run smoke
 */

import {
  applyProse,
  clusterSignature,
  deriveClusters,
  normalizeReason,
  PROMPT_VERSION,
} from '@catchfly/core/analysis.ts';
import { setAnalysis, setAnalysisUnavailable } from '@catchfly/core/analysis-db.ts';
import { findRegressions } from '@catchfly/core/queries.ts';
import { buildGlobalTools } from '../apps/web/src/webmcp/tools.ts';
import analyze from '../netlify/functions/analyze.ts';
import { loadTestDb, TEST_RUN_BASELINE, TEST_RUN_CANDIDATE } from './test-io.ts';

const db = loadTestDb();

const failures: string[] = [];
function check(label: string, condition: boolean, detail = ''): void {
  const status = condition ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  ${status} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures.push(label);
}

const BASELINE = TEST_RUN_BASELINE;
const CANDIDATE = TEST_RUN_CANDIDATE;

const clusterTool = () => {
  const tool = buildGlobalTools().find((entry) => entry.name === 'list_failure_clusters');
  if (!tool) throw new Error('list_failure_clusters is not registered');
  return tool;
};

async function main(): Promise<void> {
  // --- the page that never got its analysis ----------------------------
  //
  // Same state the browser reaches when the fetch fails. Asserted before
  // anything loads the real file, because the registry cannot be un-set.
  console.log('\n\x1b[1manalysis unavailable\x1b[0m');
  setAnalysisUnavailable();
  const degraded = (await clusterTool().execute({
    baselineRunId: BASELINE,
    candidateRunId: CANDIDATE,
  })) as { clusters: null; note: string };
  check('the tool answers instead of hanging', degraded.clusters === null);
  check(
    'and points the agent at the deterministic tools',
    degraded.note.includes('find_regressions') && degraded.note.includes('compare_trajectories'),
  );

  // --- clustering ------------------------------------------------------
  console.log('\n\x1b[1mclustering\x1b[0m');
  const once = deriveClusters(db, BASELINE, CANDIDATE);
  const twice = deriveClusters(db, BASELINE, CANDIDATE);
  check('clustering is deterministic', JSON.stringify(once) === JSON.stringify(twice), `${once.length} clusters`);

  const report = findRegressions(db, BASELINE, CANDIDATE);
  const lost = once.reduce((total, cluster) => total + cluster.lostAttempts, 0);
  check(
    'clusters account for every lost attempt',
    lost === report.regressedAttempts,
    `${lost} of ${report.regressedAttempts}`,
  );

  const clustered = new Set(once.flatMap((cluster) => cluster.caseIds));
  const regressed = new Set(report.cases.map((entry) => entry.caseId));
  check(
    'every regressed case lands in exactly one cluster',
    clustered.size === regressed.size &&
      once.reduce((total, cluster) => total + cluster.cases, 0) === regressed.size &&
      [...regressed].every((caseId) => clustered.has(caseId)),
    `${clustered.size} cases`,
  );

  const flagship = once[0];
  check(
    'clusters are ranked by how much they cost',
    once.every((cluster, index) => index === 0 || cluster.lostAttempts <= once[index - 1].lostAttempts) &&
      flagship.lostAttempts > 0,
    `largest: ${flagship.category}, ${flagship.lostAttempts} lost attempts`,
  );

  console.log('\n\x1b[1msignatures\x1b[0m');
  check(
    'timeouts of different lengths are one failure mode',
    normalizeReason('Tool execution timed out after 30000 ms.') ===
      normalizeReason('Tool execution timed out after 45000 ms.'),
  );
  check(
    'category and divergence separate otherwise identical reasons',
    clusterSignature('tool-selection', { baselineTool: 'a', candidateTool: 'b' }, 'x') !==
      clusterSignature('sequencing', { baselineTool: 'a', candidateTool: 'b' }, 'x'),
  );

  // --- an analysis registered at runtime --------------------------------
  console.log('\n\x1b[1ma registered analysis reaches the agent\x1b[0m');
  const clusters = applyProse(once, new Map());
  check('every cluster has prose', clusters.every((cluster) => cluster.label && cluster.summary && cluster.rootCause));
  setAnalysis({
    version: 1,
    provenance: {
      model: 'offline',
      promptVersion: PROMPT_VERSION,
      generatedAt: '2026-01-01T00:00:00.000Z',
      source: 'script',
    },
    entries: [{ baselineRunId: BASELINE, candidateRunId: CANDIDATE, clusters }],
  });

  // --- the loaded artefact reaches the agent ----------------------------
  const loaded = (await clusterTool().execute({
    baselineRunId: BASELINE,
    candidateRunId: CANDIDATE,
  })) as { clusters: { items: unknown[]; total: number } | null; provenance: { promptVersion: string } };
  check(
    'the tool serves the loaded analysis',
    loaded.clusters !== null && loaded.clusters.total === once.length,
    `${loaded.clusters?.total ?? 0} clusters`,
  );
  check('provenance travels with it', loaded.provenance?.promptVersion.length > 0, loaded.provenance?.promptVersion);

  await spendGuards();
  finish();
}

/**
 * The analysis endpoint is the only code in Catchfly that can spend money, so
 * its refusals are worth testing: every path here must reject *before* a model
 * is ever contacted. Run with no credentials, which is also the state a deploy
 * without the AI Gateway is in.
 */
async function spendGuards(): Promise<void> {
  console.log('\n\x1b[1manalysis endpoint refuses before it spends\x1b[0m');

  const key = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;

  const post = (body: unknown, init: RequestInit = {}) =>
    analyze(
      new Request('https://catchfly.dev/api/analyze', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
        ...init,
      }),
    );

  const valid = {
    op: 'cluster_failures',
    clusters: [{ signature: 'tool-selection | a→b | x', category: 'tool-selection' }],
  };

  const wrongMethod = await analyze(new Request('https://catchfly.dev/api/analyze'));
  check('GET is refused', wrongMethod.status === 405);

  process.env.CATCHFLY_AI = 'off';
  const killed = await post(valid);
  check('the kill switch closes the endpoint', killed.status === 503);
  delete process.env.CATCHFLY_AI;

  check('a body that is not JSON is refused', (await post('not json')).status === 400);

  const badOp = await post({ ...valid, op: 'summarize_everything' });
  check(
    'an unknown op is refused and names the valid ones',
    badOp.status === 400 && ((await badOp.json()) as { error: string }).error.includes('cluster_failures'),
  );

  check('an empty cluster list is refused', (await post({ ...valid, clusters: [] })).status === 400);
  check(
    'too many clusters are refused, not truncated',
    (await post({ ...valid, clusters: Array.from({ length: 201 }, () => valid.clusters[0]) })).status === 400,
  );
  check('an oversized body is refused', (await post('x'.repeat(33 * 1024))).status === 413);

  // The whole point: a well-formed request with no credentials must still not
  // reach a model. 503 here means "nothing was called", not "the call failed".
  const unconfigured = await post(valid);
  check('a valid request without credentials never reaches a model', unconfigured.status === 503);

  if (key !== undefined) process.env.OPENAI_API_KEY = key;
}

function finish(): void {
  console.log();
  if (failures.length > 0) {
    console.error(`\x1b[31m${failures.length} check(s) failed:\x1b[0m`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log('\x1b[32mAll analysis checks passed.\x1b[0m\n');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
