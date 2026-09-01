/**
 * The API, expressed once, for every way we run it locally.
 *
 * In production Netlify reads the `config.path` on each function and does the
 * routing itself. Nothing local does that for us, so the same paths are
 * declared here and shared by both local runners — the standalone server
 * (`npm run serve`) and the Vite dev middleware. One table, so a new endpoint
 * cannot work in one and 404 in the other.
 */

import { gzip as gzipCallback } from 'node:zlib';
import { promisify } from 'node:util';
import type { IncomingMessage, ServerResponse } from 'node:http';

import bootstrap from '../bootstrap.ts';
import cases from '../cases.ts';
import dataset from '../dataset.ts';
import deploymentComparison from '../deployment-comparison.ts';
import deployments from '../deployments.ts';
import environments from '../environments.ts';
import evalCase from '../eval-case.ts';
import evalCases from '../eval-cases.ts';
import evalResults from '../eval-results.ts';
import evalRuns from '../eval-runs.ts';
import evalSuite from '../eval-suite.ts';
import incidentOverview from '../incident-overview.ts';
import incident from '../incident.ts';
import incidents from '../incidents.ts';
import me from '../me.ts';
import meProvision from '../me-provision.ts';
import orgs from '../orgs.ts';
import healthLive from '../health-live.ts';
import healthReady from '../health-ready.ts';
import dataPolicy from '../data-policy.ts';
import projectKey from '../project-key.ts';
import projectKeys from '../project-keys.ts';
import projectOverview from '../project-overview.ts';
import projects from '../projects.ts';
import runs from '../runs.ts';
import sessionDetail from '../session-detail.ts';
import sessions from '../sessions.ts';
import sources from '../sources.ts';
import telemetry from '../telemetry.ts';
import systemStatus from '../system-status.ts';
import toolProfile from '../tool-profile.ts';

export type FunctionHandler = (
  req: Request,
  context: { params: Record<string, string> },
) => Promise<Response>;

export const ROUTES: Array<{ pattern: RegExp; keys: string[]; handler: FunctionHandler }> = [
  { pattern: /^\/health\/live$/, keys: [], handler: healthLive as FunctionHandler },
  { pattern: /^\/health\/ready$/, keys: [], handler: healthReady as FunctionHandler },
  { pattern: /^\/api\/me$/, keys: [], handler: me as FunctionHandler },
  { pattern: /^\/api\/me\/provision$/, keys: [], handler: meProvision as FunctionHandler },
  { pattern: /^\/api\/orgs\/([^/]+)$/, keys: ['orgId'], handler: orgs as FunctionHandler },
  { pattern: /^\/api\/system$/, keys: [], handler: systemStatus as FunctionHandler },
  {
    pattern: /^\/api\/v1\/projects\/([^/]+)\/events$/,
    keys: ['projectId'],
    handler: telemetry as FunctionHandler,
  },
  { pattern: /^\/api\/projects$/, keys: [], handler: projects as FunctionHandler },
  {
    pattern: /^\/api\/projects\/([^/]+)\/environments\/([^/]+)\/policy$/,
    keys: ['projectId', 'environmentId'],
    handler: dataPolicy as FunctionHandler,
  },
  {
    pattern: /^\/api\/projects\/([^/]+)\/environments$/,
    keys: ['projectId'],
    handler: environments as FunctionHandler,
  },
  {
    pattern: /^\/api\/projects\/([^/]+)\/keys\/([^/]+)$/,
    keys: ['projectId', 'keyId'],
    handler: projectKey as FunctionHandler,
  },
  {
    pattern: /^\/api\/projects\/([^/]+)\/keys$/,
    keys: ['projectId'],
    handler: projectKeys as FunctionHandler,
  },
  {
    pattern: /^\/api\/projects\/([^/]+)\/sources$/,
    keys: ['projectId'],
    handler: sources as FunctionHandler,
  },
  {
    pattern: /^\/api\/projects\/([^/]+)\/overview$/,
    keys: ['projectId'],
    handler: projectOverview as FunctionHandler,
  },
  {
    pattern: /^\/api\/projects\/([^/]+)\/dataset$/,
    keys: ['projectId'],
    handler: dataset as FunctionHandler,
  },
  { pattern: /^\/api\/projects\/([^/]+)\/bootstrap$/, keys: ['projectId'], handler: bootstrap as FunctionHandler },
  {
    pattern: /^\/api\/projects\/([^/]+)\/incident-overview$/,
    keys: ['projectId'],
    handler: incidentOverview as FunctionHandler,
  },
  {
    pattern: /^\/api\/projects\/([^/]+)\/incidents\/([^/]+)$/,
    keys: ['projectId', 'incidentId'], handler: incident as FunctionHandler,
  },
  {
    pattern: /^\/api\/projects\/([^/]+)\/incidents$/,
    keys: ['projectId'], handler: incidents as FunctionHandler,
  },
  {
    pattern: /^\/api\/projects\/([^/]+)\/eval-runs\/([^/]+)\/results$/,
    keys: ['projectId', 'runId'],
    handler: evalResults as FunctionHandler,
  },
  { pattern: /^\/api\/projects\/([^/]+)\/eval-runs$/, keys: ['projectId'], handler: evalRuns as FunctionHandler },
  { pattern: /^\/api\/projects\/([^/]+)\/eval-suite$/, keys: ['projectId'], handler: evalSuite as FunctionHandler },
  {
    pattern: /^\/api\/projects\/([^/]+)\/eval-cases\/([^/]+)$/,
    keys: ['projectId', 'caseId'],
    handler: evalCase as FunctionHandler,
  },
  { pattern: /^\/api\/projects\/([^/]+)\/eval-cases$/, keys: ['projectId'], handler: evalCases as FunctionHandler },
  { pattern: /^\/api\/projects\/([^/]+)\/runs$/, keys: ['projectId'], handler: runs as FunctionHandler },
  { pattern: /^\/api\/projects\/([^/]+)\/cases$/, keys: ['projectId'], handler: cases as FunctionHandler },
  {
    pattern: /^\/api\/projects\/([^/]+)\/deployments$/,
    keys: ['projectId'],
    handler: deployments as FunctionHandler,
  },
  {
    pattern: /^\/api\/projects\/([^/]+)\/deployment-comparison$/,
    keys: ['projectId'],
    handler: deploymentComparison as FunctionHandler,
  },
  // The single-session route comes first: `/sessions/s-1` also matches nothing
  // else, but keeping the more specific pattern above the collection is the
  // habit that stops the next pair from silently shadowing each other.
  {
    pattern: /^\/api\/projects\/([^/]+)\/sessions\/([^/]+)$/,
    keys: ['projectId', 'sessionId'],
    handler: sessionDetail as FunctionHandler,
  },
  { pattern: /^\/api\/projects\/([^/]+)\/sessions$/, keys: ['projectId'], handler: sessions as FunctionHandler },
  {
    pattern: /^\/api\/projects\/([^/]+)\/tools\/([^/]+)\/profile$/,
    keys: ['projectId', 'toolName'],
    handler: toolProfile as FunctionHandler,
  },
];

