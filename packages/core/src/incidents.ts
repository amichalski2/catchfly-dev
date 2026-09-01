import type { IncidentOverview, IncidentSummary, IncidentTimelinePoint } from './types.ts';

export const EVAL_CORROBORATION_THRESHOLD = -0.01;
export const PRODUCTION_CORROBORATION_THRESHOLD = 0.005;
export const HEADLINE_INCIDENT_COUNT = 3;

export type IncidentKind = IncidentSummary['kind'];

export type IncidentCorroboration = {
  evals: boolean;
  production: boolean;
  models: number;
  modelCount: number;
  allModels: boolean;
};

export function evalsCorroborate(incident: IncidentSummary): boolean {
  return incident.kind === 'recovery'
    ? incident.evalSuccessRateDelta > -EVAL_CORROBORATION_THRESHOLD
    : incident.evalSuccessRateDelta < EVAL_CORROBORATION_THRESHOLD;
}

export function productionCorroborates(incident: IncidentSummary): boolean {
  return incident.kind === 'recovery'
    ? incident.productionFailureRateDelta < -PRODUCTION_CORROBORATION_THRESHOLD
    : incident.productionFailureRateDelta > PRODUCTION_CORROBORATION_THRESHOLD;
}

export function incidentCorroboration(incident: IncidentSummary): IncidentCorroboration {
  return {
    evals: evalsCorroborate(incident),
    production: productionCorroborates(incident),
    models: incident.modelAgreement,
    modelCount: incident.modelCount,
    allModels: incident.modelCount > 0 && incident.modelAgreement === incident.modelCount,
  };
}

export function incidentKindCounts(incidents: IncidentSummary[]): Record<IncidentKind, number> {
  const counts: Record<IncidentKind, number> = { regression: 0, decoy: 0, recovery: 0 };
  for (const incident of incidents) counts[incident.kind] += 1;
  return counts;
}

export function deploymentForVersion(
  timeline: IncidentTimelinePoint[],
  appVersionId: string,
): string | null {
  return timeline.find((point) => point.appVersionId === appVersionId && point.deploymentId)?.deploymentId ?? null;
}

export function incidentDeploymentPair(
  incident: IncidentSummary,
  timeline: IncidentTimelinePoint[],
): { baselineDeploymentId: string; candidateDeploymentId: string } | null {
  const baselineDeploymentId = incident.baselineDeploymentId ?? deploymentForVersion(timeline, incident.baselineVersionId);
  const candidateDeploymentId =
    incident.candidateDeploymentId ?? deploymentForVersion(timeline, incident.candidateVersionId);
  return baselineDeploymentId && candidateDeploymentId ? { baselineDeploymentId, candidateDeploymentId } : null;
}

export function headlineIncidents(overview: IncidentOverview): IncidentSummary[] {
  return overview.incidents.slice(0, HEADLINE_INCIDENT_COUNT);
}
