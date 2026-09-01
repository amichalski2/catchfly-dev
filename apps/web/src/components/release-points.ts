import type { DeploymentRollup } from '@catchfly/core/session-types.ts';

import type { StatusKind } from './StatusMark.tsx';

const MATERIAL_CHANGE = 0.005;

export type ReleasePoint = {
  deployment: DeploymentRollup;
  release: number;
  failureRate: number;
  rejectRate: number;
  failureRateDelta: number | null;
  previousVersionId: string | null;
  status: StatusKind;
};

export const failureRateOf = (deployment: DeploymentRollup): number =>
  deployment.sessionCount === 0 ? 0 : deployment.failedCount / deployment.sessionCount;

export const rejectRateOf = (deployment: DeploymentRollup): number =>
  deployment.toolCallCount === 0 ? 0 : deployment.errorCallCount / deployment.toolCallCount;

export function toReleasePoints(deployments: DeploymentRollup[]): ReleasePoint[] {
  const ordered = [...deployments].sort(
    (a, b) => a.deployedAt.localeCompare(b.deployedAt) || a.id.localeCompare(b.id),
  );

  return ordered.map((deployment, index) => {
    const previous = index > 0 ? ordered[index - 1] : null;
    const failureRate = failureRateOf(deployment);
    const failureRateDelta = previous === null ? null : failureRate - failureRateOf(previous);
    const status: StatusKind =
      failureRateDelta === null || Math.abs(failureRateDelta) <= MATERIAL_CHANGE
        ? 'control'
        : failureRateDelta > 0
          ? 'regression'
          : 'recovery';

    return {
      deployment,
      release: index + 1,
      failureRate,
      rejectRate: rejectRateOf(deployment),
      failureRateDelta,
      previousVersionId: previous?.appVersionId ?? null,
      status,
    };
  });
}
