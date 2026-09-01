/**
 * Dataset <-> tables. The exact inverse of `CatchflyDataset`, so what
 * `loadDataset` returns feeds `createDb()` unchanged and every query, selector
 * and WebMCP tool behaves as it did when the data came from a file.
 */

import type { PoolClient } from 'pg';

import type {
  AppVersion,
  CaseResult,
  CatchflyDataset,
  DataOrigin,
  EvalCase,
  EvalRun,
  ProjectDataOrigin,
  RunMetrics,
} from '@catchfly/core/types.ts';

import { sql, transaction, withClient } from './db.ts';

export type ProjectSummary = {
  id: string;
  name: string;
  description: string;
  runCount: number;
  lastRunAt: string | null;
  dataOrigin: ProjectDataOrigin;
};

export async function listProjects(): Promise<ProjectSummary[]> {
  const { rows } = await sql().query<{
    id: string;
    name: string;
    description: string;
    data_origin: ProjectDataOrigin;
    run_count: string;
    last_run_at: Date | null;
  }>(
    `select p.id, p.name, p.description, p.data_origin,
            count(r.id) as run_count,
            max(r.ts)   as last_run_at
       from projects p
       left join eval_runs r on r.project_id = p.id
      group by p.id, p.name, p.description, p.data_origin
      order by p.created_at, p.id`,
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    dataOrigin: row.data_origin,
    runCount: Number(row.run_count),
    lastRunAt: row.last_run_at?.toISOString() ?? null,
  }));
}

export async function projectExists(projectId: string): Promise<boolean> {
  const { rowCount } = await sql().query('select 1 from projects where id = $1', [projectId]);
  return (rowCount ?? 0) > 0;
}

export async function projectIsReadOnly(projectId: string): Promise<boolean> {
  const { rows } = await sql().query<{ data_origin: ProjectDataOrigin; generator_version: string | null }>(
    'select data_origin, generator_version from projects where id = $1',
    [projectId],
  );
  const row = rows[0];
  return Boolean(row && row.data_origin === 'synthetic' && row.generator_version);
}

export async function createProject(input: {
  id: string;
  name: string;
  description?: string;
  orgId?: string;
}): Promise<ProjectSummary> {
  await transaction(async (client) => {
    await client.query(
      `insert into projects (id, name, description, org_id) values ($1, $2, $3, $4)`,
      [input.id, input.name, input.description ?? '', input.orgId ?? null],
    );
    await client.query(
      `insert into environments (project_id, id, name, kind)
       values ($1, 'production', 'Production', 'production')`,
      [input.id],
    );
    await client.query(
      `insert into data_policies (project_id, environment_id)
       values ($1, 'production')`,
      [input.id],
    );
  });
  return { ...input, description: input.description ?? '', dataOrigin: 'measured', runCount: 0, lastRunAt: null };
}

/**
 * The whole project, assembled in four queries rather than per-run round trips.
 *
 * This is deliberately the entire dataset: every consumer downstream — the
 * query layer, the selectors, the tools — is built on a complete in-memory
 * index. Serving slices would mean rewriting all of them, so the seam stays
 * here until payload size actually forces the issue.
 */
