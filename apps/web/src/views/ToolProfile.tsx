/**
 * Tool profile — one tool, in production and in the eval suite.
 *
 * The screen is arranged as an argument. The hero and the tiles say how the
 * tool is doing; the columns say when that changed; the schema history says
 * what changed at that moment. A reviewer who arrives here from a failing
 * session should be able to leave with the sentence that broke it.
 *
 * The schema panel is the payload. Everything else is available elsewhere in
 * some form — this is the only place a description that quietly got vaguer
 * becomes visible.
 */

import { getDb } from '@catchfly/core/db.ts';
import { CATEGORY_LABELS, formatCount } from '@catchfly/core/labels.ts';
import { filterCases, groupResults } from '@catchfly/core/queries.ts';
import { toolEvalProfile } from '@catchfly/core/schema-diff.ts';

import { BarList } from '../components/BarList.tsx';
import { SchemaDiff } from '../components/SchemaDiff.tsx';
import { HeroFigure, StatTile } from '../components/figures.tsx';
import { VersionColumns } from '../components/VersionColumns.tsx';
import { useCatchflyStore } from '../state/store.ts';
import { useAgentTouch } from '../state/useAgentTouch.ts';
import { useDeployments, useToolProduction } from '../state/useSessions.ts';

const TOOL_ACTIONS = ['open_tool'] as const;

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;

