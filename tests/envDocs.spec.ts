import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import { convertCurl } from '../src/curl';

// Drift guard for the configuration reference. `.env.example` is documentation nobody loads, so nothing but this file
// notices when the code starts reading a variable that the file does not mention, or when the file keeps describing one
// that nothing reads. It compares three things, all computed - none of them is a list kept by hand next to the code:
//   1. the variables THIS repo's own code reads (src, playwright.config.ts, scripts, tests/support, tests/generated, the
//      Gherkin steps and features, the CI pipeline),
//   2. the variables the SHARED utils code reads on this repo's behalf (the built dist of @automation/referenced-automation-utils),
//   3. `.env.example`, the README "Configuration reference" table and `.env.local.example`.
// The helpers are exported so the negative controls at the bottom can run them on synthetic text.

const root = path.join(__dirname, '..');
const NAME = '[A-Z][A-Z0-9_]*';

// ---- reading the sources ---------------------------------------------------------------------------------------------

function read(...parts: string[]): string {
  return fs.readFileSync(path.join(root, ...parts), 'utf8');
}

/** Every file below `dir` (relative to the repo root) that passes `accept`, as repo-relative forward-slash paths. */
export function walk(dir: string, accept: (file: string) => boolean): string[] {
  const out: string[] = [];
  const base = path.join(root, dir);
  if (!fs.existsSync(base)) return out;
  const visit = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (accept(full)) out.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  visit(base);
  return out.sort();
}

/** TypeScript / JavaScript source without comments (so a variable mentioned in a doc comment is not "read"). */
export function stripComments(source: string, javascript = false): string {
  const file = ts.createSourceFile(
    javascript ? 'x.js' : 'x.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    javascript ? ts.ScriptKind.JS : ts.ScriptKind.TS,
  );
  return ts.createPrinter({ removeComments: true }).printFile(file);
}

function add(into: Set<string>, text: string, pattern: RegExp, group: number): void {
  for (const match of text.matchAll(pattern)) into.add(match[group] as string);
}

const ENV_ACCESSOR = new RegExp(
  String.raw`\benv\s*\.\s*(?:get|getOptional|getInt|getBoolean|getList|has)\s*\(\s*(['"` + '`' + String.raw`])(${NAME})\1`,
  'g',
);
const PROCESS_ENV_DOT = new RegExp(String.raw`\bprocess\.env\.(${NAME})\b`, 'g');
const PROCESS_ENV_INDEX = new RegExp(String.raw`\bprocess\.env\[\s*(['"` + '`' + String.raw`])(${NAME})\1\s*\]`, 'g');
/** The curl converter's fixed names: `fromValueOrEnv(<value>, 'API_TOKEN')` and `ctx.env('API_PASSWORD')`. */
const CONVERTER_FIXED_VALUE = new RegExp(String.raw`\bfromValueOrEnv\s*\([^'"` + '`' + String.raw`]*?,\s*['"](${NAME})['"]\s*\)`, 'g');
const CONVERTER_FIXED_ENV = new RegExp(String.raw`\bctx\s*\.\s*env\s*\(\s*['"](${NAME})['"]\s*\)`, 'g');
/** `createPlaywrightConfig({ baseUrlKey: 'API_BASE_URL' })` - the key the shared config reads for this repo. */
const BASE_URL_KEY = new RegExp(String.raw`\bbaseUrlKey\s*:\s*['"](${NAME})['"]`, 'g');

/** Variables read by TypeScript / JavaScript code: env.get*('X'), process.env.X, process.env['X'], the converter's fixed names, baseUrlKey. */
export function readsFromCode(source: string, javascript = false): Set<string> {
  const code = stripComments(source, javascript);
  const found = new Set<string>();
  add(found, code, ENV_ACCESSOR, 2);
  add(found, code, PROCESS_ENV_DOT, 1);
  add(found, code, PROCESS_ENV_INDEX, 2);
  add(found, code, CONVERTER_FIXED_VALUE, 1);
  add(found, code, CONVERTER_FIXED_ENV, 1);
  add(found, code, BASE_URL_KEY, 1);
  return found;
}

