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

import type { CaseFilters } from '@catchfly/core/queries.ts';
import type { SessionFilters } from '@catchfly/core/session-types.ts';

import { activateProject, defaultProjectId, projectInfo } from '../data/projects.ts';
import { catchflyStore, type ViewName } from './store.ts';

const CASE_PREFIX = 'f.';
const SESSION_PREFIX = 's.';

function encodeFilters(filters: CaseFilters, sessionFilters: SessionFilters): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined) continue;
    params.set(`${CASE_PREFIX}${key}`, Array.isArray(value) ? value.join(',') : String(value));
  }
  for (const [key, value] of Object.entries(sessionFilters)) {
    if (value === undefined) continue;
    params.set(`${SESSION_PREFIX}${key}`, String(value));
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}

function decodeFilters(query: string): { filters: CaseFilters; sessionFilters: SessionFilters } {
  const params = new URLSearchParams(query);
  const filters: Record<string, unknown> = {};
  const sessionFilters: Record<string, unknown> = {};
  for (const [key, value] of params) {
    if (key.startsWith(CASE_PREFIX)) {
      const name = key.slice(CASE_PREFIX.length);
      filters[name] = name === 'caseIds' ? value.split(',').filter(Boolean) : value;
    } else if (key.startsWith(SESSION_PREFIX)) {
      sessionFilters[key.slice(SESSION_PREFIX.length)] = value;
    }
  }
  return { filters: filters as CaseFilters, sessionFilters: sessionFilters as SessionFilters };
}

const sameFilters = (a: object, b: object): boolean => JSON.stringify(a) === JSON.stringify(b);

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

type Addressable = Selection & { filters: CaseFilters; sessionFilters: SessionFilters };

function hashFor(view: ViewName, selection: Addressable, projectId: string): string {
  const prefix = projectId && projectId !== defaultProjectId() ? `p/${projectId}/` : '';
  const query = encodeFilters(selection.filters, selection.sessionFilters);
  if (view === 'case-detail' && selection.selectedCaseId) {
    return `#/${prefix}cases/${selection.selectedCaseId}${query}`;
  }
  if (view === 'session-detail' && selection.selectedSessionId) {
    return `#/${prefix}sessions/${selection.selectedSessionId}${query}`;
  }
  if (view === 'tool-profile' && selection.selectedToolName) {
    // Tool names are identifiers, but encoding costs nothing and a name with a
    // slash in it would otherwise silently break the route.
    return `#/${prefix}tools/${encodeURIComponent(selection.selectedToolName)}${query}`;
  }
  return `#/${prefix}${view}${query}`;
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

function rawHash(): string {
  return entryHash ?? window.location.hash;
}

function parts(): string[] {
  return rawHash().replace(/^#\//, '').split('?')[0].split('/');
}

function query(): string {
  const index = rawHash().indexOf('?');
  return index === -1 ? '' : rawHash().slice(index + 1);
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

  const wanted = decodeFilters(query());

  const apply = (): void => {
    let store = catchflyStore.getState();
    if (query()) {
      if (!sameFilters(store.sessionFilters, wanted.sessionFilters)) {
        store.setSessionFilters(wanted.sessionFilters, 'human', { reset: true });
        store = catchflyStore.getState();
      }
      if (!sameFilters(store.filters, wanted.filters)) {
        store.setFilters(wanted.filters, 'human', { reset: true });
        store = catchflyStore.getState();
      }
    }
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
      state.filters === previous.filters &&
      state.sessionFilters === previous.sessionFilters &&
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
