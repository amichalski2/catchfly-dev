import type { OperationalFinding, ProjectOperationalOverview } from '@catchfly/core/product-types.ts';

import { sql } from './db.ts';

const round = (value: number): number => Math.round(value * 1e6) / 1e6;

export async function loadProjectOverview(projectId: string): Promise<ProjectOperationalOverview> {
    const [sessionRows, callRows, telemetryRows, evalRows] = await Promise.all([
      sql().query<{
        total: string; completed: string; failed: string; abandoned: string; unknown: string;
      }>(
        `select count(*) as total,
                count(*) filter (where outcome = 'completed') as completed,
                count(*) filter (where outcome = 'failed') as failed,
                count(*) filter (where outcome = 'abandoned') as abandoned,
                count(*) filter (where outcome = 'unknown') as unknown
           from sessions where project_id = $1`, [projectId],
      ),
      sql().query<{ total: string; errors: string }>(
        `select count(*) as total, count(*) filter (where status = 'error') as errors
           from session_tool_calls where project_id = $1`, [projectId],
      ),
      sql().query<{ last_event_at: Date | null; accepted: string; rejected: string }>(
        `select (select max(received_at) from telemetry_events where project_id = $1) as last_event_at,
                coalesce(sum(accepted_count), 0) as accepted,
                coalesce(sum(rejected_count), 0) as rejected
           from ingest_batches where project_id = $1`, [projectId],
      ),
      sql().query<{ id: string; success_rate: number; run_count: string }>(
        `select id, coalesce((metrics->>'successRate')::double precision, 0) as success_rate,
                count(*) over() as run_count
           from eval_runs where project_id = $1 order by ts desc, id desc limit 2`, [projectId],
      ),
    ]);
    const sessions = sessionRows.rows[0];
    const total = Number(sessions?.total ?? 0);
    const completed = Number(sessions?.completed ?? 0);
    const failed = Number(sessions?.failed ?? 0);
    const abandoned = Number(sessions?.abandoned ?? 0);
    const unknown = Number(sessions?.unknown ?? 0);
    const measured = completed + failed + abandoned;
    const calls = Number(callRows.rows[0]?.total ?? 0);
    const callErrors = Number(callRows.rows[0]?.errors ?? 0);
    const latest = evalRows.rows[0];
    const previous = evalRows.rows[1];
    const evalDelta = latest && previous ? round(latest.success_rate - previous.success_rate) : null;
    const lastEventAt = telemetryRows.rows[0]?.last_event_at?.toISOString() ?? null;
    const rejected = Number(telemetryRows.rows[0]?.rejected ?? 0);
    const findings: OperationalFinding[] = [];

    if (!lastEventAt) findings.push({
      id: 'telemetry-never-seen', kind: 'telemetry', severity: 'warning',
      title: 'No production telemetry received',
      summary: 'Connect the SDK and send a test trace from Sources.', value: 0, sampleSize: 0,
    });
    else if (Date.now() - Date.parse(lastEventAt) > 60 * 60 * 1000) findings.push({
      id: 'telemetry-stale', kind: 'telemetry', severity: 'warning',
      title: 'Production telemetry is stale',
      summary: `The last event arrived at ${lastEventAt}.`, value: Date.now() - Date.parse(lastEventAt), sampleSize: total,
    });
    if (rejected > 0) findings.push({
      id: 'ingest-rejections', kind: 'telemetry', severity: 'warning',
      title: 'Some telemetry events were rejected',
      summary: `${rejected} events did not satisfy the ingest contract.`, value: rejected, sampleSize: Number(telemetryRows.rows[0]?.accepted ?? 0) + rejected,
    });
    const failureRate = measured === 0 ? 0 : (failed + abandoned) / measured;
    if (measured >= 20 && failureRate >= 0.05) findings.push({
      id: 'production-failure-rate', kind: 'production', severity: failureRate >= 0.15 ? 'critical' : 'warning',
      title: 'Production task failures deserve attention',
      summary: `${failed + abandoned} of ${measured} measured sessions failed or were abandoned.`, value: round(failureRate), sampleSize: measured,
    });
    if (evalDelta !== null && evalDelta <= -0.02) findings.push({
      id: 'eval-regression', kind: 'eval', severity: evalDelta <= -0.1 ? 'critical' : 'warning',
      title: 'Latest eval run regressed',
      summary: `Success rate moved ${(evalDelta * 100).toFixed(1)} percentage points.`, value: evalDelta, sampleSize: 2,
    });

    return {
      projectId,
      telemetry: {
        lastEventAt,
        acceptedEvents: Number(telemetryRows.rows[0]?.accepted ?? 0),
        rejectedEvents: rejected,
      },
      sessions: {
        total, completed, failed, abandoned, unknown,
        outcomeCoverage: total === 0 ? 0 : round(measured / total),
        measuredTaskSuccessRate: measured === 0 ? null : round(completed / measured),
      },
      calls: {
        total: calls,
        errors: callErrors,
        executionSuccessRate: calls === 0 ? null : round((calls - callErrors) / calls),
      },
      evals: {
        runs: Number(latest?.run_count ?? 0),
        latestRunId: latest?.id ?? null,
        latestSuccessRate: latest?.success_rate ?? null,
        previousRunId: previous?.id ?? null,
        successRateDelta: evalDelta,
      },
      findings,
    };
}