/** Gherkin: `{{env:NAME}}` placeholders and the step `I read the environment variable "NAME" into ...`. */
export function readsFromFeature(text: string): Set<string> {
  const found = new Set<string>();
  add(found, text, new RegExp(String.raw`\{\{\s*env:\s*(${NAME})`, 'g'), 1);
  add(found, text, new RegExp(String.raw`environment variable\s+"(${NAME})"`, 'g'), 1);
  return found;
}

/**
 * Variables a shell (.sh) or batch (.bat) script or a CI pipeline file READS: `$NAME`, `${NAME...}`, `%NAME%`,
 * `if defined NAME` - minus the names the same file assigns itself (those are its own variables, not configuration).
 */
export function readsFromScript(source: string, kind: 'sh' | 'bat' | 'yml', ignore: readonly string[] = []): Set<string> {
  const lines = source.split(/\r?\n/).filter((line) => {
    const trimmed = line.trim();
    if (kind === 'bat') return !/^(rem\b|::)/i.test(trimmed);
    return !trimmed.startsWith('#');
  });
  const text = lines.join('\n');
  const reads = new Set<string>();
  const assigned = new Set<string>();
  if (kind === 'bat') {
    add(reads, text, new RegExp(String.raw`%(${NAME})%`, 'g'), 1);
    add(reads, text, new RegExp(String.raw`\bdefined\s+(${NAME})\b`, 'gi'), 1);
    add(assigned, text, new RegExp(String.raw`\bset\s+(?:/[AP]\s+)?"?(${NAME})=`, 'gi'), 1);
  } else {
    add(reads, text, new RegExp(String.raw`\$\{?(${NAME})\b`, 'g'), 1);
    add(assigned, text, new RegExp(String.raw`^\s*(?:local\s+|export\s+|readonly\s+)?(${NAME})=`, 'gm'), 1);
    add(assigned, text, new RegExp(String.raw`\bfor\s+(${NAME})\s+in\b`, 'g'), 1);
  }
  return new Set([...reads].filter((name) => !assigned.has(name) && !ignore.includes(name)));
}

// ---- parsing .env.example --------------------------------------------------------------------------------------------

export interface Entry {
  name: string;
  /** What the variable is for: the comment lines above `Read from:`. */
  purpose: string;
  /** Which of the required metadata lines are missing. */
  missing: string[];
  secret: boolean;
  defaultText: string;
  requiredText: string;
  example: string;
  /** 1-based line of the commented `# NAME=...` line. */
  line: number;
}

