import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

export interface InnerRun {
  status: number | null;
  stdout: string;
  stderr: string;
  /** Pass/fail counts read from the JSON reporter, when it produced any. */
  passed: number;
  failed: number;
  skipped: number;
  /** One line per failed test with its error message (ANSI colours removed), or the raw output when there is no report. */
  summary: string;
}

interface JsonSuite {
  suites?: JsonSuite[];
  specs?: Array<{
    title: string;
    tests: Array<{ status: string; results: Array<{ error?: { message?: string } }> }>;
  }>;
}

// eslint-disable-next-line no-control-regex -- strips ANSI colour codes
const ANSI = /\u001b\[[0-9;]*m/g;

function failures(suite: JsonSuite): string[] {
  return [
    ...(suite.specs ?? []).flatMap((spec) =>
      spec.tests
        .filter((t) => t.status === 'unexpected')
        .map(
          (t) =>
            `${spec.title}: ${(t.results[0]?.error?.message ?? '').replace(ANSI, '').slice(0, 600)}`,
        ),
    ),
    ...(suite.suites ?? []).flatMap(failures),
  ];
}

const root = path.join(__dirname, '..', '..');

/**
 * Runs a SEPARATE Playwright process on another config (a test project nested in this repo's tests/) and reports how
 * it went - for the behaviour that only exists in a whole run: which `.env` a fixture reads, what a generated spec does.
 * The environment is cleaned of what the outer worker passes down, so the inner run is a normal top-level run.
 */
export function runPlaywright(
  config: string,
  options: { cwd: string; env?: Record<string, string | undefined> },
): InnerRun {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of Object.keys(env))
    if (/^(PW_|PLAYWRIGHT_|TEST_WORKER_INDEX|TEST_PARALLEL_INDEX|FORCE_COLOR)/.test(key))
      delete env[key];
  Object.assign(env, options.env);
  const result = spawnSync(
    process.execPath,
    [
      path.join(root, 'node_modules', '@playwright', 'test', 'cli.js'),
      'test',
      '--config',
      config,
      '--reporter=json',
    ],
    { encoding: 'utf8', cwd: options.cwd, env: env as NodeJS.ProcessEnv, timeout: 120_000 },
  );
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let summary = `${result.stdout.slice(0, 1500)}\n${result.stderr.slice(0, 1500)}`;
  try {
    const report = JSON.parse(result.stdout) as JsonSuite & {
      stats?: { expected: number; unexpected: number; skipped: number; flaky: number };
    };
    passed = (report.stats?.expected ?? 0) + (report.stats?.flaky ?? 0);
    failed = report.stats?.unexpected ?? 0;
    skipped = report.stats?.skipped ?? 0;
    summary = failures(report).join('\n') || 'no failed tests';
  } catch {
    // no JSON: the run failed before it could report; status and stderr say why
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, passed, failed, skipped, summary };
}
