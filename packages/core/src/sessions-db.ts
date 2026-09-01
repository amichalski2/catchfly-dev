/**
 * Registry for production sessions, mirroring the analysis registry in
 * analysis-db.ts — and separate from `CatchflyDb` for a stronger reason than
 * the analysis file has.
 *
 * The dataset is loaded whole: one fetch, one in-memory index, synchronous
 * reads everywhere downstream. Sessions cannot work that way. A busy app
 * produces more of them than a single response can carry, so they are read a
 * page at a time, behind a `SessionsSource` seam. In the browser that seam is
 * HTTP; in the smoke suite and the seed generator it is the pure functions in
 * session-queries.ts driven over an in-memory array. Both must answer the same
 * thing, which is what makes the pure implementation a specification rather
 * than a test double.
 *
 * Three states, like the analysis registry: *unset* (still wiring up),
 * *configured* and *unavailable*. A deployment without a database serves a
 * dashboard whose eval half works and whose session half honestly says so.
 *
 * React-free; the UI observes it through `subscribeSessions` in
 * apps/web/src/state/useSessions.ts.
 */

import type {
  DeploymentRollup,
  DeploymentComparison,
  Session,
  SessionFilters,
  SessionPage,
  SessionSummary,
  ToolProduction,
} from './session-types.ts';

/** The one seam between "how sessions are read" and "what sessions mean". */
export type SessionsSource = {
  listDeployments(): Promise<DeploymentRollup[]>;
  compareDeployments(baselineDeploymentId: string, candidateDeploymentId: string): Promise<DeploymentComparison>;
  searchSessions(filters: SessionFilters, cursor?: string | null, limit?: number): Promise<SessionPage>;
  getSession(sessionId: string): Promise<Session | null>;
  getToolProduction(toolName: string): Promise<ToolProduction | null>;
};

/** What a caller can observe about one asynchronous read. */
export type Loadable<T> =
  | { status: 'loading' }
  | { status: 'ready'; value: T }
  | { status: 'error'; message: string };

/** A session list accumulates pages, so "load more" appends rather than replaces. */
export type SessionListValue = {
  sessions: SessionSummary[];
  total: number;
  nextCursor: string | null;
  /** True while a further page is in flight — the list stays readable meanwhile. */
  loadingMore: boolean;
};

let source: SessionsSource | null = null;
let settled = false;
let version = 0;

let announceSettled: () => void = () => {};
const settledPromise = new Promise<void>((resolve) => {
  announceSettled = resolve;
});

const listeners = new Set<() => void>();

let deployments: Loadable<DeploymentRollup[]> | null = null;
let lists = new Map<string, Loadable<SessionListValue>>();
let sessionsById = new Map<string, Loadable<Session>>();
let toolProfiles = new Map<string, Loadable<ToolProduction>>();

function changed(): void {
  version += 1;
  for (const listener of listeners) listener();
}

function settle(): void {
  if (settled) return;
  settled = true;
  announceSettled();
}