const METADATA: Array<[string, RegExp]> = [
  ['Read from:', /^# Read from:\s*\S/m],
  ['Values:', /^# Values:\s*\S/m],
  ['Default:', /^# Default:\s*\S/m],
  ['Required:', /^# Default:.*\|\s*Required:\s*\S/m],
  ['Secret:', /^# Default:.*\|\s*Secret:\s*(?:no|YES)\b/m],
  ['Example:', /^# Example(?: \([^)]*\))?:\s*\S/m],
];

/** One entry per commented variable line (`# NAME=...`), with the comment block directly above it. */
export function parseExample(text: string): Entry[] {
  const lines = text.split(/\r?\n/);
  const entries: Entry[] = [];
  lines.forEach((line, index) => {
    const match = new RegExp(`^# (${NAME})=`).exec(line);
    if (!match) return;
    const block: string[] = [];
    for (let j = index - 1; j >= 0 && (lines[j] as string).startsWith('#'); j--) block.unshift(lines[j] as string);
    const joined = block.join('\n');
    const firstMeta = block.findIndex((l) => /^# (Read from|Values|Default|Example)/.test(l));
    const purpose = block
      .slice(0, firstMeta === -1 ? block.length : firstMeta)
      .map((l) => l.replace(/^#\s?/, ''))
      .join(' ')
      .trim();
    const defaults = /^# Default:\s*(.*?)\s*\|\s*Required:\s*(.*?)\s*\|\s*Secret:\s*(.*)$/m.exec(joined);
    const example = /^# Example(?: \([^)]*\))?:\s*(.*)$/m.exec(joined)?.[1] ?? '';
    entries.push({
      name: match[1] as string,
      purpose,
      missing: METADATA.filter(([, pattern]) => !pattern.test(joined)).map(([label]) => label),
      secret: /^YES\b/.test(defaults?.[3] ?? ''),
      defaultText: defaults?.[1] ?? '',
      requiredText: defaults?.[2] ?? '',
      example,
      line: index + 1,
    });
  });
  return entries;
}

// ---- parsing the README table ------------------------------------------------------------------------------------------

export interface TableRow {
  name: string;
  cells: string[];
  secret: boolean;
}

/** The rows of every table under the README heading "## Configuration reference" (up to the next `## ` heading). */
export function parseConfigTable(readme: string): TableRow[] {
  const start = readme.search(/^## Configuration reference\s*$/m);
  if (start === -1) return [];
  const rest = readme.slice(start + 1);
  const next = rest.search(/^## (?!#)/m);
  const section = next === -1 ? rest : rest.slice(0, next);
  const rows: TableRow[] = [];
  for (const line of section.split(/\r?\n/)) {
    if (!line.startsWith('|')) continue;
    const cells = line
      .replace(/^\||\|\s*$/g, '')
      .split(/(?<!\\)\|/)
      .map((cell) => cell.trim());
    const name = new RegExp(`^\`(${NAME})\`$`).exec(cells[0] ?? '')?.[1];
    if (name) rows.push({ name, cells, secret: /^YES$/i.test(cells[cells.length - 1] ?? '') });
  }
  return rows;
}

// ---- the comparisons (pure, so the negative controls can feed them synthetic data) ---------------------------------

/** Names read by code that the example file does not document. */
export function missingFromExample(reads: Iterable<string>, example: Entry[]): string[] {
  const documented = new Set(example.map((entry) => entry.name));
  return [...new Set(reads)].filter((name) => !documented.has(name)).sort();
}

/** Documented names that nothing reads and that are not in the allowed list (read by shared code or a justified pass-through). */
export function documentedButUnread(example: Entry[], readers: Iterable<string>[], passThrough: readonly string[]): string[] {
  const read = new Set(readers.flatMap((set) => [...set]));
  return example
    .map((entry) => entry.name)
    .filter((name) => !read.has(name) && !passThrough.includes(name))
    .sort();
}

/** Differences between the README table and the example file: names on one side only, and Secret columns that disagree. */
export function tableDifferences(example: Entry[], table: TableRow[]): string[] {
  const problems: string[] = [];
  const inFile = new Map(example.map((entry) => [entry.name, entry]));
  const inTable = new Map(table.map((row) => [row.name, row]));
  for (const name of inFile.keys()) if (!inTable.has(name)) problems.push(`${name} is in .env.example but not in the README table`);
  for (const name of inTable.keys()) if (!inFile.has(name)) problems.push(`${name} is in the README table but not in .env.example`);
  for (const [name, entry] of inFile) {
    const row = inTable.get(name);
    if (row && row.secret !== entry.secret)
      problems.push(`${name}: the README Secret column says ${row.secret ? 'YES' : 'no'}, .env.example says ${entry.secret ? 'YES' : 'no'}`);
    if (row && row.cells.length !== 5) problems.push(`${name}: the README row has ${row.cells.length} columns, expected 5`);
  }
  return problems;
}

/** Problems with the secrets template: a Secret: YES key without a line, a non-secret key in it, a real-looking value. */
export function localExampleProblems(example: Entry[], localText: string): string[] {
  const problems: string[] = [];
  const secrets = example.filter((entry) => entry.secret).map((entry) => entry.name);
  const all = new Set(example.map((entry) => entry.name));
  const present = new Map<string, string>();
  for (const line of localText.split(/\r?\n/)) {
    const match = new RegExp(`^(?:# )?(${NAME})=(.*)$`).exec(line);
    if (match) present.set(match[1] as string, (match[2] as string).trim());
  }
  for (const name of secrets) if (!present.has(name)) problems.push(`${name} is Secret: YES but has no entry in .env.local.example`);
  for (const [name, value] of present) {
    if (all.has(name) && !secrets.includes(name)) problems.push(`${name} is not a secret but is in .env.local.example`);
    if (value !== '' && !/^"<[^"<>]+>"$/.test(value)) problems.push(`${name}: the value ${value} is not a placeholder like "<api-token>"`);
  }
  return problems;
}

// ---- what is read, computed ------------------------------------------------------------------------------------------

/** OS / shell provided names the scripts use; they are not configuration. */
export const SCRIPT_BUILTINS = ['TEMP', 'RANDOM', 'ERRORLEVEL', 'PATH', 'HOME'] as const;

/**
 * Variables read only by this repo's own test harness (a nested Playwright project that a spec starts in another
 * process and configures itself). They are plumbing between two files in tests/, not settings a person sets.
 */
export const HARNESS_ONLY: Record<string, string> = {
  EXPECT_BASE: 'tests/remoteFixtures.spec.ts hands the expected base URL to its nested project',
  REMOTE_INNER: 'tests/remoteFixtures.spec.ts picks which nested spec runs',
  REMOTE_SHARE_DIR: 'tests/remoteFixtures.spec.ts places the stand-in agent mailbox; the real key is documented in the utils .env.example (see the REMOTE_* note)',
};

/** Documented variables that no scanned source reads literally, each with the reason it is still listed - and how a test proves it. */
export const PASS_THROUGH: Record<string, string> = {
  TZ: 'Node itself reads it (real environment only); nothing in this repo or utils does',
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: 'set by scripts/create-package for its own npm commands and read by Playwright\'s installer',
  API_COOKIE: 'a DERIVED converter name (Cookie -> API_COOKIE): proven by the derived-name test below, not by a literal in src',
};

/** curl commands whose generated test must read the derived variable (the converter's naming rule, checked for real). */
export const DERIVED_BY_CONVERTER: Record<string, string> = {
  API_COOKIE: `curl https://api.test/a -H 'Cookie: sid=1'`,
};

function groupReads(): Record<string, Set<string>> {
  const groups: Record<string, Set<string>> = {
    src: new Set(),
    config: new Set(),
    tests: new Set(),
    steps: new Set(),
    scripts: new Set(),
    pipeline: new Set(),
  };
  const merge = (group: string, names: Set<string>) => names.forEach((n) => (groups[group] as Set<string>).add(n));
  for (const file of walk('src', (f) => f.endsWith('.ts'))) merge('src', readsFromCode(read(file)));
  merge('config', readsFromCode(read('playwright.config.ts')));
  for (const file of [...walk('tests/support', (f) => f.endsWith('.ts')), ...walk('tests/generated', (f) => f.endsWith('.ts'))])
    merge('tests', readsFromCode(read(file)));
  for (const file of walk('features/steps', (f) => f.endsWith('.ts'))) merge('steps', readsFromCode(read(file)));
  for (const file of walk('features', (f) => f.endsWith('.feature'))) merge('steps', readsFromFeature(read(file)));
  for (const file of walk('scripts', (f) => /\.(sh|bat)$/.test(f)))
    merge('scripts', readsFromScript(read(file), file.endsWith('.bat') ? 'bat' : 'sh', SCRIPT_BUILTINS));
  // GitLab's predefined CI_* variables are the platform's, not this repo's settings
  merge(
    'pipeline',
    new Set([...readsFromScript(read('.gitlab-ci.yml'), 'yml')].filter((name) => !name.startsWith('CI_'))),
  );
  return groups;
}

function repoReads(): Set<string> {
  const groups = groupReads();
  const all = new Set<string>();
  for (const names of Object.values(groups)) names.forEach((n) => all.add(n));
  for (const name of Object.keys(HARNESS_ONLY)) all.delete(name);
  return all;
}

function utilsDist(): string {
  return path.dirname(require.resolve('@automation/referenced-automation-utils'));
}

function distFiles(dir: string): string[] {
  const out: string[] = [];
  const visit = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.name.endsWith('.js')) out.push(full);
    }
  };
  visit(dir);
  return out.sort();
}

/** The keys createPlaywrightConfig, the logger, the random generators and loadEnv read - from the BUILT utils files. */
function sharedKeys(): Set<string> {
  const dist = utilsDist();
  const found = new Set<string>();
  for (const file of ['playwright/config.js', 'logger/logger.js', 'random/randomUtils.js', 'config/env.js'])
    readsFromCode(fs.readFileSync(path.join(dist, file), 'utf8'), true).forEach((n) => found.add(n));
  // the key the shared config reads for THIS repo's base URL
  readsFromCode(read('playwright.config.ts')).forEach((n) => found.add(n));
  return found;
}

/** Every key any utils dist file reads (covers REMOTE_*, S3270_PATH, TN3270_TIMEOUT_MS ...). */
function allUtilsKeys(): Set<string> {
  const found = new Set<string>();
  for (const file of distFiles(utilsDist())) readsFromCode(fs.readFileSync(file, 'utf8'), true).forEach((n) => found.add(n));
  return found;
}

const example = () => parseExample(read('.env.example'));

// ---- the tests -------------------------------------------------------------------------------------------------------

test.describe('configuration reference: .env.example, README table and the code agree @regression', () => {
  test('discovery is not vacuous: every source yields keys, and the known ones are found', () => {
    const groups = groupReads();
    expect(groups.src?.size, 'keys found in src/').toBeGreaterThanOrEqual(3);
    expect(groups.scripts?.size, 'keys found in scripts/').toBeGreaterThanOrEqual(2);
    expect(groups.pipeline?.size, 'keys found in .gitlab-ci.yml').toBeGreaterThanOrEqual(3);
    expect(groups.tests?.size, 'keys found in tests/support and tests/generated').toBeGreaterThanOrEqual(5);
    expect(groups.steps?.size, 'keys found in the Gherkin steps and features').toBeGreaterThanOrEqual(3);
    const repo = repoReads();
    expect(repo.size, 'repo keys').toBeGreaterThanOrEqual(12);
    for (const key of [
      'API_BASE_URL',
      'API_VIA_REMOTE',
      'REMOTE_API_BASE_URL',
      'API_USER',
      'API_PASSWORD',
      'API_TOKEN',
      'API_KEY',
      'NPM_REGISTRY_URL',
      'USE_LOCAL_PACKAGES',
      'PLAYWRIGHT_DOWNLOAD_HOST',
      'AUDIT_RUN_GATES',
      'FEATURE_SAMPLE_TOKEN',
    ])
      expect(repo.has(key), `${key} should be discovered in this repo's code`).toBe(true);

    const shared = sharedKeys();
    expect(shared.size, 'shared keys found in the built utils').toBeGreaterThanOrEqual(28);
    for (const key of [
      'ENV',
      'ENVIRONMENT',
      'BROWSER',
      'DEVICE',
      'HEADLESS',
      'WORKERS',
      'RETRIES',
      'TEST_TIMEOUT_MS',
      'GLOBAL_TIMEOUT_MS',
      'TEST_ID_ATTRIBUTE',
      'IGNORE_HTTPS_ERRORS',
      'LOG_LEVEL',
      'LOG_FILE_PER_WORKER',
      'NO_COLOR',
      'FORCE_COLOR',
      'RANDOM_SEED',
      'CI',
      'TEST_WORKER_INDEX',
      'API_BASE_URL',
    ])
      expect(shared.has(key), `${key} should be discovered in the built utils`).toBe(true);
    expect(allUtilsKeys().has('REMOTE_ENABLED'), 'REMOTE_ENABLED should be discovered in utils/dist/remote').toBe(true);

    const documented = example();
    expect(documented.length, 'variables documented in .env.example').toBeGreaterThanOrEqual(45);
    expect(parseConfigTable(read('README.md')).length, 'rows in the README table').toBeGreaterThanOrEqual(45);
  });

  test('(a) every variable this repo reads is documented in .env.example', () => {
    expect(missingFromExample(repoReads(), example())).toEqual([]);
  });

  test('(b) every variable the shared utils code reads on this repo\'s behalf is documented in .env.example', () => {
    expect(missingFromExample(sharedKeys(), example())).toEqual([]);
  });

  test('(c) .env.example documents nothing that nothing reads', () => {
    const unread = documentedButUnread(example(), [repoReads(), sharedKeys(), allUtilsKeys()], Object.keys(PASS_THROUGH));
    expect(unread, 'listed in .env.example but read by no code (remove it, or justify it in PASS_THROUGH)').toEqual([]);
    for (const [name, reason] of Object.entries(PASS_THROUGH)) {
      expect(reason.length, `${name} needs a reason`).toBeGreaterThan(10);
      expect(example().map((e) => e.name), `PASS_THROUGH lists ${name}, which .env.example no longer documents`).toContain(name);
    }
  });

  test('a derived name in PASS_THROUGH is produced by the curl converter (the rule behind it is real)', () => {
    for (const [name, command] of Object.entries(DERIVED_BY_CONVERTER)) {
      const { envVars } = convertCurl(command, { source: 'derived.curl' });
      expect(envVars, `converting ${command}`).toContain(name);
    }
  });

  test('(d) every variable block has a purpose, Read from, Values, Default, Required, Secret and an Example for itself', () => {
    const problems: string[] = [];
    const seen = new Set<string>();
    for (const entry of example()) {
      if (seen.has(entry.name)) problems.push(`${entry.name} (line ${entry.line}) is documented twice`);
      seen.add(entry.name);
      if (entry.purpose === '') problems.push(`${entry.name} (line ${entry.line}) has no description above its metadata`);
      if (entry.missing.length > 0) problems.push(`${entry.name} (line ${entry.line}) lacks: ${entry.missing.join(', ')}`);
      if (!new RegExp(`\\b${entry.name}=`).test(entry.example))
        problems.push(`${entry.name} (line ${entry.line}): the Example line does not show ${entry.name}=...`);
    }
    expect(problems).toEqual([]);
  });

  test('(e) the README Configuration reference table lists exactly the variables of .env.example, with the same Secret marks', () => {
    const table = parseConfigTable(read('README.md'));
    expect(table.length, 'the README has a "## Configuration reference" section with tables').toBeGreaterThan(0);
    expect(tableDifferences(example(), table)).toEqual([]);
  });

  test('(f) .env.local.example has an entry for every Secret: YES key, only placeholders, nothing else', () => {
    expect(fs.existsSync(path.join(root, '.env.local.example')), '.env.local.example exists').toBe(true);
    const entries = example();
    expect(entries.filter((e) => e.secret).length, 'secret keys').toBeGreaterThanOrEqual(5);
    expect(localExampleProblems(entries, read('.env.local.example'))).toEqual([]);
    // the secret file is named after the environment; these patterns must keep it (and the template's copy) out of git
    const ignore = read('.gitignore');
    expect(ignore).toMatch(/^\.env\.\*\.local\s*$/m);
    expect(ignore).not.toMatch(/^\.env\.example\s*$/m);
    expect(ignore).not.toMatch(/^\.env\.local\.example\s*$/m);
  });

  test('(g) the dotenv quoting TIP appears exactly once in .env.example', () => {
    const text = read('.env.example');
    expect(text.match(/TIP - quoting values \(dotenv rules\):/g)?.length).toBe(1);
  });

  test('the committed .env.<name> files hold no secret key and only documented keys', () => {
    const entries = example();
    const secrets = new Set(entries.filter((e) => e.secret).map((e) => e.name));
    const documented = new Set(entries.map((e) => e.name));
    const committed = fs.readdirSync(root).filter((f) => /^\.env(\.[a-z0-9-]+)?$/i.test(f) && !f.endsWith('.local') && !f.endsWith('.example'));
    expect(committed.length, 'committed .env.<name> files').toBeGreaterThanOrEqual(3);
    const problems: string[] = [];
    for (const file of committed)
      for (const line of read(file).split(/\r?\n/)) {
        const key = new RegExp(`^(${NAME})=`).exec(line.trim())?.[1];
        if (!key) continue;
        if (secrets.has(key)) problems.push(`${file} holds the secret key ${key}: move it to ${file}.local`);
        if (!documented.has(key)) problems.push(`${file} sets ${key}, which .env.example does not document`);
      }
    expect(problems).toEqual([]);
  });
});

test.describe('configuration reference: negative controls (the checks above can fail) @regression', () => {
  const exampleText = [
    '# Which environment.',
    '# Read from: the real environment only',
    '# Values: qa | stage',
    '# Default: qa | Required: no | Secret: no',
    '# Example: ENV=stage',
    '# ENV=qa',
    '',
    '# A password.',
    '# Read from: .env files or the real environment',
    '# Values: any text',
    '# Default: unset | Required: yes | Secret: YES - .env.<name>.local',
    '# Example (in .env.qa.local): API_PASSWORD="replace-me"',
    '# API_PASSWORD=',
    '',
  ].join('\n');

  test('(a) a key the code reads but the example lacks is reported; comments and look-alikes are not reads', () => {
    const reads = readsFromCode(
      [
        "const a = env.get('SOME_NEW_KEY');",
        "const b = env.getInt('ANOTHER_KEY', 5);",
        "const c = process.env.THIRD_KEY;",
        "const d = process.env['FOURTH_KEY'];",
        "const e = fromValueOrEnv(parsed.value, 'API_FIFTH');",
        "const f = ctx.env('API_SIXTH');",
        "createPlaywrightConfig({ baseUrlKey: 'SEVENTH_URL' });",
        "// env.get('COMMENTED_OUT')",
        '/** process.env.IN_DOC_COMMENT */',
        "const g = headers.get('CONTENT_TYPE');",
        "const h = text.includes('env.get(');",
      ].join('\n'),
    );
    expect([...reads].sort()).toEqual(['ANOTHER_KEY', 'API_FIFTH', 'API_SIXTH', 'FOURTH_KEY', 'SEVENTH_URL', 'SOME_NEW_KEY', 'THIRD_KEY']);
    expect(missingFromExample(reads, parseExample(exampleText))).toEqual([...reads].sort());
    expect(missingFromExample(new Set(['ENV', 'API_PASSWORD']), parseExample(exampleText))).toEqual([]);
  });

  test('scripts and pipeline: reads are found, a script\'s own variables, comments and builtins are not', () => {
    const sh = ['# $COMMENTED', 'LOCAL=0', 'if [ -n "${NPM_REGISTRY_URL:-}" ]; then echo "$LOCAL $OUT_DIR"; fi', 'OUT_DIR=x', 'echo $NEW_SCRIPT_KEY'].join('\n');
    expect([...readsFromScript(sh, 'sh')].sort()).toEqual(['NEW_SCRIPT_KEY', 'NPM_REGISTRY_URL']);
    const bat = ['REM %COMMENTED%', 'set "LOCAL=0"', 'if defined NPM_REGISTRY_URL echo %LOCAL% %NEW_BAT_KEY% %TEMP%'].join('\r\n');
    expect([...readsFromScript(bat, 'bat', SCRIPT_BUILTINS)].sort()).toEqual(['NEW_BAT_KEY', 'NPM_REGISTRY_URL']);
    const yml = ['# ${COMMENTED}', '  - if [ -n "${AUDIT_RUN_GATES:-}" ]; then echo $CI_PROJECT_DIR; fi'].join('\n');
    expect([...readsFromScript(yml, 'yml')].sort()).toEqual(['AUDIT_RUN_GATES', 'CI_PROJECT_DIR']);
    expect([...readsFromFeature('Given I set the variable "a" to "{{env:SOME_FEATURE_KEY|x}}"\nAnd I read the environment variable "OTHER_KEY" into "b"')].sort()).toEqual(['OTHER_KEY', 'SOME_FEATURE_KEY']);
  });

  test('(c) a documented key that nothing reads is reported, unless it is read by shared code or listed with a reason', () => {
    const entries = parseExample(exampleText);
    expect(documentedButUnread(entries, [new Set(['ENV'])], [])).toEqual(['API_PASSWORD']);
    expect(documentedButUnread(entries, [new Set(['ENV']), new Set(['API_PASSWORD'])], [])).toEqual([]);
    expect(documentedButUnread(entries, [new Set(['ENV'])], ['API_PASSWORD'])).toEqual([]);
  });

  test('(d) a block missing a metadata line is reported, and Secret / Required are read from the Default line', () => {
    const [env, password] = parseExample(exampleText);
    expect(env?.missing).toEqual([]);
    expect(password).toMatchObject({ secret: true, defaultText: 'unset', requiredText: 'yes', purpose: 'A password.' });
    for (const label of ['Read from:', 'Values:', 'Default:', 'Example:']) {
      const broken = exampleText
        .split('\n')
        .filter((line) => !line.startsWith(`# ${label}`) && !(label === 'Example:' && line.startsWith('# Example (in')))
        .join('\n');
      expect(parseExample(broken).some((entry) => entry.missing.includes(label)), `removing ${label}`).toBe(true);
    }
    const noSecret = parseExample(exampleText.replace(' | Secret: no', ''));
    expect(noSecret[0]?.missing).toEqual(['Secret:']);
    const noRequired = parseExample(exampleText.replace(' | Required: no', ''));
    expect(noRequired[0]?.missing).toContain('Required:');
  });

  test('(e) a name or a Secret mark that differs between the README table and the example is reported', () => {
    const entries = parseExample(exampleText);
    const good = ['| Name | Purpose | Default | Required | Secret |', '|---|---|---|---|---|', '| `ENV` | x | qa | no | no |', '| `API_PASSWORD` | x | unset | yes | YES |'];
    const readme = (rows: string[]) => ['# T', '', '## Configuration reference', '', ...rows, '', '## Next', '| `NOT_IN_SECTION` | x | y | no | no |'].join('\n');
    expect(tableDifferences(entries, parseConfigTable(readme(good)))).toEqual([]);
    expect(tableDifferences(entries, parseConfigTable(readme(good.slice(0, 3))))).toEqual(['API_PASSWORD is in .env.example but not in the README table']);
    expect(tableDifferences(entries, parseConfigTable(readme([...good, '| `EXTRA_KEY` | x | y | no | no |'])))).toEqual(['EXTRA_KEY is in the README table but not in .env.example']);
    expect(tableDifferences(entries, parseConfigTable(readme([good[0] as string, good[1] as string, good[2] as string, '| `API_PASSWORD` | x | unset | yes | no |'])))).toEqual([
      'API_PASSWORD: the README Secret column says no, .env.example says YES',
    ]);
    expect(tableDifferences(entries, parseConfigTable('# no section here'))).toHaveLength(2);
  });

  test('(f) a secret without a template entry, a plain key and a real-looking value are reported', () => {
    const entries = parseExample(exampleText);
    expect(localExampleProblems(entries, '# API_PASSWORD="<api-password>"\n')).toEqual([]);
    expect(localExampleProblems(entries, '# nothing here\n')).toEqual(['API_PASSWORD is Secret: YES but has no entry in .env.local.example']);
    expect(localExampleProblems(entries, '# API_PASSWORD="<p>"\nENV="<qa>"\n')).toEqual(['ENV is not a secret but is in .env.local.example']);
    expect(localExampleProblems(entries, 'API_PASSWORD=hunter2\n')[0]).toContain('is not a placeholder');
    expect(localExampleProblems(entries, 'API_PASSWORD="hunter2"\n')[0]).toContain('is not a placeholder');
  });

  test('(g) the TIP count is exact: the check would see a second copy', () => {
    const tip = 'TIP - quoting values (dotenv rules):';
    expect(`${tip}\n${tip}`.match(/TIP - quoting values \(dotenv rules\):/g)?.length).toBe(2);
    expect(''.match(/TIP - quoting values \(dotenv rules\):/g)).toBeNull();
  });
});
