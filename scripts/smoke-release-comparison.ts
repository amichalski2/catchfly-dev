import type { DeploymentComparison } from '@catchfly/core/session-types.ts';
import type { ToolSchema } from '@catchfly/core/types.ts';

import {
  releaseFindings,
  releaseTone,
  releaseToolChanges,
} from '../apps/web/src/views/release-comparison-model.ts';

function check(label: string, condition: boolean): void {
  if (!condition) throw new Error(`Release comparison check failed: ${label}`);
  console.log(`  ok   ${label}`);
}

const comparison: DeploymentComparison = {
  baseline: {
    id: 'deploy-1',
    appVersionId: 'app-v1',
    environment: 'production',
    deployedAt: '2026-08-01T00:00:00.000Z',
    sessionCount: 100,
    failedCount: 10,
    toolCallCount: 200,
    errorCallCount: 4,
  },
  candidate: {
    id: 'deploy-2',
    appVersionId: 'app-v2',
    environment: 'production',
    deployedAt: '2026-08-02T00:00:00.000Z',
    sessionCount: 100,
    failedCount: 18,
    toolCallCount: 210,
    errorCallCount: 7,
  },
  tools: [
    {
      toolName: 'search',
      baselineCalls: 80,
      candidateCalls: 40,
      baselineSuccessRate: 0.98,
      candidateSuccessRate: 0.9,
      successRateDelta: -0.08,
    },
    {
      toolName: 'verify',
      baselineCalls: 30,
      candidateCalls: 35,
      baselineSuccessRate: 0.95,
      candidateSuccessRate: 0.94,
      successRateDelta: -0.01,
    },
  ],
  categories: [
    { category: 'tool-selection', baseline: 2, candidate: 9, delta: 7 },
    { category: 'sequencing', baseline: 4, candidate: 2, delta: -2 },
  ],
};

const baselineManifest: ToolSchema[] = [
  { name: 'search', description: 'Search records by exact term.', inputSchema: null },
  { name: 'verify', description: 'Verify one record.', inputSchema: null },
];
const candidateManifest: ToolSchema[] = [
  { name: 'search', description: 'Find things.', inputSchema: null },
  { name: 'verify', description: 'Verify one record.', inputSchema: null },
];

console.log('\nrelease comparison presentation');
check('material regression receives the regressed tone', releaseTone(0.08) === 'regressed');
check('material recovery receives the fixed tone', releaseTone(-0.08) === 'fixed');
check('small movement stays neutral', releaseTone(0.004) === 'neutral');

const toolChanges = releaseToolChanges(comparison, baselineManifest, candidateManifest);
check('every traffic or manifest change is retained', toolChanges.length === 2);
check('the schema-changing tool ranks first', toolChanges[0]?.tool.toolName === 'search');
check('description changes contribute to the change count', toolChanges[0]?.schemaChangeCount === 1);

const findings = releaseFindings(comparison, toolChanges, (category) => category);
check('the overview produces three distinct findings', findings.length === 3);
check('the largest category shift leads', findings[0]?.action.kind === 'category');
check('traffic and manifest findings link to tool evidence', findings.slice(1).every((entry) => entry.action.kind === 'tool'));

console.log('Release comparison presentation checks passed.');
