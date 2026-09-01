/**
 * The HTTP client for Catchfly's own API.
 *
 * Thin on purpose: the server returns the dataset in exactly the shape
 * `createDb()` expects, so there is no mapping layer here to drift out of sync
 * with the one on the server.
 */

import type {
  DeploymentRollup,
  DeploymentComparison,
  Session,
  SessionFilters,
  SessionPage,
  ToolProduction,
} from '@catchfly/core/session-types.ts';
import type {
  CatchflyDataset,
  EvalBootstrap,
  EvalCase,
  EvalCasePage,
  IncidentOverview,
  EvalResultPage,
  EvalRunPage,
} from '@catchfly/core/types.ts';
import type {
  ApiKeyScope,
  DataPolicy,
  EnvironmentKind,
  ProjectApiKey,
  ProjectEnvironment,
  SourceHealth,
  TelemetryEvent,
  ProjectOperationalOverview,
  IncidentRecord,
  OperationalFinding,
} from '@catchfly/core/product-types.ts';

import { accessToken } from './supabase.ts';

import type { ProjectInfo } from './projects.ts';

const ADMIN_KEY_STORAGE = 'catchfly.adminKey';
const EVAL_KEY_STORAGE = 'catchfly.evalKey';

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await accessToken();
  const headers = new Headers(init.headers);
  if (token && !headers.has('authorization')) headers.set('authorization', `Bearer ${token}`);
  return fetch(path, { ...init, headers });
}

function projectWriteHeaders(adminKey?: string, json = false): Record<string, string> {
  return {
    ...(json ? { 'content-type': 'application/json' } : {}),
    ...(adminKey ? { 'x-catchfly-key': adminKey } : {}),
  };
}

async function failure(response: Response): Promise<ApiError> {
  let message = `${response.status} ${response.statusText}`;
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === 'string') message = body.error;
  } catch {
    // A non-JSON error body is still an error; the status line will do.
  }
  return new ApiError(message, response.status);
}

export type Account = {
  user: { id: string; email: string };
  orgs: Array<{ id: string; name: string; role: string }>;
  projects: ProjectInfo[];
};

export type ProvisionedWorkspace = {
  org: { id: string; name: string; role: string };
  project: ProjectInfo;
  environmentId: string;
  ingestKey?: { id: string; prefix: string; scopes: string[]; secret: string };
  created: boolean;
};

export async function fetchAccount(): Promise<Account> {
  const response = await request('/api/me');
  if (!response.ok) throw await failure(response);
  return (await response.json()) as Account;
}

