/** Server-side incident read model for the large synthetic investigation lab. */

import type {
  FailureCategory,
  IncidentOverview,
  IncidentSummary,
  IncidentTimelinePoint,
} from '@catchfly/core/types.ts';

import { withClient } from './db.ts';

type ScenarioMeta = {
  title: string;
  label: string;
  kind: IncidentTimelinePoint['kind'];
  tools: string[];
  category: FailureCategory | null;
  summary: string;
};

const SCENARIOS: Record<string, ScenarioMeta> = {
  control: {
    title: 'Clean control', label: 'control', kind: 'control', tools: [], category: null,
    summary: 'Stable control release used as the baseline for this incident cycle.',
  },
  selection: {
    title: 'Search and verification overlap', label: 'selection overlap', kind: 'regression',
    tools: ['search_submissions', 'get_submission', 'verify_technology_claim'], category: 'tool-selection',
    summary: 'Overlapping descriptions make agents choose search, lookup and verification inconsistently.',
  },
  arguments: {
    title: 'Score contract loosened', label: 'argument contract', kind: 'regression',
    tools: ['score_submission'], category: 'argument-errors',
    summary: 'Removing the score constraints produces invalid criteria and out-of-range values.',
  },
  sequencing: {
    title: 'Evidence precondition removed', label: 'sequence contract', kind: 'regression',
    tools: ['highlight_evidence'], category: 'sequencing',
    summary: 'The manifest stops saying that evidence must be found before it can be highlighted.',
  },
  'removed-tool': {
    title: 'Verification tool removed', label: 'missing tool', kind: 'regression',
    tools: ['verify_technology_claim'], category: 'hallucinated-tool',
    summary: 'Agents continue reaching for a verification tool that disappeared from the manifest.',
  },
  'answer-quality': {
    title: 'Scoring answer became unusable', label: 'answer quality', kind: 'regression',
    tools: ['score_submission'], category: 'structured-output',
    summary: 'Calls succeed, but the final scoring answer no longer satisfies the reviewer workflow.',
  },
  abandonment: {
    title: 'Review path abandoned', label: 'abandonment', kind: 'regression',
    tools: ['search_submissions', 'verify_technology_claim'], category: 'tool-selection',
    summary: 'Agents stop part-way through an ambiguous review path instead of guessing.',
  },
  'latency-decoy': {
    title: 'Latency spike without quality loss', label: 'latency decoy', kind: 'decoy',
    tools: [], category: null,
    summary: 'Tool calls are much slower, but eval quality and production completion remain stable.',
  },
  recovery: {
    title: 'Contract recovery', label: 'recovery', kind: 'recovery', tools: [], category: null,
    summary: 'Precise descriptions and constraints return, and the incident signals fall back toward control.',
  },
};

const round = (value: number, places = 6): number => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

function scenarioId(note: string | null): string {
  return note?.match(/^Synthetic scenario: ([\w-]+)\.$/)?.[1] ?? 'control';
}

/**
 * The endpoint already asks Netlify's CDN to hold this for five minutes, which
 * does nothing for a self-hosted deployment or for `npm run dev` — and this is
 * the most expensive read in the app, aggregating every deployment's sessions.
 * A short in-process memo gives the same relief everywhere, well inside the
 * window the CDN is already allowed to serve a stale copy for.
 */
const OVERVIEW_TTL_MS = 30_000;

const overviewCache = new Map<string, { at: number; value: Promise<IncidentOverview> }>();

export function forgetIncidentOverview(projectId: string): void {
  overviewCache.delete(projectId);
}

export async function loadIncidentOverview(projectId: string): Promise<IncidentOverview> {
  const cached = overviewCache.get(projectId);
  if (cached && Date.now() - cached.at < OVERVIEW_TTL_MS) return cached.value;

  const value = queryIncidentOverview(projectId);
  overviewCache.set(projectId, { at: Date.now(), value });
  // A failed read must not be what the next caller gets for the next 30 seconds.
  value.catch(() => overviewCache.delete(projectId));
  return value;
}

