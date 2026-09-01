/**
 * Read model for a project too large to hydrate into a browser-side CatchflyDb.
 *
 * The legacy dataset endpoint remains the compatibility path for small
 * projects. These queries deliberately return summaries first and full traces
 * only on a drill-down route, keeping every Netlify response well below the
 * platform payload limit.
 */

import type {
  AppVersion,
  CaseResult,
  DataOrigin,
  EvalBootstrap,
  EvalCase,
  EvalCasePage,
  EvalResultFilters,
  EvalResultPage,
  EvalRunFilters,
  EvalRunPage,
  EvalRunSummary,
  FailureCategory,
  Outcome,
  Project,
  ProjectDataOrigin,
  RunMetrics,
} from '@catchfly/core/types.ts';

import type pg from 'pg';

import { withClient } from './db.ts';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

type Cursor = Record<string, string | number>;

function encodeCursor(value: Cursor): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decodeCursor(cursor: string | null | undefined): Cursor | null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Cursor) : null;
  } catch {
    return null;
  }
}

function pageSize(limit?: number): number {
  return Math.min(Math.max(Math.trunc(limit ?? DEFAULT_PAGE_SIZE) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
}

/**
 * `total` counts the whole filtered set, so it is the same on every page — and
 * counting it again per page is a second round trip for an answer we already
 * had. It rides in the cursor instead, which keeps "N of M" exact while the
 * count runs once, for the first page.
 */
function carriedTotal(decoded: Cursor | null): number | null {
  return typeof decoded?.total === 'number' ? decoded.total : null;
}

export class EvalCursorError extends Error {
  constructor() {
    super('cursor expired — restart from the first page');
    this.name = 'EvalCursorError';
  }
}

type ProjectRow = {
  id: string;
  name: string;
  data_origin: ProjectDataOrigin;
  generator_version: string | null;
  generator_seed: string | null;
};

async function readProject(client: pg.PoolClient, projectId: string): Promise<ProjectRow | null> {
  const { rows } = await client.query<ProjectRow>(
    `select id, name, data_origin, generator_version, generator_seed
       from projects where id = $1`,
    [projectId],
  );
  return rows[0] ?? null;
}

async function readVersions(client: pg.PoolClient, projectId: string): Promise<AppVersion[]> {
  {
    const { rows } = await client.query<{
      id: string;
      label: string;
      released_at: Date;
      note: string | null;
      tool_manifest: AppVersion['toolManifest'];
    }>(
      `select id, label, released_at, note, tool_manifest
         from app_versions where project_id = $1 order by released_at, id`,
      [projectId],
    );
    return rows.map((row) => ({
      id: row.id,
      label: row.label,
      releasedAt: row.released_at.toISOString(),
      toolManifest: row.tool_manifest,
      ...(row.note === null ? {} : { note: row.note }),
    }));
  }
}

export async function loadEvalBootstrap(projectId: string): Promise<EvalBootstrap | null> {
  return withClient(async (client) => {
    const row = await readProject(client, projectId);
    if (!row) return null;
    const versions = await readVersions(client, projectId);
    const { rows: totals } = await client.query<{
      run_count: string;
      case_count: string;
      models: string[];
    }>(
      `select
         (select count(*) from eval_runs where project_id = $1) as run_count,
         (select count(*) from eval_cases where project_id = $1) as case_count,
         (select coalesce(array_agg(distinct model order by model), '{}')
            from eval_runs where project_id = $1) as models`,
      [projectId],
    );
    const project: Project = {
      id: row.id,
      name: row.name,
      appVersions: versions,
      dataOrigin: row.data_origin,
      ...(row.generator_version === null ? {} : { generatorVersion: row.generator_version }),
      ...(row.generator_seed === null ? {} : { generatorSeed: row.generator_seed }),
    };
    return {
      project,
      models: totals[0]?.models ?? [],
      runCount: Number(totals[0]?.run_count ?? 0),
      caseCount: Number(totals[0]?.case_count ?? 0),
    };
  });
}

function runWhere(projectId: string, filters: EvalRunFilters): { clause: string; values: unknown[] } {
  const values: unknown[] = [projectId];
  const conditions = ['project_id = $1'];
  const put = (value: unknown) => `$${values.push(value)}`;
  if (filters.appVersionId) conditions.push(`app_version_id = ${put(filters.appVersionId)}`);
  if (filters.model) conditions.push(`model = ${put(filters.model)}`);
  if (filters.from) conditions.push(`ts >= ${put(filters.from)}::timestamptz`);
  if (filters.to) conditions.push(`ts <= ${put(filters.to)}::timestamptz`);
  return { clause: conditions.join(' and '), values };
}

export async function searchEvalRuns(
  projectId: string,
  filters: EvalRunFilters,
  cursor?: string | null,
  limit?: number,
): Promise<EvalRunPage> {
  const { clause, values } = runWhere(projectId, filters);
  const decoded = decodeCursor(cursor);
  if (cursor && (!decoded || typeof decoded.ts !== 'string' || typeof decoded.id !== 'string')) throw new EvalCursorError();
  const size = pageSize(limit);

  return withClient(async (client) => {
    const known = carriedTotal(decoded);
    const total =
      known ??
      Number(
        (
          await client.query<{ total: string }>(
            `select count(*) as total from eval_runs where ${clause}`,
            values,
          )
        ).rows[0]?.total ?? 0,
      );
    let keyset = '';
    if (decoded) {
      const ts = values.push(decoded.ts);
      const id = values.push(decoded.id);
      keyset = ` and (ts, id) < ($${ts}::timestamptz, $${id})`;
    }
    const take = values.push(size + 1);
    const { rows } = await client.query<{
      id: string;
      app_version_id: string;
      model: string;
      backend: string | null;
      ts: Date;
      metrics: RunMetrics;
      data_origin: DataOrigin;
    }>(
      `select id, app_version_id, model, backend, ts, metrics, data_origin
         from eval_runs where ${clause}${keyset}
         order by ts desc, id desc limit $${take}`,
      values,
    );
    const more = rows.length > size;
    const runs: EvalRunSummary[] = rows.slice(0, size).map((row) => ({
      id: row.id,
      appVersionId: row.app_version_id,
      model: row.model,
      timestamp: row.ts.toISOString(),
      metrics: row.metrics,
      ...(row.backend === null ? {} : { backend: row.backend }),
      ...(row.data_origin === 'measured' ? {} : { dataOrigin: row.data_origin }),
    }));
    const last = runs[runs.length - 1];
    return {
      runs,
      total,
      nextCursor: more && last ? encodeCursor({ ts: last.timestamp, id: last.id, total }) : null,
    };
  });
}

function resultWhere(projectId: string, runId: string, filters: EvalResultFilters): { clause: string; values: unknown[] } {
  const values: unknown[] = [projectId, runId];
  const conditions = ['r.project_id = $1', 'r.run_id = $2'];
  const put = (value: unknown) => `$${values.push(value)}`;
  if (filters.outcome) conditions.push(`r.outcome = ${put(filters.outcome)}`);
  if (filters.category) conditions.push(`r.category = ${put(filters.category)}`);
  if (filters.caseId) conditions.push(`r.case_id = ${put(filters.caseId)}`);
  return { clause: conditions.join(' and '), values };
}

export async function searchEvalResults(
  projectId: string,
  runId: string,
  filters: EvalResultFilters,
  cursor?: string | null,
  limit?: number,
): Promise<EvalResultPage> {
  const { clause, values } = resultWhere(projectId, runId, filters);
  const decoded = decodeCursor(cursor);
  if (
    cursor &&
    (!decoded || typeof decoded.ordinal !== 'number' || typeof decoded.caseId !== 'string' || typeof decoded.runIndex !== 'number')
  ) {
    throw new EvalCursorError();
  }
  const size = pageSize(limit);

  return withClient(async (client) => {
    const known = carriedTotal(decoded);
    const total =
      known ??
      Number(
        (
          await client.query<{ total: string }>(
            `select count(*) as total from case_results r where ${clause}`,
            values,
          )
        ).rows[0]?.total ?? 0,
      );
    let keyset = '';
    if (decoded) {
      const ordinal = values.push(decoded.ordinal);
      const caseId = values.push(decoded.caseId);
      const runIndex = values.push(decoded.runIndex);
      keyset = ` and (c.ordinal, r.case_id, r.run_index) > ($${ordinal}, $${caseId}, $${runIndex})`;
    }
    const take = values.push(size + 1);
    const { rows } = await client.query<{
      case_id: string;
      run_index: number;
      outcome: Outcome;
      category: FailureCategory | null;
      latency_ms: number | null;
      cost_usd: number | null;
      failure_reason: string | null;
      actual_calls: CaseResult['actualCalls'];
      trajectory: CaseResult['trajectory'];
      ordinal: number;
    }>(
      `select r.case_id, r.run_index, r.outcome, r.category, r.latency_ms, r.cost_usd,
              r.failure_reason, r.actual_calls, r.trajectory, c.ordinal
         from case_results r
         join eval_cases c on c.project_id = r.project_id and c.case_id = r.case_id
        where ${clause}${keyset}
        order by c.ordinal, r.case_id, r.run_index limit $${take}`,
      values,
    );
    const more = rows.length > size;
    const results: CaseResult[] = rows.slice(0, size).map((row) => ({
      caseId: row.case_id,
      runIndex: row.run_index,
      outcome: row.outcome,
      actualCalls: row.actual_calls,
      trajectory: row.trajectory,
      ...(row.category === null ? {} : { category: row.category }),
      ...(row.latency_ms === null ? {} : { latencyMs: row.latency_ms }),
      ...(row.cost_usd === null ? {} : { costUsd: row.cost_usd }),
      ...(row.failure_reason === null ? {} : { failureReason: row.failure_reason }),
    }));
    const last = rows[Math.min(rows.length, size) - 1];
    return {
      results,
      total,
      nextCursor:
        more && last
          ? encodeCursor({
              ordinal: last.ordinal,
              caseId: last.case_id,
              runIndex: last.run_index,
              total,
            })
          : null,
    };
  });
}

export async function getEvalResult(
  projectId: string,
  runId: string,
  caseId: string,
  runIndex: number,
): Promise<CaseResult | null> {
  return withClient(async (client) => {
    const { rows } = await client.query<{
      case_id: string;
      run_index: number;
      outcome: Outcome;
      category: FailureCategory | null;
      latency_ms: number | null;
      cost_usd: number | null;
      failure_reason: string | null;
      actual_calls: CaseResult['actualCalls'];
      trajectory: CaseResult['trajectory'];
    }>(
      `select case_id, run_index, outcome, category, latency_ms, cost_usd, failure_reason, actual_calls, trajectory
         from case_results
        where project_id = $1 and run_id = $2 and case_id = $3 and run_index = $4`,
      [projectId, runId, caseId, runIndex],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      caseId: row.case_id,
      runIndex: row.run_index,
      outcome: row.outcome,
      actualCalls: row.actual_calls,
      trajectory: row.trajectory,
      ...(row.category === null ? {} : { category: row.category }),
      ...(row.latency_ms === null ? {} : { latencyMs: row.latency_ms }),
      ...(row.cost_usd === null ? {} : { costUsd: row.cost_usd }),
      ...(row.failure_reason === null ? {} : { failureReason: row.failure_reason }),
    };
  });
}

export async function searchEvalCases(
  projectId: string,
  search?: string,
  cursor?: string | null,
  limit?: number,
): Promise<EvalCasePage> {
  const values: unknown[] = [projectId];
  const conditions = ['project_id = $1'];
  if (search?.trim()) {
    values.push(`%${search.trim().toLowerCase()}%`);
    conditions.push(`(lower(name) like $2 or lower(prompt) like $2)`);
  }
  const decoded = decodeCursor(cursor);
  if (cursor && (!decoded || typeof decoded.ordinal !== 'number' || typeof decoded.caseId !== 'string')) {
    throw new EvalCursorError();
  }
  const clause = conditions.join(' and ');
  const size = pageSize(limit);
  return withClient(async (client) => {
    const known = carriedTotal(decoded);
    const total =
      known ??
      Number(
        (
          await client.query<{ total: string }>(
            `select count(*) as total from eval_cases where ${clause}`,
            values,
          )
        ).rows[0]?.total ?? 0,
      );
    let keyset = '';
    if (decoded) {
      const ordinal = values.push(decoded.ordinal);
      const caseId = values.push(decoded.caseId);
      keyset = ` and (ordinal, case_id) > ($${ordinal}, $${caseId})`;
    }
    const take = values.push(size + 1);
    const { rows } = await client.query<{
      case_id: string;
      name: string;
      prompt: string;
      expected_call: EvalCase['expectedCall'];
      expected_behavior: string | null;
      source_session_id: string | null;
      ordinal: number;
    }>(
      `select case_id, name, prompt, expected_call, expected_behavior, source_session_id, ordinal
         from eval_cases where ${clause}${keyset}
         order by ordinal, case_id limit $${take}`,
      values,
    );
    const more = rows.length > size;
    const cases = rows.slice(0, size).map((row) => ({
      caseId: row.case_id,
      name: row.name,
      prompt: row.prompt,
      expectedCall: row.expected_call,
      ...(row.expected_behavior === null ? {} : { expectedBehavior: row.expected_behavior }),
      ...(row.source_session_id === null ? {} : { sourceSessionId: row.source_session_id }),
    }));
    const last = rows[Math.min(rows.length, size) - 1];
    return {
      cases,
      total,
      nextCursor:
        more && last
          ? encodeCursor({ ordinal: last.ordinal, caseId: last.case_id, total })
          : null,
    };
  });
}

export async function getEvalCase(projectId: string, caseId: string): Promise<EvalCase | null> {
  return withClient(async (client) => {
    const { rows } = await client.query<{
      case_id: string;
      name: string;
      prompt: string;
      expected_call: EvalCase['expectedCall'];
      expected_behavior: string | null;
      source_session_id: string | null;
    }>(
      `select case_id, name, prompt, expected_call, expected_behavior, source_session_id
         from eval_cases where project_id = $1 and case_id = $2`,
      [projectId, caseId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      caseId: row.case_id,
      name: row.name,
      prompt: row.prompt,
      expectedCall: row.expected_call,
      ...(row.expected_behavior === null ? {} : { expectedBehavior: row.expected_behavior }),
      ...(row.source_session_id === null ? {} : { sourceSessionId: row.source_session_id }),
    };
  });
}
