/**
 * The datasets Catchfly can point at.
 *
 * A registry rather than a constant: projects live in the database now, so the
 * list arrives at boot and grows whenever someone creates one. Everything that
 * reads it — the project switcher in the shell, the URL sync, the `list_projects`
 * and `switch_project` tools — keeps the same synchronous shape it always had,
 * because those callers run after boot and should not each learn to await.
 */

import type { ActionSource } from '../state/store.ts';
import type { ProjectDataOrigin } from '@catchfly/core/types.ts';

export type ProjectInfo = {
  id: string;
  name: string;
  description: string;
  /** How many eval runs the project holds; 0 means "nothing imported yet". */
  runCount?: number;
  dataOrigin?: ProjectDataOrigin;
};

let projects: ProjectInfo[] = [];

/** Replaces the registry. Called once at boot, and again after a project is created. */
export function setProjects(next: ProjectInfo[]): void {
  projects = next;
}

export function listProjectInfo(): ProjectInfo[] {
  return projects;
}

export function projectInfo(id: string): ProjectInfo | undefined {
  return projects.find((project) => project.id === id);
}

/**
 * The project to open when the URL names none.
 *
 * Whatever the server listed first — it orders by creation, so the oldest
 * project is the one a returning visitor expects to land on.
 */
export function defaultProjectId(): string | null {
  return projects[0]?.id ?? null;
}

/**
 * Switching a project needs the browser loader, which fetches over HTTP and
 * resets the shared store. Rather than have the WebMCP layer reach for that
 * module (and drag it into every node-side consumer's type-check), the loader
 * registers itself here at boot and the tools call through.
 */
type ProjectSwitcher = (projectId: string, source: ActionSource) => Promise<void>;

let switcher: ProjectSwitcher | null = null;

export function registerProjectSwitcher(fn: ProjectSwitcher): void {
  switcher = fn;
}

export async function activateProject(projectId: string, source: ActionSource): Promise<void> {
  if (!switcher) throw new Error('Project switching is not available outside the browser.');
  if (!projectInfo(projectId)) {
    throw new Error(`Unknown project "${projectId}" — call list_projects for the ids.`);
  }
  return switcher(projectId, source);
}
