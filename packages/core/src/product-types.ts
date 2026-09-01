import type { FailureCategory, ToolSchema, TrajectoryStep } from './types.ts';

export type EnvironmentKind = 'development' | 'staging' | 'production';

export type ProjectEnvironment = {
  id: string;
  projectId: string;
  name: string;
  kind: EnvironmentKind;
  createdAt: string;
};

export type ApiKeyScope = 'ingest' | 'evals:write' | 'admin';

export type ProjectApiKey = {
  id: string;
  projectId: string;
  environmentId: string;
  name: string;
  prefix: string;
  scopes: ApiKeyScope[];
  allowedOrigins?: string[];
  createdAt: string;
  lastUsedAt?: string;
  expiresAt?: string;
  revokedAt?: string;
};

export type RedactionAction = 'remove' | 'mask' | 'hash' | 'truncate';

export type RedactionRule = {
  path: string;
  action: RedactionAction;
  maxLength?: number;
};

export type DataPolicy = {
  projectId: string;
  environmentId: string;
  redactionRules: RedactionRule[];
  samplingRate: number;
  retentionDays: number;
  updatedAt: string;
};

export const TELEMETRY_EVENT_TYPES = [
  'session.started',
  'tool.called',
  'tool.completed',
  'tool.failed',
  'task.completed',
  'task.failed',
  'session.abandoned',
  'deployment.registered',
  'manifest.observed',
] as const;

export type TelemetryEventType = (typeof TELEMETRY_EVENT_TYPES)[number];

export type TelemetryEvent = {
  schemaVersion: '1';
  eventId: string;
  sessionId: string;
  sequence: number;
  type: TelemetryEventType;
  occurredAt: string;
  payload: {
    deploymentId?: string;
    appVersionId?: string;
    appVersionLabel?: string;
    deployedAt?: string;
    commitSha?: string;
    toolManifest?: ToolSchema[];
    agent?: string;
    model?: string;
    intent?: string;
    metadata?: Record<string, unknown>;
    transcript?: TrajectoryStep[];
    callId?: string;
    toolName?: string;
    toolSchemaVersion?: string;
    arguments?: Record<string, unknown>;
    result?: unknown;
    durationMs?: number;
    errorType?: string;
    errorMessage?: string;
    failureCategory?: FailureCategory;
    failureTool?: string;
  };
};

export type TelemetryBatch = {
  environmentId: string;
  events: TelemetryEvent[];
};

export type SourceHealth = {
  projectId: string;
  environments: Array<{
    environment: ProjectEnvironment;
    lastEventAt: string | null;
    lastBatchAt: string | null;
    acceptedEvents: number;
    duplicateEvents: number;
    rejectedEvents: number;
    activeKeys: number;
  }>;
};

export type OperationalFinding = {
  id: string;
  kind: 'telemetry' | 'production' | 'eval';
  severity: 'info' | 'warning' | 'critical';
  title: string;
  summary: string;
  value: number;
  sampleSize: number;
};

export type ProjectOperationalOverview = {
  projectId: string;
  telemetry: {
    lastEventAt: string | null;
    acceptedEvents: number;
    rejectedEvents: number;
  };
  sessions: {
    total: number;
    completed: number;
    failed: number;
    abandoned: number;
    unknown: number;
    outcomeCoverage: number;
    measuredTaskSuccessRate: number | null;
  };
  calls: {
    total: number;
    errors: number;
    executionSuccessRate: number | null;
  };
  evals: {
    runs: number;
    latestRunId: string | null;
    latestSuccessRate: number | null;
    previousRunId: string | null;
    successRateDelta: number | null;
  };
  findings: OperationalFinding[];
};

export type IncidentRecord = {
  id: string;
  projectId: string;
  findingId?: string;
  title: string;
  status: 'open' | 'investigating' | 'resolved';
  severity: 'info' | 'warning' | 'critical';
  owner?: string;
  evidence: Record<string, unknown>;
  resolution?: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
};
