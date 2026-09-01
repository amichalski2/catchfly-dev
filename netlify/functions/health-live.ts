import { json, methodNotAllowed } from './lib/http.ts';

export const config = { path: '/health/live' };

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'GET') return methodNotAllowed('GET');
  return json(200, { status: 'live', version: process.env.npm_package_version ?? 'development' });
}