export async function provisionWorkspace(input: { allowedOrigins?: string[] } = {}): Promise<ProvisionedWorkspace> {
  const response = await request('/api/me/provision', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw await failure(response);
  return (await response.json()) as ProvisionedWorkspace;
}

export async function renameOrg(orgId: string, name: string): Promise<void> {
  const response = await request(`/api/orgs/${encodeURIComponent(orgId)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!response.ok) throw await failure(response);
}

export async function fetchProjects(): Promise<ProjectInfo[]> {
  const response = await request('/api/projects');
  if (!response.ok) throw await failure(response);
  const body = (await response.json()) as { projects: ProjectInfo[] };
  return body.projects;
}

export async function createProject(input: {
  id: string;
  name: string;
  description?: string;
  adminKey?: string;
}): Promise<ProjectInfo> {
  const response = await request('/api/projects', {
    method: 'POST',
    headers: projectWriteHeaders(input.adminKey, true),
    body: JSON.stringify({ id: input.id, name: input.name, description: input.description ?? '' }),
  });
  if (!response.ok) throw await failure(response);
  return ((await response.json()) as { project: ProjectInfo }).project;
}

export async function fetchEnvironments(projectId: string): Promise<ProjectEnvironment[]> {
  const response = await request(`${projectPath(projectId)}/environments`);
  if (!response.ok) throw await failure(response);
  return ((await response.json()) as { environments: ProjectEnvironment[] }).environments;
}

export async function createEnvironment(input: {
  projectId: string;
  id: string;
  name: string;
  kind: EnvironmentKind;
  adminKey?: string;
}): Promise<ProjectEnvironment> {
  const response = await request(`${projectPath(input.projectId)}/environments`, {
    method: 'POST',
    headers: projectWriteHeaders(input.adminKey, true),
    body: JSON.stringify({ id: input.id, name: input.name, kind: input.kind }),
  });
  if (!response.ok) throw await failure(response);
  return ((await response.json()) as { environment: ProjectEnvironment }).environment;
}

export async function fetchProjectKeys(projectId: string, adminKey?: string): Promise<ProjectApiKey[]> {
  const response = await request(`${projectPath(projectId)}/keys`, { headers: projectWriteHeaders(adminKey) });
  if (!response.ok) throw await failure(response);
  return ((await response.json()) as { keys: ProjectApiKey[] }).keys;
}

export async function createProjectKey(input: {
  projectId: string;
  environmentId: string;
  name: string;
  scopes: ApiKeyScope[];
  adminKey?: string;
  allowedOrigins?: string[];
}): Promise<{ key: ProjectApiKey; secret: string }> {
  const response = await request(`${projectPath(input.projectId)}/keys`, {
    method: 'POST',
    headers: projectWriteHeaders(input.adminKey, true),
    body: JSON.stringify({
      environmentId: input.environmentId,
      name: input.name,
      scopes: input.scopes,
      ...(input.allowedOrigins ? { allowedOrigins: input.allowedOrigins } : {}),
    }),
  });
  if (!response.ok) throw await failure(response);
  return (await response.json()) as { key: ProjectApiKey; secret: string };
}

export async function revokeProjectKey(projectId: string, keyId: string, adminKey?: string): Promise<void> {
  const response = await request(`${projectPath(projectId)}/keys/${encodeURIComponent(keyId)}`, {
    method: 'DELETE',
    headers: projectWriteHeaders(adminKey),
  });
  if (!response.ok) throw await failure(response);
}

export async function fetchDataPolicy(projectId: string, environmentId: string): Promise<DataPolicy> {
  const response = await request(`${projectPath(projectId)}/environments/${encodeURIComponent(environmentId)}/policy`);
  if (!response.ok) throw await failure(response);
  return ((await response.json()) as { policy: DataPolicy }).policy;
}

export async function saveDataPolicy(input: {
  projectId: string;
  environmentId: string;
  policy: Pick<DataPolicy, 'redactionRules' | 'samplingRate' | 'retentionDays'>;
  adminKey?: string;
}): Promise<DataPolicy> {
  const response = await request(`${projectPath(input.projectId)}/environments/${encodeURIComponent(input.environmentId)}/policy`, {
    method: 'PUT',
    headers: projectWriteHeaders(input.adminKey, true),
    body: JSON.stringify(input.policy),
  });
  if (!response.ok) throw await failure(response);
  return ((await response.json()) as { policy: DataPolicy }).policy;
}

export async function fetchSourceHealth(projectId: string): Promise<SourceHealth> {
  const response = await request(`${projectPath(projectId)}/sources`);
  if (!response.ok) throw await failure(response);
  return ((await response.json()) as { sources: SourceHealth }).sources;
}

export async function fetchProjectOverview(projectId: string): Promise<ProjectOperationalOverview> {
  const response = await request(`${projectPath(projectId)}/overview`);
  if (!response.ok) throw await failure(response);
  return ((await response.json()) as { overview: ProjectOperationalOverview }).overview;
}

export async function fetchIncidents(projectId: string): Promise<IncidentRecord[]> {
  const response = await request(`${projectPath(projectId)}/incidents`);
  if (!response.ok) throw await failure(response);
  return ((await response.json()) as { incidents: IncidentRecord[] }).incidents;
}

export async function createIncident(input: {
  projectId: string; finding: OperationalFinding; adminKey?: string;
}): Promise<IncidentRecord> {
  const response = await request(`${projectPath(input.projectId)}/incidents`, {
    method: 'POST', headers: projectWriteHeaders(input.adminKey, true),
    body: JSON.stringify({
      findingId: input.finding.id, title: input.finding.title, severity: input.finding.severity,
      evidence: { kind: input.finding.kind, summary: input.finding.summary, value: input.finding.value, sampleSize: input.finding.sampleSize },
    }),
  });
  if (!response.ok) throw await failure(response);
  return ((await response.json()) as { incident: IncidentRecord }).incident;
}

export async function updateIncident(input: {
  projectId: string;
  incidentId: string;
  status: IncidentRecord['status'];
  adminKey?: string;
  resolution?: string;
}): Promise<IncidentRecord> {
  const response = await request(`${projectPath(input.projectId)}/incidents/${encodeURIComponent(input.incidentId)}`, {
    method: 'PATCH',
    headers: projectWriteHeaders(input.adminKey, true),
    body: JSON.stringify({ status: input.status, ...(input.resolution ? { resolution: input.resolution } : {}) }),
  });
  if (!response.ok) throw await failure(response);
  return ((await response.json()) as { incident: IncidentRecord }).incident;
}

export async function sendTelemetry(input: {
  projectId: string;
  environmentId: string;
  key: string;
  events: TelemetryEvent[];
}): Promise<{ accepted: number; duplicates: number; sampledOut: number }> {
  const response = await request(`/api/v1/projects/${encodeURIComponent(input.projectId)}/events`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${input.key}`,
      'content-type': 'application/json',
      'idempotency-key': crypto.randomUUID(),
    },
    body: JSON.stringify({ environmentId: input.environmentId, events: input.events }),
  });
  if (!response.ok) throw await failure(response);
  return (await response.json()) as { accepted: number; duplicates: number; sampledOut: number };
}