export function ToolProfile() {
  const toolName = useCatchflyStore((state) => state.selectedToolName);
  const closeTool = useCatchflyStore((state) => state.closeTool);
  const openCase = useCatchflyStore((state) => state.openCase);
  const setSessionFilters = useCatchflyStore((state) => state.setSessionFilters);
  const touch = useAgentTouch(TOOL_ACTIONS);
  const production = useToolProduction(toolName);
  const deployments = useDeployments();

  if (!toolName) return <p className="muted">No tool selected.</p>;

  const db = getDb();
  const evalSide = toolEvalProfile(db, toolName);
  const measured = production?.status === 'ready' ? production.value : null;
  const rollups = deployments?.status === 'ready' ? deployments.value : [];

  // Eval-side failure mix for cases that name this tool.
  const rows = evalSide.caseIds.length > 0 ? filterCases(db, { caseIds: evalSide.caseIds }) : [];
  const categories = groupResults(rows, 'category')
    .filter((group) => group.key !== 'passing')
    .map((group) => ({
      key: group.key,
      label: CATEGORY_LABELS[group.key as keyof typeof CATEGORY_LABELS] ?? group.key,
      value: group.cases,
    }));

  const errorTypes = (measured?.errorTypes ?? []).map((entry) => ({
    key: entry.errorType,
    label: entry.errorType,
    value: entry.count,
  }));

  // One facet, one column per deployment: this is where a release-shaped drop
  // becomes visible as a step rather than as an average.
  const facets =
    measured && measured.byDeployment.length > 0
      ? [
          {
            model: 'Execution success in production',
            columns: measured.byDeployment.map((entry) => ({
              runId: entry.deploymentId,
              version: `${entry.deploymentId} · ${entry.appVersionId}`,
              value: entry.successRate,
              detail: `${entry.calls - entry.errorCalls} of ${entry.calls} calls succeeded`,
            })),
          },
        ]
      : [];

  const worstDeployment = measured?.byDeployment.reduce(
    (worst, entry) => (worst === null || entry.successRate < worst.successRate ? entry : worst),
    null as (typeof measured.byDeployment)[number] | null,
  );

  return (
    <div className="stack">
      <section key={touch.key} className={`panel panel-hero${touch.className}`}>
        <div className="panel-head">
          <div>
            <h2>
              <code>{toolName}</code>
            </h2>
            <p className="muted">How this tool behaves in production, and what its schema has said over time.</p>
          </div>
          <button type="button" className="btn" onClick={() => closeTool('human')}>
            Back to sessions
          </button>
        </div>
        <div className="panel-body">
          <HeroFigure
            value={measured && measured.calls > 0 ? pct(measured.successRate) : '—'}
            label="Execution success in production"
            tone={measured && measured.successRate < 0.95 ? 'regressed' : 'neutral'}
            caption={
              measured && measured.calls > 0
                ? `${formatCount(measured.calls)} calls across ${measured.byDeployment.length} deployments`
                : 'No production traffic has called this tool.'
            }
          />
          <div className="tiles">
            <StatTile
              label="Calls"
              value={measured ? formatCount(measured.calls) : null}
              unmeasuredNote="No session data on this deployment."
            />
            <StatTile
              label="Rejected"
              value={measured ? formatCount(measured.errorCalls) : null}
              unmeasuredNote="No session data on this deployment."
            />
            <StatTile
              label="p50"
              value={measured && measured.calls > 0 ? `${Math.round(measured.p50DurationMs)}ms` : null}
              unmeasuredNote="Nothing has called it."
            />
            <StatTile
              label="p95"
              value={measured && measured.calls > 0 ? `${Math.round(measured.p95DurationMs)}ms` : null}
              unmeasuredNote="Nothing has called it."
            />
          </div>
        </div>
      </section>

      {facets.length > 0 ? (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Across deployments</h2>
              <p className="muted">
                Execution success per release. A step rather than a slope means something shipped.
              </p>
            </div>
          </div>
          <div className="panel-body">
            <VersionColumns
              facets={facets}
              emphasisRunId={worstDeployment?.deploymentId}
              onSelect={(deploymentId) =>
                setSessionFilters({ deploymentId, toolCalled: toolName }, 'human')
              }
            />
          </div>
        </section>
      ) : null}

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Tool schema history</h2>
            <p className="muted">What the app told agents about this tool, version by version.</p>
          </div>
        </div>
        <div className="panel-body">
          <table className="table table-dense">
            <thead>
              <tr>
                <th scope="col">Version</th>
                <th scope="col">Description</th>
                <th scope="col">Arguments</th>
              </tr>
            </thead>
            <tbody>
              {evalSide.schemaByVersion.map((entry) => (
                <tr key={entry.appVersionId}>
                  <th scope="row">{entry.label}</th>
                  <td>{entry.schema ? entry.schema.description : <span className="muted">not declared</span>}</td>
                  <td className="col-tools">
                    {entry.schema?.inputSchema
                      ? Object.keys(
                          (entry.schema.inputSchema.properties as Record<string, unknown>) ?? {},
                        ).map((prop) => (
                          <span key={prop} className="chip">
                            {prop}
                          </span>
                        ))
                      : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {evalSide.schemaDiffs.map((entry) => (
            <div key={`${entry.fromVersionId}-${entry.toVersionId}`} className="schema-step">
              <span className="eyebrow">
                {entry.fromVersionId} → {entry.toVersionId}
              </span>
              <SchemaDiff diff={entry.diff} />
            </div>
          ))}
        </div>
      </section>

      <div className="split">
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Why calls were rejected</h2>
              <p className="muted">Production errors, by type.</p>
            </div>
          </div>
          <div className="panel-body">
            <BarList
              data={errorTypes}
              emptyLabel="No call to this tool has been rejected."
              onSelect={() => setSessionFilters({ toolCalled: toolName, outcome: 'any-failure' }, 'human')}
            />
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>In the eval suite</h2>
              <p className="muted">
                {evalSide.caseIds.length === 0
                  ? 'No eval case expects this tool yet.'
                  : `${evalSide.caseIds.length} case${evalSide.caseIds.length === 1 ? '' : 's'} expect it.`}
              </p>
            </div>
          </div>
          <div className="panel-body">
            <BarList data={categories} emptyLabel="No failures recorded against these cases." />
            {evalSide.caseIds.length > 0 ? (
              <p className="table-foot">
                {evalSide.caseIds.slice(0, 8).map((caseId) => (
                  <button
                    key={caseId}
                    type="button"
                    className="chip chip-button"
                    onClick={() => openCase(caseId, 'human')}
                  >
                    {caseId}
                  </button>
                ))}
                {evalSide.caseIds.length > 8 ? <span className="muted"> and {evalSide.caseIds.length - 8} more</span> : null}
              </p>
            ) : null}
          </div>
        </section>
      </div>

      {rollups.length > 0 && measured && measured.calls === 0 ? (
        <p className="table-note muted">
          This tool is declared in the manifest but no session has called it — which is itself worth knowing.
        </p>
      ) : null}
    </div>
  );
}
