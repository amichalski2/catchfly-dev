/**
 * Checks the failure-clustering layer: that clustering is deterministic, that it
 * accounts for exactly the regressions the query layer reports, and that a
 * registered deterministic analysis reaches the agent with its provenance intact.
 *
 * Nothing here calls a model or an analysis endpoint. The suite registers
 * deterministic clusters with fallback prose and asserts the serving path.
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
} from '@catchfly/core/analysis.ts';
import { setAnalysis, setAnalysisUnavailable } from '@catchfly/core/analysis-db.ts';
import { findRegressions } from '@catchfly/core/queries.ts';
import { buildGlobalTools } from '../apps/web/src/webmcp/tools.ts';
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
      model: 'none',
      promptVersion: 'deterministic-v1',
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

  finish();
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