export async function fetchSystemStatus(adminKey: string): Promise<{
  status: string;
  database: { bytes: number; latestMigration: string | null };
  counts: { projects: number; sessions: number; events: number; rejectedEvents: number };
  runtime: { node: string; version: string };
}> {
  const response = await request('/api/system', { headers: { 'x-catchfly-key': adminKey } });
  if (!response.ok) throw await failure(response);
  return await response.json() as {
    status: string;
    database: { bytes: number; latestMigration: string | null };
    counts: { projects: number; sessions: number; events: number; rejectedEvents: number };
    runtime: { node: string; version: string };
  };
}

export async function fetchDataset(projectId: string): Promise<CatchflyDataset> {
  const response = await request(`/api/projects/${encodeURIComponent(projectId)}/dataset`);
  if (!response.ok) throw await failure(response);
  return (await response.json()) as CatchflyDataset;
}

export async function fetchEvalBootstrap(projectId: string): Promise<EvalBootstrap> {
  const response = await request(`/api/projects/${encodeURIComponent(projectId)}/bootstrap`);
  if (!response.ok) throw await failure(response);
  const body = (await response.json()) as { bootstrap: EvalBootstrap };
  return body.bootstrap;
}

export async function fetchIncidentOverview(projectId: string): Promise<IncidentOverview> {
  const response = await request(`/api/projects/${encodeURIComponent(projectId)}/incident-overview`);
  if (!response.ok) throw await failure(response);
  const body = (await response.json()) as { overview: IncidentOverview };
  return body.overview;
}

export async function fetchEvalRunsPage(
  projectId: string,
  cursor?: string | null,
  limit = 100,
): Promise<EvalRunPage> {
  const query = new URLSearchParams({ limit: String(limit) });
  if (cursor) query.set('cursor', cursor);
  const response = await request(`${projectPath(projectId)}/eval-runs?${query}`);
  if (!response.ok) throw await failure(response);
  return (await response.json()) as EvalRunPage;
}

export async function fetchEvalCasesPage(
  projectId: string,
  cursor?: string | null,
  limit = 100,
): Promise<EvalCasePage> {
  const query = new URLSearchParams({ limit: String(limit) });
  if (cursor) query.set('cursor', cursor);
  const response = await request(`${projectPath(projectId)}/eval-cases?${query}`);
  if (!response.ok) throw await failure(response);
  return (await response.json()) as EvalCasePage;
}

