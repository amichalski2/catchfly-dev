#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

function value(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

function required(name: string, envName?: string): string {
  const found = value(name) ?? (envName ? process.env[envName] : undefined);
  if (!found) throw new Error(`Missing --${name}${envName ? ` or ${envName}` : ''}.`);
  return found;
}

function reportPathArgument(): string {
  const path = process.argv[4];
  if (!path || path.startsWith('--')) {
    throw new Error('Pass the Chrome report path after "eval upload".');
  }
  return path;
}

async function uploadReport(reportPath: string): Promise<void> {
  const endpoint = required('endpoint', 'CATCHFLY_ENDPOINT').replace(/\/$/, '');
  const projectId = required('project', 'CATCHFLY_PROJECT');
  const version = required('version', 'CATCHFLY_APP_VERSION');
  const key = required('key', 'CATCHFLY_EVAL_KEY');
  const label = value('label') ?? version;
  const minimum = value('min-success-rate');
  const threshold = minimum === undefined ? null : Number(minimum);
  if (threshold !== null && (!Number.isFinite(threshold) || threshold < 0 || threshold > 1)) {
    throw new Error('--min-success-rate must be a number between 0 and 1.');
  }

  const report = JSON.parse(readFileSync(resolve(reportPath), 'utf8')) as unknown;
  const response = await fetch(`${endpoint}/api/projects/${encodeURIComponent(projectId)}/runs`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      report,
      appVersion: {
        id: version,
        label,
        releasedAt: value('released-at') ?? new Date().toISOString(),
        ...(value('commit') ? { note: `Commit ${value('commit')}` } : {}),
      },
    }),
  });
  if (!response.ok) {
    throw new Error(`Catchfly upload failed (${response.status}): ${await response.text()}`);
  }

  const result = (await response.json()) as {
    run: { id: string; metrics: { successRate: number } };
    cases: number;
  };
  console.log(
    `Uploaded ${result.run.id}: ${result.cases} cases, ${(result.run.metrics.successRate * 100).toFixed(1)}% success.`,
  );
  console.log(`${endpoint}/w/9f2c7a41#/p/${encodeURIComponent(projectId)}/regressions`);

  if (threshold !== null && result.run.metrics.successRate < threshold) {
    console.error(
      `Quality gate failed: ${(result.run.metrics.successRate * 100).toFixed(1)}% is below ${(threshold * 100).toFixed(1)}%.`,
    );
    process.exitCode = 2;
  }
}

async function runWebMcpEvals(): Promise<string> {
  const url = required('url');
  const evals = required('evals');
  const reportDirectory = resolve(value('report-dir') ?? '.evals');
  const startedAt = Date.now();
  const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const args = ['--yes', 'webmcp-evals', 'browser', '-u', url, '-e', evals, '--reporter', 'json'];
  const model = value('model');
  if (model) args.push('--model', model);

  await new Promise<void>((accept, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', env: process.env });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) accept();
      else reject(new Error(`webmcp-evals exited with code ${code ?? 'unknown'}.`));
    });
  });

  const report = readdirSync(reportDirectory)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const path = resolve(reportDirectory, name);
      return { path, modifiedAt: statSync(path).mtimeMs };
    })
    .filter((entry) => entry.modifiedAt >= startedAt - 2_000)
    .sort((a, b) => b.modifiedAt - a.modifiedAt)[0];

  if (!report) {
    throw new Error(`webmcp-evals finished but wrote no JSON report to ${reportDirectory}.`);
  }
  return report.path;
}

function usage(): void {
  console.log(`Catchfly CLI

Run a WebMCP suite and send it to Catchfly:
  catchfly eval run --url <app> --evals <file> --endpoint <url> --project <id> --version <id> --key <secret>

Upload an existing Chrome report:
  catchfly eval upload <report.json> --endpoint <url> --project <id> --version <id> --key <secret>`);
}

process.loadEnvFile?.();

const [area, command] = process.argv.slice(2, 4);
try {
  if (area === 'eval' && command === 'upload') {
    await uploadReport(reportPathArgument());
  } else if (area === 'eval' && command === 'run') {
    await uploadReport(await runWebMcpEvals());
  } else {
    usage();
    process.exitCode = area || command ? 1 : 0;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
