/**
 * Runs Catchfly locally: the built dashboard plus its API, on one port.
 *
 * Catchfly Core is meant to be self-hostable, so running it must not require a
 * Netlify account or the Netlify CLI. This serves the same handlers the
 * platform serves, mapped onto plain Node HTTP, which also makes it the honest
 * end-to-end check: a browser here exercises the real fetch path.
 *
 *   npm run build && npm run serve
 *
 * Deployment on Netlify is unaffected — that uses netlify/functions directly.
 */

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGzip } from 'node:zlib';

import { handleApi } from '../netlify/functions/lib/router.ts';
import { authMode } from '../netlify/functions/lib/user-auth.ts';

process.loadEnvFile?.();
authMode();

const PORT = Number(process.env.PORT ?? 8888);
const DIST = resolve(dirname(fileURLToPath(import.meta.url)), '../apps/web/dist');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** Already-compressed formats; gzipping them spends CPU to add bytes. */
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.svg']);

/** Hashed asset filenames are content-addressed, so they can be cached hard. */
function cacheControlFor(file: string): string {
  return /-[A-Za-z0-9_-]{8,}\.(js|css)$/.test(file)
    ? 'public, max-age=31536000, immutable'
    : 'no-cache';
}

function serveStatic(url: string, req: IncomingMessage, res: ServerResponse): void {
  // normalize() before join(), so "../" in a request cannot climb out of dist.
  let decoded: string;
  try {
    decoded = decodeURIComponent(url.split('?')[0]);
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('Invalid URL encoding.');
    return;
  }
  const relative = normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  let file = join(DIST, relative);
  if (!file.startsWith(DIST)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  if (!existsSync(file) || statSync(file).isDirectory()) {
    // Single-page app: unknown paths are routes, not missing files.
    file = join(DIST, 'index.html');
  }
  if (!existsSync(file)) {
    res.writeHead(404).end('Run `npm run build` first.');
    return;
  }

  const headers: Record<string, string> = {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    'cache-control': cacheControlFor(file),
  };
  const accepted = req.headers['accept-encoding'];
  const acceptsGzip = /\bgzip\b/i.test(
    Array.isArray(accepted) ? accepted.join(', ') : (accepted ?? ''),
  );
  if (acceptsGzip && COMPRESSIBLE.has(extname(file))) {
    res.writeHead(200, { ...headers, 'content-encoding': 'gzip', vary: 'accept-encoding' });
    createReadStream(file).pipe(createGzip()).pipe(res);
    return;
  }
  res.writeHead(200, headers);
  createReadStream(file).pipe(res);
}

const server = createServer((req, res) => {
  void handleApi(req, res)
    .then((handled) => {
      if (!handled) serveStatic((req.url ?? '/').split('?')[0], req, res);
    })
    .catch((error: unknown) => {
      console.error(`${req.method ?? 'GET'} ${req.url ?? '/'} failed`, error);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      if (!res.writableEnded) res.end(JSON.stringify({ error: 'Internal error. See the server log.' }));
    });
});

server.listen(PORT, () => {
  console.log(`Catchfly on http://localhost:${PORT}`);
  console.log(`  serving ${DIST}`);
  if (!process.env.DATABASE_URL && !process.env.NETLIFY_DATABASE_URL) {
    console.warn('  ! no DATABASE_URL configured — the API will answer 503');
  }
});
