import { signed } from './labels.ts';
import { diffToolSchema, schemaUnchanged } from './schema-diff.ts';
import type { DeploymentComparison, ToolSchemaDiff } from './session-types.ts';
import type { ToolSchema } from './types.ts';

export type ReleaseTone = 'regressed' | 'fixed' | 'neutral';

export type ReleaseToolChange = {
  tool: DeploymentComparison['tools'][number];
  callDelta: number;
  undeclared: boolean;
  diff: ToolSchemaDiff;
  schemaChangeCount: number;
};

export type ReleaseFinding = {
  id: string;
  eyebrow: string;
  title: string;
  summary: string;
  tone: ReleaseTone;
  metrics: Array<{ label: string; value: string }>;
  action:
    | { kind: 'category'; category: DeploymentComparison['categories'][number]['category'] }
    | { kind: 'tool'; toolName: string };
};

const changeCount = (diff: ToolSchemaDiff): number =>
  Number(diff.descriptionChanged) +
  diff.addedProps.length +
  diff.removedProps.length +
  diff.changedProps.length;

export const deploymentFailureRate = (deployment: DeploymentComparison['baseline']): number =>
  deployment.sessionCount === 0 ? 0 : deployment.failedCount / deployment.sessionCount;

export const releaseRateDelta = (comparison: DeploymentComparison): number =>
  deploymentFailureRate(comparison.candidate) - deploymentFailureRate(comparison.baseline);

export const releaseTone = (rateDelta: number): ReleaseTone =>
  rateDelta > 0.005 ? 'regressed' : rateDelta < -0.005 ? 'fixed' : 'neutral';

export function releaseToolChanges(
  comparison: DeploymentComparison,
  baselineManifest: ToolSchema[],
  candidateManifest: ToolSchema[],
): ReleaseToolChange[] {
  return comparison.tools
    .map((tool) => {
      const declaredBefore = baselineManifest.find((entry) => entry.name === tool.toolName) ?? null;
      const declaredAfter = candidateManifest.find((entry) => entry.name === tool.toolName) ?? null;
      const diff = diffToolSchema(declaredBefore, declaredAfter);
      return {
        tool,
        callDelta: tool.candidateCalls - tool.baselineCalls,
        undeclared: declaredBefore === null && declaredAfter === null,
        diff,
        schemaChangeCount: changeCount(diff),
      };
    })
    .filter((entry) => entry.callDelta !== 0 || !schemaUnchanged(entry.diff))
    .sort(
      (a, b) =>
        b.schemaChangeCount - a.schemaChangeCount ||
        Math.abs(b.callDelta) - Math.abs(a.callDelta) ||
        a.tool.toolName.localeCompare(b.tool.toolName),
    );
}

export function releaseFindings(
  comparison: DeploymentComparison,
  toolChanges: ReleaseToolChange[],
  categoryName: (category: DeploymentComparison['categories'][number]['category']) => string,
): ReleaseFinding[] {
  const findings: ReleaseFinding[] = [];
  const category = [...comparison.categories]
    .filter((entry) => entry.delta !== 0)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))[0];

  if (category) {
    const label = categoryName(category.category);
    const increased = category.delta > 0;
    findings.push({
      id: `category-${category.category}`,
      eyebrow: increased ? 'Failure shift' : 'Recovery signal',
      title: `${label} ${increased ? 'increased' : 'declined'}`,
      summary: increased
        ? `The candidate produced more ${label.toLowerCase()} failures than the baseline.`
        : `The candidate produced fewer ${label.toLowerCase()} failures than the baseline.`,
      tone: increased ? 'regressed' : 'fixed',
      metrics: [
        { label: 'Baseline', value: String(category.baseline) },
        { label: 'Candidate', value: String(category.candidate) },
        { label: 'Change', value: signed(category.delta) },
      ],
      action: { kind: 'category', category: category.category },
    });
  }

  const traffic = [...toolChanges]
    .filter((entry) => entry.callDelta !== 0)
    .sort(
      (a, b) =>
        Math.abs(b.callDelta) - Math.abs(a.callDelta) ||
        a.tool.toolName.localeCompare(b.tool.toolName),
    )[0];

  if (traffic) {
    const abandoned = traffic.callDelta < 0;
    findings.push({
      id: `traffic-${traffic.tool.toolName}`,
      eyebrow: 'Traffic movement',
      title: abandoned
        ? `${traffic.tool.toolName} was used less`
        : `Traffic moved to ${traffic.tool.toolName}`,
      summary: abandoned
        ? 'Agents stopped making calls that were present on the baseline release.'
        : 'The candidate started routing more production calls through this tool.',
      tone: abandoned ? 'regressed' : 'neutral',
      metrics: [
        { label: 'Baseline', value: String(traffic.tool.baselineCalls) },
        { label: 'Candidate', value: String(traffic.tool.candidateCalls) },
        { label: 'Change', value: signed(traffic.callDelta) },
      ],
      action: { kind: 'tool', toolName: traffic.tool.toolName },
    });
  }

  const manifest = toolChanges.find((entry) => entry.schemaChangeCount > 0);
  if (manifest) {
    findings.push({
      id: `manifest-${manifest.tool.toolName}`,
      eyebrow: 'Manifest change',
      title: `${manifest.tool.toolName} changed shape`,
      summary: manifest.diff.descriptionChanged
        ? 'The candidate describes this tool differently, changing the instructions agents receive.'
        : 'Arguments were added, removed or redefined between these releases.',
      tone: 'neutral',
      metrics: [
        { label: 'Changes', value: String(manifest.schemaChangeCount) },
        { label: 'Call shift', value: signed(manifest.callDelta) },
        { label: 'Success', value: `${(manifest.tool.candidateSuccessRate * 100).toFixed(1)}%` },
      ],
      action: { kind: 'tool', toolName: manifest.tool.toolName },
    });
  }

  return findings.slice(0, 3);
}

export function releaseEvidence(
  comparison: DeploymentComparison,
  manifestOf: (appVersionId: string) => ToolSchema[],
  categoryName: (category: DeploymentComparison['categories'][number]['category']) => string,
): { rateDelta: number; toolChanges: ReleaseToolChange[]; findings: ReleaseFinding[] } {
  const toolChanges = releaseToolChanges(
    comparison,
    manifestOf(comparison.baseline.appVersionId),
    manifestOf(comparison.candidate.appVersionId),
  );
  return {
    rateDelta: releaseRateDelta(comparison),
    toolChanges,
    findings: releaseFindings(comparison, toolChanges, categoryName),
  };
}
