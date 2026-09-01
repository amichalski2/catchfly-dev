/**
 * Keeps the shared state addressable.
 *
 * The whole premise is that a human continues from the state an agent produced;
 * a URL makes that state survive a reload and become something you can send to
 * a colleague. The hash is a projection of the store, never a second source of
 * truth: the store stays authoritative and the hash follows it.
 *
 *   #/overview            #/cases/case-013
 *   #/sessions/s-0142     #/tools/score_submission
 *   #/p/catchfly/overview — the same, in a non-default project
 */

import { activateProject, defaultProjectId, projectInfo } from '../data/projects.ts';
import { catchflyStore, type ViewName } from './store.ts';

const VIEWS: ViewName[] = [
  'overview',
  'releases',
  'regressions',
  'cases',
  'case-detail',
  'sessions',
  'sources',
  'settings',
  'system',
  'profile',
  'session-detail',
  'tool-profile',
];

/** What a detail view puts in the URL, and how to read it back. */
type Selection = {
  selectedCaseId: string | null;
  selectedSessionId: string | null;
  selectedToolName: string | null;
};

function hashFor(view: ViewName, selection: Selection, projectId: string): string {
  const prefix = projectId && projectId !== defaultProjectId() ? `p/${projectId}/` : '';
  if (view === 'case-detail' && selection.selectedCaseId) {
    return `#/${prefix}cases/${selection.selectedCaseId}`;
  }
  if (view === 'session-detail' && selection.selectedSessionId) {
    return `#/${prefix}sessions/${selection.selectedSessionId}`;
  }
  if (view === 'tool-profile' && selection.selectedToolName) {
    // Tool names are identifiers, but encoding costs nothing and a name with a
    // slash in it would otherwise silently break the route.
    return `#/${prefix}tools/${encodeURIComponent(selection.selectedToolName)}`;
  }
  return `#/${prefix}${view}`;
}

/**
 * The hash as it was when the page opened.
 *
 * Boot is asynchronous, and the moment the store gains a project the subscriber
 * below starts mirroring state into the URL — which would overwrite the very
 * link the visitor followed before it had been read. So the incoming hash is
 * captured once, up front, and everything reads from that.
 */
let entryHash: string | null = null;

function parts(): string[] {
  return (entryHash ?? window.location.hash).replace(/^#\//, '').split('/');
}

/** The project a `#/p/<id>/...` hash names, if any. */
export function projectFromHash(): string | null {
  const segments = parts();
  return segments[0] === 'p' && segments[1] ? segments[1] : null;
}

/** Applies the current hash to the store. Unknown hashes are left alone. */
function readHash(): void {
  const segments = parts();
  const named = projectFromHash();
  const projectId = named && projectInfo(named) ? named : defaultProjectId();
  const [section, identifier] = named ? segments.slice(2) : segments;

  const apply = (): void => {
    const store = catchflyStore.getState();
    if (section === 'cases' && identifier) {
      if (store.selectedCaseId !== identifier) store.openCase(identifier, 'human');
      return;
    }
    if (section === 'sessions' && identifier) {
      if (store.selectedSessionId !== identifier) store.openSession(identifier, 'human');
      return;
    }
    if (section === 'tools' && identifier) {
      const toolName = decodeURIComponent(identifier);
      if (store.selectedToolName !== toolName) store.openTool(toolName, 'human');
      return;
    }
    const view = VIEWS.find((candidate) => candidate === section);
    if (view && view !== store.view) store.setView(view, 'human');
  };

  // Before boot the store has no project yet; boot reads the hash itself.
  // With no project resolvable at all (an empty deployment, or the registry not
  // fetched yet) there is nothing to switch to — but the view segment is still
  // worth applying, so fall through rather than returning.
  const current = catchflyStore.getState().projectId;
  if (projectId && current && current !== projectId) {
    void activateProject(projectId, 'human')
      .then(apply)
      .catch((error: unknown) => {
        // A hash naming an unloadable project must not leave the app silently
        // showing the previous one; keep the URL honest about where we are.
        console.error(`Could not switch to project "${projectId}":`, error);
        const store = catchflyStore.getState();
        window.history.replaceState(null, '', hashFor(store.view, store, store.projectId));
      });
    return;
  }
  apply();
}

export function startUrlSync(): void {
  entryHash = window.location.hash;
}

/**
 * Applies the entry hash now that the data it names exists, then starts
 * mirroring the store back into the URL.
 *
 * Both halves have to wait for boot: a case id can only be resolved against a
 * loaded dataset, and mirroring earlier would clobber the incoming link.
 */
export function applyHash(): void {
  readHash();
  entryHash = null;

  window.addEventListener('hashchange', readHash);

  catchflyStore.subscribe((state, previous) => {
    if (
      state.view === previous.view &&
      state.selectedCaseId === previous.selectedCaseId &&
      state.selectedSessionId === previous.selectedSessionId &&
      state.selectedToolName === previous.selectedToolName &&
      state.projectId === previous.projectId
    )
      return;
    const next = hashFor(state.view, state, state.projectId);
    // replaceState keeps the back button meaning "the previous page", not
    // "undo the agent's last click".
    if (window.location.hash !== next) {
      window.history.replaceState(null, '', next);
    }
  });
}