/** Stable key for a filter set, so two equal filters share one cached list. */
export function filterKey(filters: SessionFilters): string {
  const entries = Object.entries(filters)
    .filter(([, value]) => value !== undefined && value !== '')
    .sort(([a], [b]) => a.localeCompare(b));
  return entries.length === 0 ? '*' : JSON.stringify(entries);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// --- lifecycle ---------------------------------------------------------

export function configureSessionsSource(next: SessionsSource): void {
  source = next;
  settle();
  changed();
}

/** No database, or the session endpoints answered 503: a feature the page does without. */
export function setSessionsUnavailable(): void {
  source = null;
  settle();
  changed();
}

/** Resolves once sessions are either wired up or declared unavailable. Never hangs. */
export function whenSessionsSettled(): Promise<void> {
  return settled ? Promise.resolve() : settledPromise;
}

export function isSessionsAvailable(): boolean {
  return source !== null;
}

/** Drops every cached read. Called when the dashboard points at another project. */
export function resetSessions(): void {
  deployments = null;
  lists = new Map();
  sessionsById = new Map();
  toolProfiles = new Map();
  changed();
}

// --- deployments -------------------------------------------------------

export function getDeployments(): Loadable<DeploymentRollup[]> | null {
  return deployments;
}

export function ensureDeployments(): void {
  if (!source || deployments) return;
  const active = source;
  deployments = { status: 'loading' };
  changed();
  active
    .listDeployments()
    .then((value) => {
      // A reset (or a project switch) while the fetch was in flight wins.
      if (source !== active) return;
      deployments = { status: 'ready', value };
    })
    .catch((error: unknown) => {
      if (source !== active) return;
      deployments = { status: 'error', message: message(error) };
    })
    .finally(() => {
      if (source === active) changed();
    });
}

// --- session lists -----------------------------------------------------

export function getSessionList(filters: SessionFilters): Loadable<SessionListValue> | null {
  return lists.get(filterKey(filters)) ?? null;
}

export function ensureSessionList(filters: SessionFilters, limit?: number): void {
  if (!source) return;
  const key = filterKey(filters);
  if (lists.has(key)) return;

  const active = source;
  lists.set(key, { status: 'loading' });
  changed();
  active
    .searchSessions(filters, null, limit)
    .then((page) => {
      if (source !== active) return;
      lists.set(key, {
        status: 'ready',
        value: { sessions: page.sessions, total: page.total, nextCursor: page.nextCursor, loadingMore: false },
      });
    })
    .catch((error: unknown) => {
      if (source !== active) return;
      lists.set(key, { status: 'error', message: message(error) });
    })
    .finally(() => {
      if (source === active) changed();
    });
}

/** Appends the next page to an already-loaded list. No-op when there is nothing more. */
export function loadMoreSessions(filters: SessionFilters, limit?: number): void {
  if (!source) return;
  const key = filterKey(filters);
  const entry = lists.get(key);
  if (!entry || entry.status !== 'ready' || entry.value.loadingMore || !entry.value.nextCursor) return;

  const active = source;
  const cursor = entry.value.nextCursor;
  lists.set(key, { status: 'ready', value: { ...entry.value, loadingMore: true } });
  changed();
  active
    .searchSessions(filters, cursor, limit)
    .then((page) => {
      if (source !== active) return;
      const current = lists.get(key);
      if (!current || current.status !== 'ready') return;
      // Guard against a page arriving twice: ids already held are not re-added.
      const held = new Set(current.value.sessions.map((session) => session.id));
      const fresh = page.sessions.filter((session) => !held.has(session.id));
      lists.set(key, {
        status: 'ready',
        value: {
          sessions: [...current.value.sessions, ...fresh],
          total: page.total,
          nextCursor: page.nextCursor,
          loadingMore: false,
        },
      });
    })
    .catch(() => {
      if (source !== active) return;
      const current = lists.get(key);
      // A failed "load more" leaves the pages already read on screen.
      if (current?.status === 'ready') {
        lists.set(key, { status: 'ready', value: { ...current.value, loadingMore: false } });
      }
    })
    .finally(() => {
      if (source === active) changed();
    });
}

/** Forgets cached lists so the next read refetches — used after new sessions land. */
export function invalidateSessionLists(): void {
  lists = new Map();
  changed();
}

// --- one session -------------------------------------------------------

export function getSessionEntry(sessionId: string): Loadable<Session> | null {
  return sessionsById.get(sessionId) ?? null;
}

export function ensureSession(sessionId: string): void {
  if (!source || sessionsById.has(sessionId)) return;
  const active = source;
  sessionsById.set(sessionId, { status: 'loading' });
  changed();
  active
    .getSession(sessionId)
    .then((value) => {
      if (source !== active) return;
      if (value) sessionsById.set(sessionId, { status: 'ready', value });
      else sessionsById.set(sessionId, { status: 'error', message: `Unknown session: ${sessionId}` });
    })
    .catch((error: unknown) => {
      if (source !== active) return;
      sessionsById.set(sessionId, { status: 'error', message: message(error) });
    })
    .finally(() => {
      if (source === active) changed();
    });
}

// --- tool profiles -----------------------------------------------------

export function getToolProductionEntry(toolName: string): Loadable<ToolProduction> | null {
  return toolProfiles.get(toolName) ?? null;
}

export function ensureToolProduction(toolName: string): void {
  if (!source || toolProfiles.has(toolName)) return;
  const active = source;
  toolProfiles.set(toolName, { status: 'loading' });
  changed();
  active
    .getToolProduction(toolName)
    .then((value) => {
      if (source !== active) return;
      // A tool nobody called in production is a real answer, not a missing one.
      toolProfiles.set(toolName, {
        status: 'ready',
        value: value ?? {
          toolName,
          calls: 0,
          errorCalls: 0,
          successRate: 0,
          p50DurationMs: 0,
          p95DurationMs: 0,
          errorTypes: [],
          byDeployment: [],
        },
      });
    })
    .catch((error: unknown) => {
      if (source !== active) return;
      toolProfiles.set(toolName, { status: 'error', message: message(error) });
    })
    .finally(() => {
      if (source === active) changed();
    });
}

// --- direct reads for tools --------------------------------------------
//
// WebMCP tools do not render, so they await an answer instead of observing a
// cache. They still go through the same source, so agent and human read one
// implementation.

export function sessionsSource(): SessionsSource {
  if (!source) throw new Error('Session data is unavailable on this deployment');
  return source;
}

// --- change feed for the UI --------------------------------------------

export function subscribeSessions(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Monotonic counter; `useSyncExternalStore` snapshots it to detect changes. */
export function getSessionsVersion(): number {
  return version;
}