export async function fetchEvalResultsPage(
  projectId: string,
  runId: string,
  cursor?: string | null,
  limit = 100,
): Promise<EvalResultPage> {
  const query = new URLSearchParams({ limit: String(limit) });
  if (cursor) query.set('cursor', cursor);
  const response = await request(`${projectPath(projectId)}/eval-runs/${encodeURIComponent(runId)}/results?${query}`);
  if (!response.ok) throw await failure(response);
  return (await response.json()) as EvalResultPage;
}

// --- sessions ----------------------------------------------------------

const projectPath = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}`;

export async function fetchDeployments(projectId: string): Promise<DeploymentRollup[]> {
  const response = await request(`${projectPath(projectId)}/deployments`);
  if (!response.ok) throw await failure(response);
  const body = (await response.json()) as { deployments: DeploymentRollup[] };
  return body.deployments;
}

export async function fetchDeploymentComparison(
  projectId: string,
  baselineDeploymentId: string,
  candidateDeploymentId: string,
): Promise<DeploymentComparison> {
  const query = new URLSearchParams({ baselineDeploymentId, candidateDeploymentId });
  const response = await request(`${projectPath(projectId)}/deployment-comparison?${query}`);
  if (!response.ok) throw await failure(response);
  const body = (await response.json()) as { comparison: DeploymentComparison };
  return body.comparison;
}

export async function fetchSessions(
  projectId: string,
  filters: SessionFilters,
  cursor?: string | null,
  limit?: number,
): Promise<SessionPage> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== '') query.set(key, String(value));
  }
  if (cursor) query.set('cursor', cursor);
  if (limit !== undefined) query.set('limit', String(limit));

  const response = await request(`${projectPath(projectId)}/sessions?${query.toString()}`);
  if (!response.ok) throw await failure(response);
  return (await response.json()) as SessionPage;
}

export async function fetchSession(projectId: string, sessionId: string): Promise<Session | null> {
  const response = await request(`${projectPath(projectId)}/sessions/${encodeURIComponent(sessionId)}`);
  // A session that is not there is an answer, not a failure.
  if (response.status === 404) return null;
  if (!response.ok) throw await failure(response);
  const body = (await response.json()) as { session: Session };
  return body.session;
}

export async function fetchToolProduction(projectId: string, toolName: string): Promise<ToolProduction | null> {
  const response = await request(`${projectPath(projectId)}/tools/${encodeURIComponent(toolName)}/profile`);
  if (response.status === 404) return null;
  if (!response.ok) throw await failure(response);
  const body = (await response.json()) as { production: ToolProduction };
  return body.production;
}

/** Writes one eval case — the production-failure-becomes-a-test path. */
export async function createCase(input: {
  projectId: string;
  evalCase: EvalCase;
  key: string;
  overwrite?: boolean;
}): Promise<EvalCase> {
  const response = await request(`${projectPath(input.projectId)}/cases`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-catchfly-key': input.key },
    body: JSON.stringify({ case: input.evalCase, overwrite: input.overwrite ?? false }),
  });
  if (!response.ok) throw await failure(response);
  const body = (await response.json()) as { case: EvalCase };
  return body.case;
}

function readStored(storageKey: string): string {
  try {
    return localStorage.getItem(storageKey) ?? '';
  } catch {
    // Private windows and blocked site data throw rather than return null.
    return '';
  }
}

function store(storageKey: string, key: string): void {
  try {
    if (key) localStorage.setItem(storageKey, key);
    else localStorage.removeItem(storageKey);
  } catch {
    // Not being able to remember the key costs a retype, nothing more.
  }
}

export const readStoredAdminKey = (): string => readStored(ADMIN_KEY_STORAGE);
export const readStoredEvalKey = (): string => readStored(EVAL_KEY_STORAGE);
export const storeAdminKey = (key: string): void => store(ADMIN_KEY_STORAGE, key);
export const storeEvalKey = (key: string): void => store(EVAL_KEY_STORAGE, key);
