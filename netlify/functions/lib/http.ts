/** Shared response helpers, so every endpoint answers in the same shape. */

export function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/**
 * Read-only synthetic demo data changes only when it is regenerated. Keeping
 * these small responses in Netlify's durable cache removes cold-start variance
 * from a live demo without ever caching writes or private data.
 */
export function cachedJson(status: number, body: Record<string, unknown>, maxAgeSeconds = 300): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': `public, max-age=0, must-revalidate`,
      'netlify-cdn-cache-control': `public, durable, max-age=${maxAgeSeconds}, stale-while-revalidate=${maxAgeSeconds}`,
    },
  });
}

export function methodNotAllowed(allowed: string): Response {
  return new Response(JSON.stringify({ error: `Use ${allowed}.` }), {
    status: 405,
    headers: { 'content-type': 'application/json', allow: allowed },
  });
}

/** Reject an oversized body rather than buffering whatever arrives. */
export async function readJson(req: Request, maxBytes: number): Promise<unknown> {
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > maxBytes) {
    throw new BodyTooLarge(`Body exceeds ${Math.floor(maxBytes / 1024)} kB.`);
  }
  const text = await req.text();
  if (new TextEncoder().encode(text).length > maxBytes) {
    throw new BodyTooLarge(`Body exceeds ${Math.floor(maxBytes / 1024)} kB.`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new BadJson('Body is not valid JSON.');
  }
}

export class BodyTooLarge extends Error {}
export class BadJson extends Error {}