const gzip = promisify(gzipCallback);

/**
 * Netlify compresses what its functions return; nothing local does. Without
 * this the self-hosted server ships every JSON body raw — a bootstrap payload
 * is mostly repeated tool manifests, which gzip removes almost entirely.
 */
const COMPRESS_ABOVE_BYTES = 1024;

function compressionFor(req: IncomingMessage, payload: Buffer): 'gzip' | null {
  if (payload.byteLength < COMPRESS_ABOVE_BYTES) return null;
  const accepted = req.headers['accept-encoding'];
  const header = Array.isArray(accepted) ? accepted.join(', ') : (accepted ?? '');
  return /\bgzip\b/i.test(header) ? 'gzip' : null;
}

async function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    bytes += buffer.byteLength;
    if (bytes > 3 * 1024 * 1024) throw new Error('REQUEST_BODY_TOO_LARGE');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * Runs the matching endpoint, or answers false if the path is not ours.
 *
 * An unmatched `/api/*` path is answered here rather than passed on, because
 * falling through to a static handler would return the SPA's HTML to a caller
 * expecting JSON — a confusing failure a long way from its cause.
 */
export async function handleApi(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const path = (req.url ?? '/').split('?')[0];
  if (!path.startsWith('/api/') && !path.startsWith('/health/')) return false;

  const route = ROUTES.find((entry) => entry.pattern.test(path));
  if (!route) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `No endpoint at ${path}.` }));
    return true;
  }

  const match = route.pattern.exec(path)!;
  let params: Record<string, string>;
  try {
    params = Object.fromEntries(
      route.keys.map((key, index) => [key, decodeURIComponent(match[index + 1])]),
    );
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'The request path contains invalid percent encoding.' }));
    return true;
  }

  const host = req.headers.host ?? 'localhost';
  let body: Buffer | undefined;
  try {
    body = await readBody(req);
  } catch (error) {
    if ((error as Error).message === 'REQUEST_BODY_TOO_LARGE') {
      res.writeHead(413, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Request body exceeds 3 MiB.' }));
      return true;
    }
    throw error;
  }
  const request = new Request(`http://${host}${req.url ?? '/'}`, {
    method: req.method,
    headers: Object.entries(req.headers).flatMap(([key, value]) =>
      value === undefined
        ? []
        : [[key, Array.isArray(value) ? value.join(', ') : value] as [string, string]],
    ),
    body,
  });

  try {
    const response = await route.handler(request, { params });
    const headers = Object.fromEntries(response.headers.entries());
    const payload = Buffer.from(await response.arrayBuffer());
    const encoding = compressionFor(req, payload);
    if (!encoding) {
      res.writeHead(response.status, headers);
      res.end(payload);
    } else {
      const compressed = await gzip(payload);
      // The declared length is the body's, and the body just changed.
      delete headers['content-length'];
      res.writeHead(response.status, {
        ...headers,
        'content-encoding': encoding,
        'content-length': String(compressed.byteLength),
        vary: headers.vary ? `${headers.vary}, accept-encoding` : 'accept-encoding',
      });
      res.end(compressed);
    }
  } catch (error) {
    console.error(`${req.method} ${path} failed`, error);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal error. See the server log.' }));
  }
  return true;
}
