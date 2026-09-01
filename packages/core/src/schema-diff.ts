/**
 * Tool schema history and diffing — the eval half of a tool profile.
 *
 * A tool manifest is the contract an app offers agents, and Catchfly's premise
 * is that changing it silently is how agent-facing regressions happen. Diffing
 * two manifests is therefore not a convenience view: it is the evidence that
 * turns "this tool got worse after the deploy" into "this is the sentence that
 * changed".
 *
 * Pure, and driven by the same `CatchflyDb` the rest of the query layer reads.
 */

import type { CatchflyDb } from './db.ts';
import { deepEqual } from './matchers.ts';
import { expectedToolNames, filterCases } from './queries.ts';
import type { ToolEvalProfile, ToolSchemaDiff } from './session-types.ts';
import type { ToolSchema } from './types.ts';

/** Argument names declared by a JSON Schema, or none when the tool takes no input. */
function propertiesOf(schema: ToolSchema | null): Record<string, unknown> {
  if (!schema?.inputSchema) return {};
  const properties = schema.inputSchema.properties;
  return properties && typeof properties === 'object' ? (properties as Record<string, unknown>) : {};
}

/**
 * What changed about one tool between two manifests.
 *
 * A tool that appeared or disappeared is expressed as a diff against `null`:
 * every argument added, or every argument removed. That keeps the caller from
 * needing a separate "added/removed tool" branch.
 */
export function diffToolSchema(before: ToolSchema | null, after: ToolSchema | null): ToolSchemaDiff {
  const beforeProps = propertiesOf(before);
  const afterProps = propertiesOf(after);
  const beforeNames = Object.keys(beforeProps);
  const afterNames = Object.keys(afterProps);

  const changedProps = beforeNames
    .filter((name) => name in afterProps)
    .filter((name) => !deepEqual(beforeProps[name], afterProps[name]))
    .sort();

  const descriptionChanged = (before?.description ?? '') !== (after?.description ?? '');

  return {
    descriptionChanged,
    ...(before === null ? {} : { before: before.description }),
    ...(after === null ? {} : { after: after.description }),
    addedProps: afterNames.filter((name) => !(name in beforeProps)).sort(),
    removedProps: beforeNames.filter((name) => !(name in afterProps)).sort(),
    changedProps,
  };
}

/** True when the two manifests describe the tool identically. */
export function schemaUnchanged(diff: ToolSchemaDiff): boolean {
  return (
    !diff.descriptionChanged &&
    diff.addedProps.length === 0 &&
    diff.removedProps.length === 0 &&
    diff.changedProps.length === 0
  );
}

/**
 * Schema history plus eval scores for one tool.
 *
 * Cases are selected by what they *expect*, not by what the model actually
 * called: a regression where the model stops reaching for the tool would
 * disappear from an actual-calls filter exactly when it matters most.
 */
export function toolEvalProfile(db: CatchflyDb, toolName: string): ToolEvalProfile {
  const versions = db.dataset.project.appVersions;

  const schemaByVersion = versions.map((version) => ({
    appVersionId: version.id,
    label: version.label,
    schema: version.toolManifest.find((tool) => tool.name === toolName) ?? null,
  }));

  const schemaDiffs = schemaByVersion.slice(1).map((entry, index) => ({
    fromVersionId: schemaByVersion[index].appVersionId,
    toVersionId: entry.appVersionId,
    diff: diffToolSchema(schemaByVersion[index].schema, entry.schema),
  }));

  const caseIds = db.dataset.cases
    .filter((evalCase) => expectedToolNames(evalCase).includes(toolName))
    .map((evalCase) => evalCase.caseId);

  const passRateByVersion = versions.map((version) => {
    const rows = caseIds.length === 0 ? [] : filterCases(db, { appVersionId: version.id, caseIds });
    let passes = 0;
    let attempts = 0;
    for (const row of rows) {
      passes += row.passes;
      attempts += row.repeats;
    }
    return { appVersionId: version.id, passes, attempts };
  });

  return { toolName, schemaByVersion, schemaDiffs, caseIds, passRateByVersion };
}

/** Every tool name any manifest in the project has ever declared, sorted. */
export function knownToolNames(db: CatchflyDb): string[] {
  const names = new Set<string>();
  for (const version of db.dataset.project.appVersions) {
    for (const tool of version.toolManifest) names.add(tool.name);
  }
  return [...names].sort();
}
