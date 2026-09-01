/**
 * Folds an imported run into the active dataset.
 *
 * Imports are additive and non-destructive: an existing run with the same id is
 * replaced, case definitions are merged by id, and the app version is created
 * on first sight. Nothing already loaded is dropped, so a Chrome report can be
 * compared against the demo data or against an earlier import.
 */

import type { CatchflyDataset, EvalCase, EvalRun, ToolSchema } from '@catchfly/core/types.ts';

export type MergeInput = {
  run: EvalRun;
  cases: EvalCase[];
  toolManifest: ToolSchema[];
  /** Label for a version the dataset has not seen before. */
  appVersionLabel: string;
};

export function mergeRun(dataset: CatchflyDataset, input: MergeInput): CatchflyDataset {
  const { run, cases, toolManifest, appVersionLabel } = input;

  const versionExists = dataset.project.appVersions.some(
    (version) => version.id === run.appVersionId,
  );

  const appVersions = versionExists
    ? dataset.project.appVersions.map((version) =>
        // Only fill in a manifest we did not have; never overwrite a known one.
        version.id === run.appVersionId && version.toolManifest.length === 0
          ? { ...version, toolManifest }
          : version,
      )
    : [
        ...dataset.project.appVersions,
        {
          id: run.appVersionId,
          label: appVersionLabel,
          releasedAt: run.timestamp,
          note: 'Imported from a Chrome WebMCP Evals report.',
          toolManifest,
        },
      ];

  const caseById = new Map(dataset.cases.map((evalCase) => [evalCase.caseId, evalCase]));
  for (const evalCase of cases) {
    if (!caseById.has(evalCase.caseId)) caseById.set(evalCase.caseId, evalCase);
  }

  const runs = dataset.runs.some((existing) => existing.id === run.id)
    ? dataset.runs.map((existing) => (existing.id === run.id ? run : existing))
    : [...dataset.runs, run];

  return {
    project: { ...dataset.project, appVersions },
    cases: [...caseById.values()],
    runs,
  };
}

/** A run id that stays stable for the same file imported twice. */
export function runIdFor(appVersionId: string, model: string): string {
  const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `run-${slug(appVersionId)}-${slug(model)}`;
}
