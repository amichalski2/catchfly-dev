/**
 * Shapes the tool results the agent receives.
 *
 * Tool output is agent context: it has to be complete enough to reason over
 * and small enough not to drown the conversation. Long lists are truncated
 * with an explicit marker, and trajectories are reduced to the call sequence
 * plus the failure story — never the raw step dump.
 */

import type { FailureCluster } from '@catchfly/core/analysis.ts';
import { headlineIncidents, incidentCorroboration, incidentDeploymentPair, incidentKindCounts } from '@catchfly/core/incidents.ts';
import type { CaseRow, RegressionReport, TrajectoryComparison } from '@catchfly/core/queries.ts';
import type {
  DeploymentRollup,
  Session,
  SessionSummary,
  SessionToolCall,
  ToolEvalProfile,
  ToolProduction,
} from '@catchfly/core/session-types.ts';
import type {
  CaseResult,
  IncidentOverview,
  IncidentSummary,
  IncidentTimelinePoint,
} from '@catchfly/core/types.ts';

export const LIST_LIMIT = 40;

export function truncated<T>(items: T[], limit = LIST_LIMIT): { items: T[]; total: number; truncated: boolean } {
  return { items: items.slice(0, limit), total: items.length, truncated: items.length > limit };
}

export function caseRowPayload(row: CaseRow) {
  return {
    caseId: row.caseId,
    name: row.name,
    runId: row.runId,
    appVersionId: row.appVersionId,
    appVersionLabel: row.appVersionLabel,
    model: row.model,
    passes: row.passes,
    repeats: row.repeats,
    passRate: Number(row.passRate.toFixed(2)),
    category: row.category ?? null,
    avgLatencyMs: row.avgLatencyMs,
  };
}

export function regressionPayload(report: RegressionReport) {
  return {
    baselineRunId: report.baselineRunId,
    candidateRunId: report.candidateRunId,
    regressedAttempts: report.regressedAttempts,
    fixedAttempts: report.fixedAttempts,
    netAttemptDelta: report.netAttemptDelta,
    affectedCases: report.affectedCases,
    byCategory: report.byCategory,
    cases: truncated(
      report.cases.map((entry) => ({
        caseId: entry.caseId,
        name: entry.name,
        category: entry.category,
        baselinePasses: entry.baselinePasses,
        candidatePasses: entry.candidatePasses,
        lostAttempts: entry.lostAttempts,
        repeats: entry.repeats,
        failureReason: entry.failureReason ?? null,
      })),
    ),
    fixedCases: truncated(report.fixedCases, 10),
  };
}

export function attemptPayload(attempt: CaseResult) {
  return {
    runIndex: attempt.runIndex,
    outcome: attempt.outcome,
    category: attempt.category ?? null,
    calls: attempt.actualCalls.map((call) => ({ functionName: call.functionName, args: call.args })),
    failureReason: attempt.failureReason ?? null,
    latencyMs: attempt.latencyMs ?? null,
  };
}

export function trajectoryPayload(comparison: TrajectoryComparison) {
  const side = (entry: TrajectoryComparison['baseline']) => ({
    runId: entry.runId,
    appVersion: entry.appVersionLabel,
    outcome: entry.outcome,
    calls: entry.calls.map((call) => ({
      functionName: call.functionName,
      args: call.args,
      result: call.result ?? null,
    })),
    failureReason: entry.failureReason ?? null,
  });
  return {
    caseId: comparison.caseId,
    name: comparison.name,
    prompt: comparison.prompt,
    expectedTools: comparison.expectedTools,
    baseline: side(comparison.baseline),
    candidate: side(comparison.candidate),
    firstDivergenceIndex: comparison.firstDivergenceIndex,
    divergence: comparison.divergence ?? null,
    toolManifestDelta: comparison.toolManifestDelta,
  };
}

/**
 * One failure cluster. `caseIds` is the useful end of it: the agent hands the
 * list straight to set_dashboard_filters to put that cluster in front of the
 * user. The prose fields are model-written, which is why the tool carrying this
 * payload declares `untrustedContentHint`.
 */
export function clusterPayload(cluster: FailureCluster) {
  return {
    signature: cluster.signature,
    label: cluster.label,
    summary: cluster.summary,
    rootCause: cluster.rootCause,
    category: cluster.category,
    divergence: cluster.divergence,
    failureReason: cluster.failureReason,
    cases: cluster.cases,
    attempts: cluster.attempts,
    passes: cluster.passes,
    passRate: Number(cluster.passRate.toFixed(2)),
    lostAttempts: cluster.lostAttempts,
    caseIds: truncated(cluster.caseIds),
  };
}

// --- production sessions -----------------------------------------------

export function deploymentPayload(deployment: DeploymentRollup) {
  return {
    deploymentId: deployment.id,
    appVersionId: deployment.appVersionId,
    environment: deployment.environment,
    deployedAt: deployment.deployedAt,
    commitSha: deployment.commitSha ?? null,
    note: deployment.note ?? null,
    sessions: deployment.sessionCount,
    failedSessions: deployment.failedCount,
    failureRate:
      deployment.sessionCount === 0
        ? 0
        : Number((deployment.failedCount / deployment.sessionCount).toFixed(3)),
    toolCalls: deployment.toolCallCount,
    erroredToolCalls: deployment.errorCallCount,
  };
}

