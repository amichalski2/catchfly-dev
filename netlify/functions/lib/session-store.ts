/**
 * Sessions <-> tables.
 *
 * Kept out of store.ts, which is the exact inverse of `CatchflyDataset` and
 * should stay that. Sessions are not part of the dataset: they are read a page
 * at a time, and folding them in would put an unbounded table inside a response
 * that is already warned about at 4 MB.
 *
 * Everything here has a second implementation: the pure functions in
 * `@catchfly/core/session-queries.ts`, which the browser, the smoke suite and
 * the seed generator all run. Those are the specification — when a WHERE clause
 * here and a filter there disagree, this file is what is wrong.
 * The session smoke suite compares the two answer for answer.
 */

import type { PoolClient } from 'pg';

import {
  decodeCursor,
  encodeCursor,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from '../../../packages/core/src/session-queries.ts';
import type {
  Deployment,
  DeploymentComparison,
  DeploymentRollup,
  Session,
  SessionFilters,
  SessionPage,
  SessionSummary,
  SessionToolCall,
  ToolProduction,
} from '@catchfly/core/session-types.ts';
import type { DataOrigin, EvalCase, TrajectoryStep } from '@catchfly/core/types.ts';

import { sql, transaction, withClient } from './db.ts';
import { nextOrdinal, upsertCases } from './store.ts';

/** Thrown for a cursor the database cannot resume from; the endpoint answers 400. */
export class BadCursor extends Error {
  constructor() {
    super('cursor expired — restart from the first page');
    this.name = 'BadCursor';
  }
}

// --- deployments -------------------------------------------------------

export async function listDeploymentRollups(
  projectId: string,
  deploymentIds?: string[],
): Promise<DeploymentRollup[]> {
  const scoped = deploymentIds !== undefined && deploymentIds.length > 0;
  const params: unknown[] = scoped ? [projectId, deploymentIds] : [projectId];
  const only = scoped ? 'and deployment_id = any($2)' : '';
  const onlyJoined = scoped ? 'and s.deployment_id = any($2)' : '';
  const onlyOuter = scoped ? 'and d.id = any($2)' : '';

  const { rows } = await sql().query<{
    id: string;
    app_version_id: string;
    environment: string;
    deployed_at: Date;
    commit_sha: string | null;
    note: string | null;
    session_count: string;
    failed_count: string;
    tool_call_count: string;
    error_call_count: string;
  }>(
    `with per_session as (
       select deployment_id,
              count(*) as session_count,
              count(*) filter (where outcome in ('failed', 'abandoned')) as failed_count
         from sessions
        where project_id = $1 ${only}
        group by deployment_id
     ), per_call as (
       select s.deployment_id,
              count(*) as tool_call_count,
              count(*) filter (where c.status = 'error') as error_call_count
         from session_tool_calls c
         join sessions s on s.project_id = c.project_id and s.id = c.session_id
        where c.project_id = $1 ${onlyJoined}
        group by s.deployment_id
     )
     select d.id, d.app_version_id, d.environment, d.deployed_at, d.commit_sha, d.note,
            coalesce(ps.session_count, 0) as session_count,
            coalesce(ps.failed_count, 0) as failed_count,
            coalesce(pc.tool_call_count, 0) as tool_call_count,
            coalesce(pc.error_call_count, 0) as error_call_count
       from deployments d
       left join per_session ps on ps.deployment_id = d.id
       left join per_call pc on pc.deployment_id = d.id
      where d.project_id = $1 ${onlyOuter}
      order by d.deployed_at, d.id`,
    params,
  );

  return rows.map((row) => {
    const deployment: DeploymentRollup = {
      id: row.id,
      appVersionId: row.app_version_id,
      environment: row.environment,
      deployedAt: row.deployed_at.toISOString(),
      sessionCount: Number(row.session_count),
      failedCount: Number(row.failed_count),
      toolCallCount: Number(row.tool_call_count),
      errorCallCount: Number(row.error_call_count),
    };
    if (row.commit_sha !== null) deployment.commitSha = row.commit_sha;
    if (row.note !== null) deployment.note = row.note;
    return deployment;
  });
}

/**
 * Complete deployment comparison in bounded SQL. Unlike the original browser
 * tool this never scans session pages and never issues one profile query per
 * tool, so a tool called only in session 10,001 is still part of the answer.
 */
export async function compareDeploymentRows(
  projectId: string,
  baselineDeploymentId: string,
  candidateDeploymentId: string,
): Promise<DeploymentComparison> {
  const rollups = await listDeploymentRollups(projectId, [baselineDeploymentId, candidateDeploymentId]);
  const baseline = rollups.find((entry) => entry.id === baselineDeploymentId);
  const candidate = rollups.find((entry) => entry.id === candidateDeploymentId);
  if (!baseline) throw new Error(`Unknown deployment: ${baselineDeploymentId}`);
  if (!candidate) throw new Error(`Unknown deployment: ${candidateDeploymentId}`);

  return withClient(async (client) => {
    const tools = await client.query<{
      tool_name: string;
      baseline_calls: string;
      candidate_calls: string;
      baseline_errors: string;
      candidate_errors: string;
    }>(
      `select tc.tool_name,
              count(*) filter (where s.deployment_id = $2) as baseline_calls,
              count(*) filter (where s.deployment_id = $3) as candidate_calls,
              count(*) filter (where s.deployment_id = $2 and tc.status = 'error') as baseline_errors,
              count(*) filter (where s.deployment_id = $3 and tc.status = 'error') as candidate_errors
         from session_tool_calls tc
         join sessions s on s.project_id = tc.project_id and s.id = tc.session_id
        where tc.project_id = $1 and s.deployment_id in ($2, $3)
        group by tc.tool_name
        order by tc.tool_name`,
      [projectId, baselineDeploymentId, candidateDeploymentId],
    );
    const categories = await client.query<{
      category: NonNullable<Session['failureCategory']>;
      baseline: string;
      candidate: string;
    }>(
      `select failure_category as category,
              count(*) filter (where deployment_id = $2) as baseline,
              count(*) filter (where deployment_id = $3) as candidate
         from sessions
        where project_id = $1 and deployment_id in ($2, $3) and failure_category is not null
        group by failure_category`,
      [projectId, baselineDeploymentId, candidateDeploymentId],
    );
    const rate = (calls: number, errors: number) => (calls === 0 ? 0 : (calls - errors) / calls);
    const round = (value: number) => Math.round(value * 1e6) / 1e6;
    return {
      baseline,
      candidate,
      tools: tools.rows
        .map((row) => {
          const baselineCalls = Number(row.baseline_calls);
          const candidateCalls = Number(row.candidate_calls);
          const baselineSuccessRate = rate(baselineCalls, Number(row.baseline_errors));
          const candidateSuccessRate = rate(candidateCalls, Number(row.candidate_errors));
          return {
            toolName: row.tool_name,
            baselineCalls,
            candidateCalls,
            baselineSuccessRate: round(baselineSuccessRate),
            candidateSuccessRate: round(candidateSuccessRate),
            successRateDelta: round(candidateSuccessRate - baselineSuccessRate),
          };
        })
        .sort((a, b) => a.successRateDelta - b.successRateDelta || a.toolName.localeCompare(b.toolName)),
      categories: categories.rows
        .map((row) => {
          const before = Number(row.baseline);
          const after = Number(row.candidate);
          return { category: row.category, baseline: before, candidate: after, delta: after - before };
        })
        .sort((a, b) => b.delta - a.delta || a.category.localeCompare(b.category)),
    };
  });
}

// --- searching ---------------------------------------------------------

/**
 * Builds the WHERE clause. Mirrors `filterSessions` clause for clause; the
 * ordering of the checks is the same so a reader can diff the two by eye.
 */
function whereFor(projectId: string, filters: SessionFilters): { clause: string; values: unknown[] } {
  const conditions = ['s.project_id = $1'];
  const values: unknown[] = [projectId];
  const put = (value: unknown) => `$${values.push(value)}`;

  if (filters.deploymentId) conditions.push(`s.deployment_id = ${put(filters.deploymentId)}`);
  if (filters.environment) conditions.push(`s.environment = ${put(filters.environment)}`);
  if (filters.outcome === 'any-failure') conditions.push(`s.outcome in ('failed', 'abandoned')`);
  else if (filters.outcome) conditions.push(`s.outcome = ${put(filters.outcome)}`);
  if (filters.category) conditions.push(`s.failure_category = ${put(filters.category)}`);
  if (filters.toolCalled) {
    conditions.push(
      `exists (select 1 from session_tool_calls tc
                where tc.project_id = s.project_id and tc.session_id = s.id
                  and tc.tool_name = ${put(filters.toolCalled)})`,
    );
  }
  if (filters.from) conditions.push(`s.started_at >= ${put(filters.from)}`);
  if (filters.to) conditions.push(`s.started_at <= ${put(filters.to)}`);
  if (filters.search?.trim()) {
    // Intent plus the tool names called, matching what the pure filter searches.
    // One placeholder, used twice.
    const needle = put(`%${filters.search.trim().toLowerCase()}%`);
    conditions.push(
      `(lower(coalesce(s.intent, '')) like ${needle}
        or exists (select 1 from session_tool_calls tc
                    where tc.project_id = s.project_id and tc.session_id = s.id
                      and lower(tc.tool_name) like ${needle}))`,
    );
  }

  return { clause: conditions.join(' and '), values };
}

export async function searchSessions(
  projectId: string,
  filters: SessionFilters,
  cursor?: string | null,
  limit?: number,
): Promise<SessionPage> {
  const size = Math.min(Math.max(Math.trunc(limit ?? DEFAULT_PAGE_SIZE) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const { clause, values } = whereFor(projectId, filters);

  const decoded = cursor ? decodeCursor(cursor) : null;
  if (cursor && !decoded) throw new BadCursor();

  // Counted before the cursor narrows anything, so `total` means the same thing
  // on page five as on page one — which is what the pure implementation returns
  // and therefore what the UI's "N of M" is entitled to assume. Later pages read
  // it back off the cursor rather than counting the whole set again.
  const total =
    decoded?.total ??
    Number(
      (
        await sql().query<{ total: string }>(
          `select count(*) as total
             from sessions s
             join deployments d on d.project_id = s.project_id and d.id = s.deployment_id
            where ${clause}`,
          [...values],
        )
      ).rows[0]?.total ?? 0,
    );

  let keyset = '';
  if (decoded) {
    // Strictly after the cursor row in (started_at desc, id desc) order.
    const at = values.push(decoded.startedAt);
    const id = values.push(decoded.id);
    keyset = ` and (s.started_at, s.id) < ($${at}::timestamptz, $${id})`;
  }

  // One row beyond the page, so "is there more?" is answered exactly rather
  // than inferred from a full page — which would hand out a cursor to an empty
  // page whenever the count divides evenly.
  const size$ = values.push(size + 1);
  const { rows } = await sql().query<{
    id: string;
    deployment_id: string;
    app_version_id: string;
    environment: string;
    started_at: Date;
    agent: string | null;
    model: string | null;
    intent: string | null;
    outcome: SessionSummary['outcome'];
    failure_category: SessionSummary['failureCategory'] | null;
    failure_tool: string | null;
    tool_call_count: string;
    error_call_count: string;
    total_duration_ms: string | null;
  }>(
    `select s.id, s.deployment_id, d.app_version_id, s.environment, s.started_at,
            s.agent, s.model, s.intent, s.outcome, s.failure_category, s.failure_tool,
            coalesce(calls.count, 0)     as tool_call_count,
            coalesce(calls.errors, 0)    as error_call_count,
            coalesce(calls.duration, 0)  as total_duration_ms
       from sessions s
       join deployments d on d.project_id = s.project_id and d.id = s.deployment_id
       left join lateral (
            select count(*) as count,
                   count(*) filter (where tc.status = 'error') as errors,
                   sum(tc.duration_ms) as duration
              from session_tool_calls tc
             where tc.project_id = s.project_id and tc.session_id = s.id
       ) calls on true
      where ${clause}${keyset}
      order by s.started_at desc, s.id desc
      limit $${size$}`,
    values,
  );

  const more = rows.length > size;
  const sessions = rows.slice(0, size).map((row) => {
    const summary: SessionSummary = {
      id: row.id,
      deploymentId: row.deployment_id,
      appVersionId: row.app_version_id,
      environment: row.environment,
      startedAt: row.started_at.toISOString(),
      outcome: row.outcome,
      toolCallCount: Number(row.tool_call_count),
      errorCallCount: Number(row.error_call_count),
      totalDurationMs: Math.round(Number(row.total_duration_ms ?? 0)),
    };
    if (row.agent !== null) summary.agent = row.agent;
    if (row.model !== null) summary.model = row.model;
    if (row.intent !== null) summary.intent = row.intent;
    if (row.failure_category !== null) summary.failureCategory = row.failure_category;
    if (row.failure_tool !== null) summary.failureTool = row.failure_tool;
    return summary;
  });

  const last = sessions[sessions.length - 1];
  return {
    sessions,
    total,
    nextCursor: more && last ? encodeCursor(last.startedAt, last.id, total) : null,
  };
}

// --- one session -------------------------------------------------------

export async function getSession(projectId: string, sessionId: string): Promise<Session | null> {
  return withClient(async (client) => {
    const { rows } = await client.query<{
      id: string;
      deployment_id: string;
      environment: string;
      started_at: Date;
      ended_at: Date | null;
      agent: string | null;
      model: string | null;
      intent: string | null;
      outcome: Session['outcome'];
      failure_category: Session['failureCategory'] | null;
      failure_tool: string | null;
      data_origin: DataOrigin;
      transcript: TrajectoryStep[] | null;
      metadata: Record<string, unknown> | null;
    }>(
      `select id, deployment_id, environment, started_at, ended_at, agent, model, intent,
              outcome, failure_category, failure_tool, data_origin, transcript, metadata
         from sessions where project_id = $1 and id = $2`,
      [projectId, sessionId],
    );
    if (rows.length === 0) return null;
    const row = rows[0];

    const calls = await client.query<{
      ts: Date;
      tool_name: string;
      tool_schema_version: string | null;
      arguments: Record<string, unknown> | null;
      result: unknown;
      status: SessionToolCall['status'];
      duration_ms: number;
      error_type: string | null;
      error_message: string | null;
    }>(
      `select ts, tool_name, tool_schema_version, arguments, result, status,
              duration_ms, error_type, error_message
         from session_tool_calls
        where project_id = $1 and session_id = $2
        order by ordinal`,
      [projectId, sessionId],
    );

    const session: Session = {
      id: row.id,
      deploymentId: row.deployment_id,
      environment: row.environment,
      startedAt: row.started_at.toISOString(),
      outcome: row.outcome,
      toolCalls: calls.rows.map((call) => {
        // Optional columns stay absent rather than null, as everywhere else.
        const entry: SessionToolCall = {
          timestamp: call.ts.toISOString(),
          toolName: call.tool_name,
          status: call.status,
          durationMs: call.duration_ms,
        };
        if (call.tool_schema_version !== null) entry.toolSchemaVersion = call.tool_schema_version;
        if (call.arguments !== null) entry.arguments = call.arguments;
        if (call.result !== null) entry.result = call.result;
        if (call.error_type !== null) entry.errorType = call.error_type;
        if (call.error_message !== null) entry.errorMessage = call.error_message;
        return entry;
      }),
    };
    if (row.ended_at !== null) session.endedAt = row.ended_at.toISOString();
    if (row.agent !== null) session.agent = row.agent;
    if (row.model !== null) session.model = row.model;
    if (row.intent !== null) session.intent = row.intent;
    if (row.failure_category !== null) session.failureCategory = row.failure_category;
    if (row.failure_tool !== null) session.failureTool = row.failure_tool;
    if (row.data_origin !== 'measured') session.dataOrigin = row.data_origin;
    if (row.transcript !== null) session.transcript = row.transcript;
    if (row.metadata !== null) session.metadata = row.metadata;
    return session;
  });
}

// --- tool profile ------------------------------------------------------

export async function getToolProduction(projectId: string, toolName: string): Promise<ToolProduction | null> {
  return withClient(async (client) => {
    const totals = await client.query<{
      calls: string;
      error_calls: string;
      p50: number | null;
      p95: number | null;
    }>(
      `select count(*) as calls,
              count(*) filter (where status = 'error') as error_calls,
              percentile_cont(0.5)  within group (order by duration_ms) as p50,
              percentile_cont(0.95) within group (order by duration_ms) as p95
         from session_tool_calls
        where project_id = $1 and tool_name = $2`,
      [projectId, toolName],
    );
    const calls = Number(totals.rows[0]?.calls ?? 0);
    if (calls === 0) return null;
    const errorCalls = Number(totals.rows[0].error_calls);

    const errorTypes = await client.query<{ error_type: string; count: string }>(
      `select coalesce(error_type, 'unknown') as error_type, count(*) as count
         from session_tool_calls
        where project_id = $1 and tool_name = $2 and status = 'error'
        group by 1
        order by count(*) desc, 1`,
      [projectId, toolName],
    );

    const perDeployment = await client.query<{
      deployment_id: string;
      app_version_id: string;
      calls: string;
      error_calls: string;
    }>(
      `select s.deployment_id, d.app_version_id,
              count(*) as calls,
              count(*) filter (where tc.status = 'error') as error_calls
         from session_tool_calls tc
         join sessions s on s.project_id = tc.project_id and s.id = tc.session_id
         join deployments d on d.project_id = s.project_id and d.id = s.deployment_id
        where tc.project_id = $1 and tc.tool_name = $2
        group by s.deployment_id, d.app_version_id, d.deployed_at
        order by d.deployed_at, s.deployment_id`,
      [projectId, toolName],
    );

    const round = (value: number) => Math.round(value * 1e6) / 1e6;

    return {
      toolName,
      calls,
      errorCalls,
      successRate: round((calls - errorCalls) / calls),
      p50DurationMs: round(totals.rows[0].p50 ?? 0),
      p95DurationMs: round(totals.rows[0].p95 ?? 0),
      errorTypes: errorTypes.rows.map((row) => ({ errorType: row.error_type, count: Number(row.count) })),
      byDeployment: perDeployment.rows.map((row) => {
        const rowCalls = Number(row.calls);
        const rowErrors = Number(row.error_calls);
        return {
          deploymentId: row.deployment_id,
          appVersionId: row.app_version_id,
          calls: rowCalls,
          errorCalls: rowErrors,
          successRate: rowCalls === 0 ? 0 : round((rowCalls - rowErrors) / rowCalls),
        };
      }),
    };
  });
}

// --- writes ------------------------------------------------------------

/**
 * Clears the production half of one generated project. Deployments own their
 * sessions through ON DELETE CASCADE, and sessions own their calls. This is
 * intentionally separate from `saveSessions`: callers that stream one
 * deployment at a time clear once, then append every batch.
 */
export async function clearProjectSessions(projectId: string): Promise<void> {
  await sql().query('delete from deployments where project_id = $1', [projectId]);
}

async function upsertDeployment(client: PoolClient, projectId: string, deployment: Deployment): Promise<void> {
  await client.query(
    `insert into deployments (project_id, id, app_version_id, environment, deployed_at, commit_sha, note)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (project_id, id) do update
        set app_version_id = excluded.app_version_id,
            environment = excluded.environment,
            deployed_at = excluded.deployed_at,
            commit_sha = excluded.commit_sha,
            note = excluded.note`,
    [
      projectId,
      deployment.id,
      deployment.appVersionId,
      deployment.environment,
      deployment.deployedAt,
      deployment.commitSha ?? null,
      deployment.note ?? null,
    ],
  );
}

/**
 * Writes deployments and sessions for one project.
 *
 * Delete-then-insert per session, like `replaceRun`: re-seeding a deterministic
 * generator must converge rather than accumulate, and a session that is
 * re-posted is a correction of the same session.
 */
export async function saveSessions(
  projectId: string,
  deployments: Deployment[],
  sessions: Session[],
  dataOrigin: DataOrigin = 'measured',
): Promise<void> {
  await transaction(async (client) => {
    for (const deployment of deployments) await upsertDeployment(client, projectId, deployment);

    const ids = sessions.map((session) => session.id);
    if (ids.length > 0) {
      await client.query('delete from sessions where project_id = $1 and id = any($2::text[])', [projectId, ids]);
    }

    const CHUNK = 200;
    for (let start = 0; start < sessions.length; start += CHUNK) {
      const chunk = sessions.slice(start, start + CHUNK);
      const values: unknown[] = [];
      const tuples = chunk.map((session) => {
        const base = values.length;
        values.push(
          projectId,
          session.id,
          session.deploymentId,
          session.environment,
          session.startedAt,
          session.endedAt ?? null,
          session.agent ?? null,
          session.model ?? null,
          session.intent ?? null,
          session.outcome,
          session.failureCategory ?? null,
          session.failureTool ?? null,
          session.dataOrigin ?? dataOrigin,
          session.transcript ? JSON.stringify(session.transcript) : null,
          session.metadata ? JSON.stringify(session.metadata) : null,
        );
        const at = (offset: number) => `$${base + offset}`;
        return (
          `(${at(1)}, ${at(2)}, ${at(3)}, ${at(4)}, ${at(5)}, ${at(6)}, ${at(7)}, ${at(8)}, ` +
          `${at(9)}, ${at(10)}, ${at(11)}, ${at(12)}, ${at(13)}, ${at(14)}::jsonb, ${at(15)}::jsonb)`
        );
      });
      await client.query(
        `insert into sessions
           (project_id, id, deployment_id, environment, started_at, ended_at, agent, model,
            intent, outcome, failure_category, failure_tool, data_origin, transcript, metadata)
         values ${tuples.join(', ')}`,
        values,
      );
    }

    // Calls are flattened across sessions so one insert can carry several
    // sessions' worth: a 320-session seed is over a thousand calls.
    const flattened = sessions.flatMap((session) =>
      session.toolCalls.map((call, ordinal) => ({ sessionId: session.id, ordinal, call })),
    );
    for (let start = 0; start < flattened.length; start += CHUNK) {
      const chunk = flattened.slice(start, start + CHUNK);
      const values: unknown[] = [];
      const tuples = chunk.map(({ sessionId, ordinal, call }) => {
        const base = values.length;
        values.push(
          projectId,
          sessionId,
          ordinal,
          call.timestamp,
          call.toolName,
          call.toolSchemaVersion ?? null,
          call.arguments === undefined ? null : JSON.stringify(call.arguments),
          call.result === undefined ? null : JSON.stringify(call.result),
          call.status,
          call.durationMs,
          call.errorType ?? null,
          call.errorMessage ?? null,
        );
        const at = (offset: number) => `$${base + offset}`;
        return (
          `(${at(1)}, ${at(2)}, ${at(3)}, ${at(4)}, ${at(5)}, ${at(6)}, ${at(7)}::jsonb, ` +
          `${at(8)}::jsonb, ${at(9)}, ${at(10)}, ${at(11)}, ${at(12)})`
        );
      });
      await client.query(
        `insert into session_tool_calls
           (project_id, session_id, ordinal, ts, tool_name, tool_schema_version,
            arguments, result, status, duration_ms, error_type, error_message)
         values ${tuples.join(', ')}`,
        values,
      );
    }
  });
}

// --- cases minted from sessions ----------------------------------------

export async function caseExists(projectId: string, caseId: string): Promise<boolean> {
  const { rowCount } = await sql().query('select 1 from eval_cases where project_id = $1 and case_id = $2', [
    projectId,
    caseId,
  ]);
  return (rowCount ?? 0) > 0;
}

/** Persists one case — the production-failure-becomes-a-test path. */
export async function saveCase(projectId: string, evalCase: EvalCase): Promise<void> {
  await transaction(async (client) => {
    await upsertCases(client, projectId, [evalCase], await nextOrdinal(client, projectId));
  });
}
