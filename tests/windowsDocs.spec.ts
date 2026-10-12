import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Working INSIDE this repo on Windows (PowerShell). A package's own `bin` commands are not linked into its own
// node_modules/.bin, so `npx api-curl-to-playwright ...` fails here with "'api-curl-to-playwright' is not recognized"
// and only works in a project that depends on this package. This file keeps the docs honest about that: every bin has
// an npm script, no document shows the bare `npx <bin>` form without saying where it works, the Windows first-run
// section exists, POSIX-only examples have a PowerShell twin, and the converter really starts through its npm script.
// The helpers are exported so the negative controls can run them on synthetic text.

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
  bin: Record<string, string>;
};

function read(file: string): string {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

/** Repo-relative paths of the files below `dir` that pass `accept` (node_modules, dist and generated output skipped). */
export function listFiles(dir: string, accept: (file: string) => boolean): string[] {
  const base = path.join(root, dir);
  if (!fs.existsSync(base)) return [];
  const out: string[] = [];
  const visit = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (['node_modules', 'dist', '.git', 'allure-results', 'test-results', 'playwright-report', '.features-gen'].includes(entry.name))
        continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (accept(full)) out.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  visit(base);
  return out.sort();
}

/** The documents that tell a person what to type: README, docs, CONTRIBUTING, the CLI usage text, curl file comments, scripts, CI. CHANGELOG is history and is not checked. */
export function documentFiles(): string[] {
  return [
    'README.md',
    'CONTRIBUTING.md',
    '.gitlab-ci.yml',
    '.env.example',
    '.env.local.example',
    ...listFiles('docs', (f) => f.endsWith('.md')),
    ...listFiles('src/cli', (f) => f.endsWith('.ts')),
    ...listFiles('curl', (f) => f.endsWith('.curl')),
    ...listFiles('scripts', () => true),
  ].filter((file) => fs.existsSync(path.join(root, file)));
}

const SAYS_WHERE = /depends on this package|dependent project/i;

/** Markdown emphasis and code ticks removed, so "**depends on** this package" reads like the plain sentence. */
function plain(line: string): string {
  return line.replace(/[*`_]/g, '');
}

/**
 * Lines that show `npx <one of this package's own bins>` without a line that says it is for a project that depends on
 * this package on the same line or within `window` lines above it.
 */
export function npxOfOwnBin(text: string, bins: readonly string[], window = 8): Array<{ line: number; text: string }> {
  const lines = text.split(/\r?\n/);
  const pattern = new RegExp(`\\bnpx\\s+(?:--\\S+\\s+)*(?:${bins.map((b) => b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`);
  const problems: Array<{ line: number; text: string }> = [];
  lines.forEach((line, index) => {
    if (!pattern.test(line)) return;
    const near = lines.slice(Math.max(0, index - window), index + 1).map(plain);
    if (!near.some((l) => SAYS_WHERE.test(l))) problems.push({ line: index + 1, text: line.trim() });
  });
  return problems;
}

/** Lines with `playwright test` followed by a path that has a backslash (Playwright reads it as a pattern: "No tests found"). */
export function backslashTestPaths(text: string): Array<{ line: number; text: string }> {
  const problems: Array<{ line: number; text: string }> = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const at = line.search(/\bplaywright\s+test\b/);
    if (at === -1) return;
    const rest = line.slice(at).replace(/\bplaywright\s+test\b/, '');
    const command = rest.split(/[;`|#]/)[0] ?? '';
    if (/[\w.]\\[\w.]/.test(command)) problems.push({ line: index + 1, text: line.trim() });
  });
  return problems;
}

/** POSIX-only example lines and the PowerShell form that must follow within `window` lines. */
export const POSIX_ONLY: Array<{ what: string; line: RegExp; needs: RegExp }> = [
  { what: 'export NAME=value', line: /^\s*export [A-Z][A-Z0-9_]*=/, needs: /\$env:[A-Z]/ },
  { what: 'NAME=value npx|npm ...', line: /^\s*[A-Z][A-Z0-9_]*=\S+\s+(?:npx|npm)\s/, needs: /\$env:[A-Z]/ },
  { what: 'pbpaste |', line: /^\s*pbpaste\s*\|/, needs: /Get-Clipboard/ },
  { what: '(cd dir && command)', line: /^\s*\(cd [^)]*&&/, needs: /Push-Location|Set-Location/ },
];

/** Code lines that only work in bash, with no PowerShell equivalent close by. */
export function posixOnlyWithoutPowerShell(text: string, window = 10): Array<{ line: number; what: string; text: string }> {
  const lines = text.split(/\r?\n/);
  const problems: Array<{ line: number; what: string; text: string }> = [];
  lines.forEach((line, index) => {
    for (const rule of POSIX_ONLY) {
      if (!rule.line.test(line)) continue;
      const after = lines.slice(index, index + window + 1);
      if (!after.some((l) => rule.needs.test(l))) problems.push({ line: index + 1, what: rule.what, text: line.trim() });
    }
  });
  return problems;
}

/**
 * Lines that tell a person to type `scripts\\x.bat` (works only in cmd.exe; PowerShell needs `.\\scripts\\x.bat`). A `call` line
 * inside a script, and a line that says it is the cmd.exe form, are fine.
 */
export function cmdOnlyInvocations(text: string): Array<{ line: number; text: string }> {
  const problems: Array<{ line: number; text: string }> = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (!/(?<![.\\\w])scripts\\(?:setup|create-package|publish-package)\.bat/.test(line)) return;
    if (/^\s*(?:@?call|if|for)\b/i.test(line) || /cmd\.exe/.test(line)) return;
    problems.push({ line: index + 1, text: line.trim() });
  });
  return problems;
}

const BIN_NAMES = Object.keys(pkg.bin);
const DOCS = ['README.md', 'CONTRIBUTING.md', ...listFiles('docs', (f) => f.endsWith('.md'))];

test.describe('working inside the repo on Windows: npm scripts, docs and the first-run section @regression', () => {
  test('package.json: curl-to-tests runs the converter, and every bin has an npm script that runs it', () => {
    expect(pkg.scripts['curl-to-tests']).toBe('node dist/cli/curlToTests.js');
    expect(BIN_NAMES.length, 'bins of this package').toBeGreaterThanOrEqual(1);
    for (const [name, target] of Object.entries(pkg.bin)) {
      const command = `node ${target.replace(/^\.\//, '')}`;
      const aliases = Object.entries(pkg.scripts).filter(([, value]) => value === command);
      expect(aliases.map(([key]) => key), `an npm script that runs bin "${name}" as "${command}"`).not.toHaveLength(0);
    }
    // the script the README names must be the one that exists, and the older alias keeps working
    expect(pkg.scripts['convert:curl']).toBe('node dist/cli/curlToTests.js');
  });

  test('no document shows `npx <own bin>` unless it says the form is for a project that depends on this package', () => {
    const files = documentFiles();
    expect(files, 'the scan covers the README, the CLI usage text and the curl file').toEqual(
      expect.arrayContaining(['README.md', 'src/cli/curlToTests.ts', 'curl/examples.curl']),
    );
    let mentions = 0;
    const problems: string[] = [];
    for (const file of files) {
      const text = read(file);
      mentions += (text.match(new RegExp(`\\bnpx\\s+(?:${BIN_NAMES.join('|')})\\b`, 'g')) ?? []).length;
      for (const hit of npxOfOwnBin(text, BIN_NAMES)) problems.push(`${file}:${hit.line}: ${hit.text}`);
    }
    // not vacuous: the one explained use (README, CLI usage, curl file header) is seen by the scan
    expect(mentions, 'documented uses of npx <own bin> that were checked').toBeGreaterThanOrEqual(3);
    expect(problems, 'use `npm run curl-to-tests -- <args>` or `node dist/cli/curlToTests.js <args>` inside this repo').toEqual([]);
  });

  test('README has a "Windows first run" section with the install, build, test and the common first errors', () => {
    const readme = read('README.md');
    const start = readme.search(/^## Windows first run\s*$/m);
    expect(start, 'a "## Windows first run" heading').toBeGreaterThanOrEqual(0);
    const rest = readme.slice(start + 1);
    const next = rest.search(/^## (?!#)/m);
    const section = next === -1 ? rest : rest.slice(0, next);
    for (const needle of [
      '.\\scripts\\setup.bat',
      '.\\scripts\\setup.bat --local',
      'npm run build',
      'npm test',
      "'tsc' is not recognized",
      'No tests found',
      'Cannot find module',
      'Illegal characters in path',
      'rimraf --glob dist "*.tgz"',
      'npm run curl-to-tests --',
      '$env:ENV = ',
      'Remove-Item Env:',
      'LOG_LEVEL',
      'forward slashes',
      '.env.qa.local',
    ])
      expect(section, `the section mentions ${needle}`).toContain(needle);
    // linked from the top of the README
    expect(readme).toContain('(#windows-first-run)');
  });

  test('the clean script is the Windows-safe one that the first-run table promises', () => {
    expect(pkg.scripts.clean).toBe('rimraf --glob dist "*.tgz"');
  });

  test('no document selects a Playwright test file with a backslash path', () => {
    const problems: string[] = [];
    for (const file of documentFiles()) for (const hit of backslashTestPaths(read(file))) problems.push(`${file}:${hit.line}: ${hit.text}`);
    expect(problems).toEqual([]);
  });

  test('README and docs: every bash-only example has a PowerShell form next to it', () => {
    const problems: string[] = [];
    let checked = 0;
    for (const file of DOCS) {
      const text = read(file);
      checked += text.split(/\r?\n/).filter((l) => POSIX_ONLY.some((rule) => rule.line.test(l))).length;
      for (const hit of posixOnlyWithoutPowerShell(text)) problems.push(`${file}:${hit.line} (${hit.what}): ${hit.text}`);
    }
    expect(checked, 'bash-only example lines that were checked').toBeGreaterThanOrEqual(4);
    expect(problems).toEqual([]);
  });

  test('the setup scripts tell people to type .\\scripts\\... (the form that works in PowerShell and cmd.exe) and show the registry in PowerShell form', () => {
    for (const file of ['scripts/setup.bat', 'scripts/create-package.bat', 'scripts/publish-package.bat']) {
      const text = read(file);
      expect(text, `${file} shows the .\\ form`).toContain('.\\scripts\\');
      expect(cmdOnlyInvocations(text).map((hit) => `${file}:${hit.line}: ${hit.text}`)).toEqual([]);
    }
    expect(read('scripts/publish-package.bat')).toContain('$env:NPM_REGISTRY_URL');
    expect(read('scripts/setup.bat')).toContain('$env:NPM_REGISTRY_URL');
  });

  test('npm run curl-to-tests -- --help starts the converter from the repo root (needs dist: pretest builds it)', () => {
    const run = spawnSync('npm run curl-to-tests --silent -- --help', { cwd: root, shell: true, encoding: 'utf8', timeout: 120_000 });
    expect(run.status, `stderr: ${run.stderr}`).toBe(0);
    expect(run.stdout).toContain('api-curl-to-playwright - turn curl commands into Playwright API tests');
    expect(run.stdout).toContain('npm run curl-to-tests -- <file.curl | folder | -> [options]');
  });
});

test.describe('working inside the repo on Windows: negative controls (the checks above can fail) @regression', () => {
  const BINS = ['api-curl-to-playwright'];

  test('npx of an own bin is flagged without an explanation, accepted with one close above, flagged when it is too far above', () => {
    expect(npxOfOwnBin('Run it:\n\n    npx api-curl-to-playwright curl/x.curl', BINS)).toEqual([
      { line: 3, text: 'npx api-curl-to-playwright curl/x.curl' },
    ]);
    expect(npxOfOwnBin('From a project that depends on this package:\n  npx api-curl-to-playwright curl/x.curl', BINS)).toEqual([]);
    expect(npxOfOwnBin('works only from a **dependent project**\nnpx api-curl-to-playwright a', BINS)).toEqual([]);
    expect(npxOfOwnBin('only a project that **depends on** this package: `npx api-curl-to-playwright a`', BINS)).toEqual([]);
    const far = ['depends on this package', ...Array(9).fill('filler'), 'npx api-curl-to-playwright a'].join('\n');
    expect(npxOfOwnBin(far, BINS)).toHaveLength(1);
    expect(npxOfOwnBin('npx playwright test\nnpx automation-scan-secrets', BINS)).toEqual([]);
    expect(npxOfOwnBin('npm run curl-to-tests -- a.curl', BINS)).toEqual([]);
  });

  test('a backslash test path after `playwright test` is flagged; forward slashes, titles and other lines are not', () => {
    expect(backslashTestPaths('npx playwright test tests\\env.spec.ts')).toHaveLength(1);
    expect(backslashTestPaths('  npx playwright test --project=x tests\\a\\b.spec.ts')).toHaveLength(1);
    expect(backslashTestPaths('npx playwright test tests/env.spec.ts')).toEqual([]);
    expect(backslashTestPaths('npx playwright test -g "title"')).toEqual([]);
    expect(backslashTestPaths('Backslash paths (`tests\\env.spec.ts`) give No tests found')).toEqual([]);
    expect(backslashTestPaths('$env:ENV = "qa"; npx playwright test; .\\scripts\\setup.bat')).toEqual([]);
  });

  test('a bash-only example is flagged without a PowerShell twin and accepted with one', () => {
    expect(posixOnlyWithoutPowerShell('```bash\nexport NPM_REGISTRY_URL="x"\n```')).toHaveLength(1);
    expect(posixOnlyWithoutPowerShell('ENV=stage npx playwright test')).toHaveLength(1);
    expect(posixOnlyWithoutPowerShell('pbpaste | npm run curl-to-tests -- - --stdout')).toHaveLength(1);
    expect(posixOnlyWithoutPowerShell('(cd ../x && ./scripts/create-package.sh)')).toHaveLength(1);
    expect(posixOnlyWithoutPowerShell('export NPM_REGISTRY_URL="x"\n```\n```powershell\n$env:NPM_REGISTRY_URL = "x"')).toEqual([]);
    expect(posixOnlyWithoutPowerShell('pbpaste | a\nGet-Clipboard | a')).toEqual([]);
    expect(posixOnlyWithoutPowerShell('(cd ../x && y)\nPush-Location ..\\x; y; Pop-Location')).toEqual([]);
    const far = ['export A_B=1', ...Array(11).fill('filler'), '$env:A_B = 1'].join('\n');
    expect(posixOnlyWithoutPowerShell(far)).toHaveLength(1);
  });

  test('a cmd-only script invocation is flagged; the .\\ form, call lines and cmd.exe notes are not', () => {
    expect(cmdOnlyInvocations('REM Usage: scripts\\setup.bat --local')).toHaveLength(1);
    expect(cmdOnlyInvocations('echo run scripts\\publish-package.bat now')).toHaveLength(1);
    expect(cmdOnlyInvocations('REM Usage: .\\scripts\\setup.bat --local')).toEqual([]);
    expect(cmdOnlyInvocations('call scripts\\create-package.bat "%OUT_DIR%"')).toEqual([]);
    expect(cmdOnlyInvocations('REM plain scripts\\setup.bat works only in cmd.exe')).toEqual([]);
  });

  test('the bin-to-script rule detects a bin without an alias', () => {
    const scripts = { 'curl-to-tests': 'node dist/cli/curlToTests.js' };
    const aliasFor = (target: string) => Object.values(scripts).includes(`node ${target.replace(/^\.\//, '')}`);
    expect(aliasFor('./dist/cli/curlToTests.js')).toBe(true);
    expect(aliasFor('./dist/cli/other.js')).toBe(false);
  });
});