export async function loadDataset(projectId: string): Promise<CatchflyDataset | null> {
  return withClient(async (client) => {
    const project = await client.query<{
      id: string;
      name: string;
      data_origin: ProjectDataOrigin;
      generator_version: string | null;
      generator_seed: string | null;
    }>(
      'select id, name, data_origin, generator_version, generator_seed from projects where id = $1',
      [projectId],
    );
    if (project.rowCount === 0) return null;

    const versions = await client.query<{
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

    const cases = await client.query<{
      case_id: string;
      name: string;
      prompt: string;
      expected_call: EvalCase['expectedCall'];
      expected_behavior: string | null;
      source_session_id: string | null;
    }>(
      `select case_id, name, prompt, expected_call, expected_behavior, source_session_id
         from eval_cases where project_id = $1 order by ordinal, case_id`,
      [projectId],
    );

    const runs = await client.query<{
      id: string;
      app_version_id: string;
      model: string;
      backend: string | null;
      ts: Date;
      metrics: RunMetrics;
      data_origin: DataOrigin;
    }>(
      `select id, app_version_id, model, backend, ts, metrics, data_origin
         from eval_runs where project_id = $1 order by ordinal, ts, id`,
      [projectId],
    );

    const results = await client.query<{
      run_id: string;
      case_id: string;
      run_index: number;
      outcome: CaseResult['outcome'];
      category: CaseResult['category'] | null;
      latency_ms: number | null;
      cost_usd: number | null;
      failure_reason: string | null;
      actual_calls: CaseResult['actualCalls'];
      trajectory: CaseResult['trajectory'];
    }>(
      `select r.run_id, r.case_id, r.run_index, r.outcome, r.category,
              r.latency_ms, r.cost_usd, r.failure_reason, r.actual_calls, r.trajectory
         from case_results r
         join eval_cases c on c.project_id = r.project_id and c.case_id = r.case_id
        where r.project_id = $1
        order by r.run_id, c.ordinal, c.case_id, r.run_index`,
      [projectId],
    );

    const byRun = new Map<string, CaseResult[]>();
    for (const row of results.rows) {
      const result: CaseResult = {
        caseId: row.case_id,
        runIndex: row.run_index,
        outcome: row.outcome,
        actualCalls: row.actual_calls,
        trajectory: row.trajectory,
      };
      // Optional columns stay absent rather than null: the data model uses
      // "undefined" to mean "this run never measured it".
      if (row.category) result.category = row.category;
      if (row.latency_ms !== null) result.latencyMs = row.latency_ms;
      if (row.cost_usd !== null) result.costUsd = row.cost_usd;
      if (row.failure_reason !== null) result.failureReason = row.failure_reason;
      const bucket = byRun.get(row.run_id);
      if (bucket) bucket.push(result);
      else byRun.set(row.run_id, [result]);
    }

    return {
      project: {
        id: project.rows[0].id,
        name: project.rows[0].name,
        appVersions: versions.rows.map((row) => {
          const version: AppVersion = {
            id: row.id,
            label: row.label,
            releasedAt: row.released_at.toISOString(),
            toolManifest: row.tool_manifest,
          };
          if (row.note !== null) version.note = row.note;
          return version;
        }),
        ...(project.rows[0].data_origin === 'measured' ? {} : { dataOrigin: project.rows[0].data_origin }),
        ...(project.rows[0].generator_version === null
          ? {}
          : { generatorVersion: project.rows[0].generator_version }),
        ...(project.rows[0].generator_seed === null ? {} : { generatorSeed: project.rows[0].generator_seed }),
      },
      cases: cases.rows.map((row) => {
        const evalCase: EvalCase = {
          caseId: row.case_id,
          name: row.name,
          prompt: row.prompt,
          expectedCall: row.expected_call,
        };
        if (row.expected_behavior !== null) evalCase.expectedBehavior = row.expected_behavior;
        if (row.source_session_id !== null) evalCase.sourceSessionId = row.source_session_id;
        return evalCase;
      }),
      runs: runs.rows.map((row) => {
        const run: EvalRun = {
          id: row.id,
          appVersionId: row.app_version_id,
          model: row.model,
          timestamp: row.ts.toISOString(),
          metrics: row.metrics,
          results: byRun.get(row.id) ?? [],
        };
        if (row.backend !== null) run.backend = row.backend;
        if (row.data_origin !== 'measured') run.dataOrigin = row.data_origin;
        return run;
      }),
    };
  });
}

// --- writes ------------------------------------------------------------

/** Upserts a version. Re-importing a report must not duplicate its manifest. */
async function upsertVersion(
  client: PoolClient,
  projectId: string,
  version: AppVersion,
): Promise<void> {
  await client.query(
    `insert into app_versions (project_id, id, label, released_at, note, tool_manifest)
     values ($1, $2, $3, $4, $5, $6::jsonb)
     on conflict (project_id, id) do update
        set label = excluded.label,
            released_at = excluded.released_at,
            note = excluded.note,
            tool_manifest = excluded.tool_manifest`,
    [
      projectId,
      version.id,
      version.label,
      version.releasedAt,
      version.note ?? null,
      JSON.stringify(version.toolManifest),
    ],
  );
}

/**
 * Upserts case definitions.
 *
 * A case belongs to the project, not to the run that happened to carry it, so
 * two reports naming the same case converge on one row. The definition from the
 * newest report wins — it is the one whose expectations were actually evaluated.
 */
export async function upsertCases(
  client: PoolClient,
  projectId: string,
  cases: EvalCase[],
  startAt = 0,
  /** Seeding owns the whole suite and restates its order; an import must not. */
  reindex = false,
): Promise<void> {
  for (const [index, evalCase] of cases.entries()) {
    await client.query(
      `insert into eval_cases
         (project_id, case_id, name, prompt, expected_call, expected_behavior, ordinal, source_session_id)
       values ($1, $2, $3, $4, $5::jsonb, $6, $7, $9)
       on conflict (project_id, case_id) do update
          set name = excluded.name,
              prompt = excluded.prompt,
              expected_call = excluded.expected_call,
              expected_behavior = excluded.expected_behavior,
              ordinal = case when $8 then excluded.ordinal else eval_cases.ordinal end,
              -- Provenance is written once. A later edit of the case must not
              -- erase the fact that it came from a production failure.
              source_session_id = coalesce(excluded.source_session_id, eval_cases.source_session_id)`,
      [
        projectId,
        evalCase.caseId,
        evalCase.name,
        evalCase.prompt,
        JSON.stringify(evalCase.expectedCall),
        evalCase.expectedBehavior ?? null,
        startAt + index,
        reindex,
        evalCase.sourceSessionId ?? null,
      ],
    );
  }
}

/**
 * Where a re-imported run should sit: its existing slot if it has one, so a
 * correction does not jump to the end of the dashboard.
 */
async function nextRunOrdinal(client: PoolClient, projectId: string, runId: string): Promise<number> {
  const { rows } = await client.query<{ ordinal: number | null; next: number }>(
    `select (select ordinal from eval_runs where project_id = $1 and id = $2) as ordinal,
            coalesce((select max(ordinal) + 1 from eval_runs where project_id = $1), 0) as next`,
    [projectId, runId],
  );
  return Number(rows[0].ordinal ?? rows[0].next);
}

/** Where a newly imported case should sit: after everything already stored. */
export async function nextOrdinal(client: PoolClient, projectId: string): Promise<number> {
  const { rows } = await client.query<{ next: number }>(
    'select coalesce(max(ordinal) + 1, 0) as next from eval_cases where project_id = $1',
    [projectId],
  );
  return Number(rows[0].next);
}

/**
 * Replaces a run and its results.
 *
 * Replace, not append: re-importing the same report is a correction, and the
 * file-based merge this mirrors (`mergeRun`) has always been idempotent. The
 * delete cascades to case_results.
 */
async function replaceRun(
  client: PoolClient,
  projectId: string,
  run: EvalRun,
  ordinal: number,
): Promise<void> {
  await client.query('delete from eval_runs where project_id = $1 and id = $2', [projectId, run.id]);
  await client.query(
    `insert into eval_runs (project_id, id, app_version_id, model, backend, ts, metrics, ordinal, data_origin)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)`,
    [
      projectId,
      run.id,
      run.appVersionId,
      run.model,
      run.backend ?? null,
      run.timestamp,
      JSON.stringify(run.metrics),
      ordinal,
      run.dataOrigin ?? 'measured',
    ],
  );

  // One multi-row insert per chunk: a 200-case run is 400 rows, and a
  // round trip per row over a pooled connection is the slow way to spend a
  // request's whole budget.
  const CHUNK = 200;
  for (let start = 0; start < run.results.length; start += CHUNK) {
    const chunk = run.results.slice(start, start + CHUNK);
    const values: unknown[] = [];
    const tuples = chunk.map((result, index) => {
      const base = index * 10;
      values.push(
        projectId,
        run.id,
        result.caseId,
        result.runIndex,
        result.outcome,
        result.category ?? null,
        result.latencyMs ?? null,
        result.costUsd ?? null,
        result.failureReason ?? null,
        JSON.stringify({ actualCalls: result.actualCalls, trajectory: result.trajectory }),
      );
      return (
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, ` +
        `$${base + 7}, $${base + 8}, $${base + 9}, ` +
        `($${base + 10}::jsonb)->'actualCalls', ($${base + 10}::jsonb)->'trajectory')`
      );
    });
    await client.query(
      `insert into case_results
         (project_id, run_id, case_id, run_index, outcome, category,
          latency_ms, cost_usd, failure_reason, actual_calls, trajectory)
       values ${tuples.join(', ')}`,
      values,
    );
  }
}

export type RunUpload = {
  version: AppVersion;
  cases: EvalCase[];
  run: EvalRun;
};

/** Persists one imported run: its version, its cases and its results, atomically. */
export async function saveRun(projectId: string, upload: RunUpload): Promise<void> {
  await transaction(async (client) => {
    await upsertVersion(client, projectId, upload.version);
    await upsertCases(client, projectId, upload.cases, await nextOrdinal(client, projectId));
    await replaceRun(client, projectId, upload.run, await nextRunOrdinal(client, projectId, upload.run.id));
  });
}

/** Writes a whole dataset — the seeding path. Idempotent, run to run. */
export async function saveDataset(dataset: CatchflyDataset, description = ''): Promise<void> {
  await transaction(async (client) => {
    await client.query(
      `insert into projects (id, name, description, data_origin, generator_version, generator_seed)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (id) do update
          set name = excluded.name,
              description = excluded.description,
              data_origin = excluded.data_origin,
              generator_version = excluded.generator_version,
              generator_seed = excluded.generator_seed`,
      [
        dataset.project.id,
        dataset.project.name,
        description,
        dataset.project.dataOrigin ?? 'measured',
        dataset.project.generatorVersion ?? null,
        dataset.project.generatorSeed ?? null,
      ],
    );
    for (const version of dataset.project.appVersions) {
      await upsertVersion(client, dataset.project.id, version);
    }
    await upsertCases(client, dataset.project.id, dataset.cases, 0, true);
    // Seeding owns the whole suite, so a case the dataset no longer contains is
    // one the suite dropped — usually because it was renamed. Left in place it
    // would sit in the case table for ever with no results under it, looking
    // like a case every model silently skipped. Imports must never do this:
    // `saveRun` carries only the cases of one report.
    const keep = dataset.cases.map((evalCase) => evalCase.caseId);
    await client.query(
      keep.length > 0
        ? 'delete from eval_cases where project_id = $1 and case_id <> all($2::text[])'
        : 'delete from eval_cases where project_id = $1',
      keep.length > 0 ? [dataset.project.id, keep] : [dataset.project.id],
    );
    for (const [index, run] of dataset.runs.entries()) {
      await replaceRun(client, dataset.project.id, run, index);
    }

    // A whole-dataset seed owns the run and version sets too. Without pruning,
    // regenerating a smaller synthetic world leaves historical rows that no
    // longer belong to the seed and silently changes every aggregate.
    const keepRuns = dataset.runs.map((run) => run.id);
    await client.query(
      keepRuns.length > 0
        ? 'delete from eval_runs where project_id = $1 and id <> all($2::text[])'
        : 'delete from eval_runs where project_id = $1',
      keepRuns.length > 0 ? [dataset.project.id, keepRuns] : [dataset.project.id],
    );

    const keepVersions = dataset.project.appVersions.map((version) => version.id);
    await client.query(
      keepVersions.length > 0
        ? 'delete from app_versions where project_id = $1 and id <> all($2::text[])'
        : 'delete from app_versions where project_id = $1',
      keepVersions.length > 0 ? [dataset.project.id, keepVersions] : [dataset.project.id],
    );
  });
}
