/**
 * Runs the Chrome WebMCP Evals CLI against the Devpost Review Console.
 *
 * Run with: npm run evals -- [--models a,b,c] [--runs 3]
 *                            [--versions console-v1,console-v3]
 *
 * Each model gets its own report directory, so a set of models becomes a set of
 * runs Catchfly can compare — the model axis of the dashboard, on real data.
 * The console adds a second axis: the runner is pointed at `?version=<id>`, so
 * the same suite is answered by three different tool manifests served by one
 * bundle. That is the only way to get three eval targets out of a CLI that
 * takes a single URL per invocation.
 *
 * Requirements the runner cannot provide itself:
 *   - Chrome Canary / Dev 150+ on one of the paths webmcp-evals probes
 *     (Linux: /usr/bin/google-chrome-unstable)
 *   - an API key for the chosen model backend, in `.env` or the environment
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

// The CLI loads `.env` itself, but this script reads EVALS_MODEL/EVALS_RUNS
// before spawning it — without this it would silently fall back to the default
// model and fail on a key it was never meant to use.
try {
  process.loadEnvFile('.env');
} catch {
  // No .env: the CLI still reads the real environment.
}

const PORT = 4173;
const URL = `http://localhost:${PORT}`;
const BOOT_TIMEOUT_MS = 60_000;

const TARGET = {
  build: 'build:console',
  dist: 'apps/devpost-console/dist',
  evalsFile: 'evals/devpost-console.evals.json',
  outputDir: '.evals-console',
  versions: ['console-v1', 'console-v2', 'console-v3'],
};

/** Everything after `--` goes to the CLI; these two we also want to echo. */
function passthrough(): string[] {
  return process.argv.slice(2);
}

function flagValue(name: string, fallback: string): string {
  const args = passthrough();
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

async function waitForServer(): Promise<void> {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(URL, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((done) => setTimeout(done, 300));
  }
  throw new Error(`Preview server did not answer on ${URL} within ${BOOT_TIMEOUT_MS / 1000}s`);
}

/** Local bins, not `npx`: a wrapper process would survive the kill below. */
function bin(name: string): string {
  return resolve('node_modules', '.bin', name);
}

function run(
  command: string,
  args: string[],
  options: { inherit: boolean; env?: Record<string, string> },
): ChildProcess {
  return spawn(command, args, {
    stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    shell: false,
    ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
    // Own process group, so killing the server takes its children with it.
    detached: !options.inherit,
  });
}

async function reportFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir))
      .filter((name) => name.startsWith('report-') && name.endsWith('.json'))
      .sort();
  } catch {
    return [];
  }
}

/** `openai:z-ai/glm-5.2:free` → `openai-z-ai-glm-5-2-free` */
function slugify(model: string): string {
  return model.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

async function main(): Promise<void> {
  const target = TARGET;

  // A version sweep can be narrowed, which is how a single cell is re-run after
  // a flaky provider without paying for the whole matrix again.
  const versions = flagValue('--versions', target.versions.join(','))
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const version of versions) {
    if (version !== '' && !target.versions.includes(version)) {
      throw new Error(`Unknown version "${version}". Known: ${target.versions.join(', ')}`);
    }
  }

  await mkdir(target.outputDir, { recursive: true });

  console.log('› building the app so evals run against the production bundle');
  const build = run('npm', ['run', target.build], { inherit: true });
  const buildCode = await new Promise<number>((done) => build.on('exit', (code) => done(code ?? 1)));
  if (buildCode !== 0) throw new Error('build failed');

  console.log(`› starting a preview server on ${URL}`);
  const server = run(
    bin('vite'),
    ['preview', '--outDir', target.dist, '--port', String(PORT), '--strictPort'],
    { inherit: false },
  );
  server.stderr?.on('data', (chunk) => process.stderr.write(chunk));

  let stopped = false;
  const shutdown = () => {
    if (stopped || server.pid === undefined) return;
    stopped = true;
    try {
      // Negative pid: the whole process group started by `detached`.
      process.kill(-server.pid, 'SIGTERM');
    } catch {
      server.kill('SIGTERM');
    }
  };
  process.on('exit', shutdown);
  process.on('SIGINT', () => {
    shutdown();
    process.exit(130);
  });

  try {
    await waitForServer();

    const models = flagValue('--models', process.env.EVALS_MODEL ?? 'gemini-3.5-flash')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    const runs = flagValue('--runs', process.env.EVALS_RUNS ?? '1');
    console.log(`› ${target.evalsFile} against ${URL}, ${runs} run(s) per case`);
    console.log(`› models: ${models.join(', ')}`);
    console.log(`› versions: ${versions.join(', ')}`);
    console.log(`› ${versions.length * models.length} invocation(s)\n`);

    const reports: Array<{ cell: string; path: string | null }> = [];
    for (const version of versions) {
      const url = `${URL}/?version=${version}`;
      for (const model of models) {
        const dir = resolve(target.outputDir, version, slugify(model));
        await mkdir(dir, { recursive: true });
        const cell = `${version} · ${model}`;
        console.log(`\n\u001b[1m── ${cell} ──\u001b[0m`);

        const before = new Set(await reportFiles(dir));
        const evals = run(
          bin('webmcp-evals'),
          ['browser', '-u', url, '-e', target.evalsFile, '-m', model, '-r', runs, '-o', dir,
           '--reporter', 'console', 'json', 'html'],
          { inherit: true },
        );
        await new Promise<number>((done) => evals.on('exit', (exit) => done(exit ?? 1)));

        // The CLI reports some failures (a missing browser, a missing key) on
        // stderr and still exits 0, so a run that wrote no report is a failed run.
        const fresh = (await reportFiles(dir)).filter((name) => !before.has(name));
        reports.push({ cell, path: fresh.length > 0 ? resolve(dir, fresh.at(-1)!) : null });
      }
    }

    console.log('\n\u001b[1mreports\u001b[0m');
    for (const { cell, path } of reports) {
      console.log(`  ${path ? '\u001b[32mok\u001b[0m  ' : '\u001b[31mnone\u001b[0m'} ${cell}${path ? ` → ${path}` : ' — produced no report, see its output above'}`);
    }
    const missing = reports.filter((entry) => entry.path === null);
    if (missing.length === reports.length) {
      throw new Error('no cell produced a report');
    }
    if (missing.length > 0) {
      // Partial failure is normal with a hosted provider. Say which cells to
      // re-run rather than leaving it to be worked out from the log above.
      console.log(
        `\n  ${missing.length} cell(s) produced nothing. Re-run just those, e.g.\n` +
          `    npm run evals -- --versions <v> --models <model>`,
      );
    }
  } finally {
    shutdown();
  }
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