async function queryIncidentOverview(projectId: string): Promise<IncidentOverview> {
  return withClient(async (client) => {
    const [pointsResult, modelsResult] = await Promise.all([
      client.query<{
        app_version_id: string;
        label: string;
        released_at: Date;
        note: string | null;
        deployment_id: string | null;
        eval_passes: string;
        eval_attempts: string;
        production_sessions: string;
        production_failures: string;
        avg_tool_latency_ms: string;
      }>(
        `with eval as (
           select app_version_id,
                  sum((metrics->>'passCount')::bigint) as passes,
                  sum((metrics->>'testCount')::bigint) as attempts,
                  sum(
                    coalesce((metrics->>'avgLatencyMs')::double precision, 0) *
                    (metrics->>'testCount')::bigint
                  ) / nullif(sum((metrics->>'testCount')::bigint), 0) as average_latency
             from eval_runs where project_id = $1 group by app_version_id
         ), production as (
           select d.app_version_id, min(d.id) as deployment_id,
                  count(s.id) as sessions,
                  count(s.id) filter (where s.outcome in ('failed', 'abandoned')) as failures
             from deployments d
             left join sessions s on s.project_id = d.project_id and s.deployment_id = d.id
            where d.project_id = $1 group by d.app_version_id
         )
         select v.id as app_version_id, v.label, v.released_at, v.note,
                p.deployment_id,
                coalesce(e.passes, 0) as eval_passes,
                coalesce(e.attempts, 0) as eval_attempts,
                coalesce(p.sessions, 0) as production_sessions,
                coalesce(p.failures, 0) as production_failures,
                coalesce(e.average_latency, 0) as avg_tool_latency_ms
           from app_versions v
           left join eval e on e.app_version_id = v.id
           left join production p on p.app_version_id = v.id
          where v.project_id = $1
          order by v.released_at, v.id`,
        [projectId],
      ),
      client.query<{ app_version_id: string; model: string; run_id: string; success_rate: string }>(
        `select app_version_id, model, id as run_id,
                coalesce((metrics->>'successRate')::double precision, 0) as success_rate
           from eval_runs where project_id = $1 order by app_version_id, model`,
        [projectId],
      ),
    ]);

    const timeline: IncidentTimelinePoint[] = pointsResult.rows.map((row) => {
      const id = scenarioId(row.note);
      const meta = SCENARIOS[id] ?? SCENARIOS.control;
      const attempts = Number(row.eval_attempts);
      const sessions = Number(row.production_sessions);
      return {
        appVersionId: row.app_version_id,
        appVersionLabel: row.label,
        releasedAt: row.released_at.toISOString(),
        deploymentId: row.deployment_id,
        scenarioId: id,
        scenarioLabel: meta.label,
        kind: meta.kind,
        evalSuccessRate: attempts === 0 ? 0 : Number(row.eval_passes) / attempts,
        evalAttempts: attempts,
        productionFailureRate: sessions === 0 ? 0 : Number(row.production_failures) / sessions,
        productionSessions: sessions,
        avgToolLatencyMs: Number(row.avg_tool_latency_ms),
      };
    });

    const byVersionModel = new Map(
      modelsResult.rows.map((row) => [
        `${row.app_version_id}::${row.model}`,
        { rate: Number(row.success_rate), runId: row.run_id },
      ]),
    );
    const models = [...new Set(modelsResult.rows.map((row) => row.model))];
    const occurrences = new Map<string, Array<{ point: IncidentTimelinePoint; baseline: IncidentTimelinePoint }>>();
    let cycleControl: IncidentTimelinePoint | null = null;
    for (const point of timeline) {
      if (point.scenarioId === 'control') cycleControl = point;
      if (point.kind === 'control' || !cycleControl) continue;
      const baseline =
        point.kind === 'recovery'
          ? [...timeline]
              .slice(0, timeline.indexOf(point))
              .reverse()
              .find((entry) => entry.kind === 'regression') ?? cycleControl
          : cycleControl;
      const bucket = occurrences.get(point.scenarioId) ?? [];
      bucket.push({ point, baseline });
      occurrences.set(point.scenarioId, bucket);
    }

    const incidents: IncidentSummary[] = [...occurrences].map(([id, entries]) => {
      const meta = SCENARIOS[id] ?? SCENARIOS.control;
      const latest = entries[entries.length - 1];
      const deltas = entries.map(({ point, baseline }) => point.evalSuccessRate - baseline.evalSuccessRate);
      const productionDeltas = entries.map(
        ({ point, baseline }) => point.productionFailureRate - baseline.productionFailureRate,
      );
      const latencyMultipliers = entries.map(({ point, baseline }) =>
        baseline.avgToolLatencyMs === 0 ? 0 : point.avgToolLatencyMs / baseline.avgToolLatencyMs,
      );
      const modelDeltas = models
        .map((model) => {
          const before = byVersionModel.get(`${latest.baseline.appVersionId}::${model}`);
          const after = byVersionModel.get(`${latest.point.appVersionId}::${model}`);
          return before && after ? { model, delta: after.rate - before.rate, before, after } : null;
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
      const ranked = [...modelDeltas].sort((a, b) =>
        meta.kind === 'recovery' ? b.delta - a.delta : a.delta - b.delta,
      );
      const representative = ranked[0] ?? {
        model: models[0] ?? 'unknown',
        before: { runId: '' },
        after: { runId: '' },
        delta: 0,
      };
      const agrees = modelDeltas.filter((entry) =>
        meta.kind === 'regression'
          ? entry.delta < 0
          : meta.kind === 'recovery'
            ? entry.delta > 0
            : Math.abs(entry.delta) < 0.03,
      ).length;
      return {
        id,
        title: meta.title,
        kind: meta.kind as IncidentSummary['kind'],
        tools: meta.tools,
        failureCategory: meta.category,
        occurrences: entries.length,
        evalSuccessRateDelta: round(deltas.reduce((sum, value) => sum + value, 0) / deltas.length),
        productionFailureRateDelta: round(
          productionDeltas.reduce((sum, value) => sum + value, 0) / productionDeltas.length,
        ),
        latencyMultiplier: round(
          latencyMultipliers.reduce((sum, value) => sum + value, 0) / latencyMultipliers.length,
          2,
        ),
        modelAgreement: agrees,
        modelCount: modelDeltas.length,
        baselineVersionId: latest.baseline.appVersionId,
        candidateVersionId: latest.point.appVersionId,
        baselineRunId: representative.before.runId,
        candidateRunId: representative.after.runId,
        model: representative.model,
        summary: meta.summary,
      };
    });
    incidents.sort((a, b) => {
      const rank = { regression: 0, decoy: 1, recovery: 2 } as const;
      return rank[a.kind] - rank[b.kind] || a.evalSuccessRateDelta - b.evalSuccessRateDelta;
    });

    const regressionIncidents = incidents.filter((entry) => entry.kind === 'regression');
    return {
      projectId,
      incidentPatterns: regressionIncidents.length,
      affectedTools: new Set(regressionIncidents.flatMap((entry) => entry.tools)).size,
      evalAttempts: timeline.reduce((sum, entry) => sum + entry.evalAttempts, 0),
      productionSessions: timeline.reduce((sum, entry) => sum + entry.productionSessions, 0),
      timeline,
      incidents,
    };
  });
}