export function sessionSummaryPayload(session: SessionSummary) {
  return {
    sessionId: session.id,
    deploymentId: session.deploymentId,
    appVersionId: session.appVersionId,
    startedAt: session.startedAt,
    // Null rather than omitted: an agent reading this needs to see that the
    // field exists and was not captured, which an absent key does not say.
    intent: session.intent ?? null,
    model: session.model ?? null,
    outcome: session.outcome,
    failureCategory: session.failureCategory ?? null,
    failureTool: session.failureTool ?? null,
    toolCalls: session.toolCallCount,
    erroredToolCalls: session.errorCallCount,
    durationMs: session.totalDurationMs,
  };
}

/**
 * Tool results are caller-controlled and can be arbitrarily large, so a trace
 * carries them only up to a point. The marker matters more than the bytes: an
 * agent must be able to tell "this is the whole result" from "this is the start
 * of one".
 */
const RESULT_BUDGET_BYTES = 2048;

function clipped(value: unknown): unknown {
  if (value === undefined) return null;
  const text = JSON.stringify(value) ?? 'null';
  if (text.length <= RESULT_BUDGET_BYTES) return value;
  return { truncated: true, bytes: text.length, preview: text.slice(0, RESULT_BUDGET_BYTES) };
}

export function sessionCallPayload(call: SessionToolCall) {
  return {
    timestamp: call.timestamp,
    toolName: call.toolName,
    toolSchemaVersion: call.toolSchemaVersion ?? null,
    arguments: clipped(call.arguments),
    result: clipped(call.result),
    status: call.status,
    durationMs: call.durationMs,
    errorType: call.errorType ?? null,
    errorMessage: call.errorMessage ?? null,
  };
}

export function sessionPayload(session: Session) {
  return {
    sessionId: session.id,
    deploymentId: session.deploymentId,
    environment: session.environment,
    startedAt: session.startedAt,
    endedAt: session.endedAt ?? null,
    intent: session.intent ?? null,
    agent: session.agent ?? null,
    model: session.model ?? null,
    outcome: session.outcome,
    failureCategory: session.failureCategory ?? null,
    failureTool: session.failureTool ?? null,
    toolCalls: session.toolCalls.map(sessionCallPayload),
    // The narration, when the client sent any. Text an agent wrote about its own
    // work is not evidence of what happened — the calls are.
    transcript: session.transcript ?? null,
  };
}

export function toolProfilePayload(production: ToolProduction, evalSide: ToolEvalProfile) {
  return {
    toolName: production.toolName,
    production: {
      calls: production.calls,
      erroredCalls: production.errorCalls,
      executionSuccessRate: production.successRate,
      p50DurationMs: production.p50DurationMs,
      p95DurationMs: production.p95DurationMs,
      errorTypes: production.errorTypes,
      byDeployment: production.byDeployment,
    },
    schemaHistory: evalSide.schemaByVersion.map((entry) => ({
      appVersionId: entry.appVersionId,
      label: entry.label,
      declared: entry.schema !== null,
      description: entry.schema?.description ?? null,
      inputSchema: entry.schema?.inputSchema ?? null,
    })),
    schemaChanges: evalSide.schemaDiffs.map((entry) => ({
      from: entry.fromVersionId,
      to: entry.toVersionId,
      ...entry.diff,
    })),
    evalCases: evalSide.caseIds,
    evalPassRateByVersion: evalSide.passRateByVersion,
  };
}

export function incidentPayload(incident: IncidentSummary, timeline: IncidentTimelinePoint[] = []) {
  const deployments = incidentDeploymentPair(incident, timeline);
  return {
    incidentId: incident.id,
    title: incident.title,
    kind: incident.kind,
    summary: incident.summary,
    tools: incident.tools,
    failureCategory: incident.failureCategory,
    occurrences: incident.occurrences,
    evalSuccessRateDelta: incident.evalSuccessRateDelta,
    productionFailureRateDelta: incident.productionFailureRateDelta,
    latencyMultiplier: incident.latencyMultiplier,
    modelAgreement: incident.modelAgreement,
    modelCount: incident.modelCount,
    baselineRunId: incident.baselineRunId,
    candidateRunId: incident.candidateRunId,
    baselineVersionId: incident.baselineVersionId,
    candidateVersionId: incident.candidateVersionId,
    baselineDeploymentId: deployments?.baselineDeploymentId ?? null,
    candidateDeploymentId: deployments?.candidateDeploymentId ?? null,
    corroboration: incidentCorroboration(incident),
    representativeModel: incident.model,
  };
}

export function releasePayload(point: IncidentTimelinePoint) {
  return {
    appVersionId: point.appVersionId,
    appVersionLabel: point.appVersionLabel,
    deploymentId: point.deploymentId,
    releasedAt: point.releasedAt,
    scenarioId: point.scenarioId,
    kind: point.kind,
    evalSuccessRate: point.evalSuccessRate,
    evalAttempts: point.evalAttempts,
    productionFailureRate: point.productionFailureRate,
    productionSessions: point.productionSessions,
    avgToolLatencyMs: Math.round(point.avgToolLatencyMs),
  };
}

export function incidentOverviewPayload(overview: IncidentOverview) {
  return {
    projectId: overview.projectId,
    incidentPatterns: overview.incidentPatterns,
    regressionCount: overview.incidentPatterns,
    total: overview.incidents.length,
    kindCounts: incidentKindCounts(overview.incidents),
    visibleOnScreen: headlineIncidents(overview).map((incident) => incident.id),
    affectedTools: overview.affectedTools,
    evalAttempts: overview.evalAttempts,
    productionSessions: overview.productionSessions,
    incidents: truncated(overview.incidents.map((incident) => incidentPayload(incident, overview.timeline))),
    releases: truncated(overview.timeline.map(releasePayload)),
  };
}
