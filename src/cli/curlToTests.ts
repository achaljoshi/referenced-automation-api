#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { convertCurl, type ParamRule } from '../curl';

const USAGE = `api-curl-to-playwright - turn curl commands into Playwright API tests that use this framework

Usage:
  api-curl-to-playwright <file.curl | folder | -> [options]

  A curl file holds any number of curl commands (copy them from Postman, Chrome "Copy as cURL", API docs, a terminal).
  Put "# key: value" comment lines above a command to say what to check:

    # name: Create a user
    # expect: 201                      (a status, 200,201 for several, or 2xx)
    # expect-json: name = Ada          (or just a path to require it is present)
    # expect-header: content-type ~ json
    # expect-body-contains: created
    # expect-max-ms: 800
    # schema: schemas/user.json
    # save: userId = id                (use as {{userId}} in the commands after it, inside a flow)
    # flow: Onboarding                 (this and the commands after it become steps of ONE test; "# flow: end" closes it)
    # tag: @smoke
    # skip: not deployed yet
    # secret: inline                   (the credentials are deliberately fake, e.g. a wrong-password test: write them in)
    curl -X POST https://api.example.com/users -H 'Content-Type: application/json' -d '{"name":"Ada"}'

Options:
  --out <file.ts|folder>   Where to write the spec(s). Default: tests/generated/<name>.spec.ts
  --stdout                 Print the generated test instead of writing a file.
  --test-import <module>   Module \`test\` and \`expect\` come from. Default: @automation/referenced-automation-api.
                           Point it at your own base test (a relative path) to add your project's fixtures.
  --api-import <module>    Module the auth classes come from. Default: @automation/referenced-automation-api.
  --tag <tag>              Tag added to every test title. Default: @api.
  --inline                 Write queries, headers, bodies, paths and expected values in the steps. By default the test starts with
                           CONSTANTS (what every command sends and expects; secrets as getters that read the environment) and
                           ENDPOINTS (the path of every call), and the steps only refer to them - so a changed input or URL is
                           one edit at the top.
  --keep-host              Keep scheme and host in every URL. Default: paths only, the host comes from API_BASE_URL
                           (kept automatically if the commands call more than one host).
  --follow-redirects       Follow redirects on every call. Default: only commands that had curl's -L do.
  --keep-all-headers       Keep the browser headers "Copy as cURL" adds (sec-fetch-*, user-agent, ...).
  --param <name-regex>=<ENV_VAR>
                           Read the value of any header / query parameter / form field / JSON key whose NAME matches from an
                           environment variable instead of writing it into the test. Repeatable. Anything named like a
                           password, token, secret, api key, authorization or cookie is handled without this.
  --flow                   Make all commands one test, each a step.
  --title <text>           Title of the wrapping describe. Default: the file name.
  --strict                 Exit with an error if anything could not be converted exactly.
  -h, --help
`;

interface Options {
  input: string;
  out: string;
  stdout: boolean;
  testImport?: string;
  apiImport?: string;
  tag?: string;
  keepHost: boolean;
  inline: boolean;
  followRedirects: boolean;
  keepAllHeaders: boolean;
  params: ParamRule[];
  singleFlow: boolean;
  title?: string;
  strict: boolean;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    input: '',
    out: '',
    stdout: false,
    keepHost: false,
    inline: false,
    followRedirects: false,
    keepAllHeaders: false,
    params: [],
    singleFlow: false,
    strict: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === '-h' || arg === '--help') {
      process.stdout.write(USAGE);
      process.exit(0);
    } else if (arg === '--out') opts.out = value();
    else if (arg === '--stdout') opts.stdout = true;
    else if (arg === '--test-import') opts.testImport = value();
    else if (arg === '--api-import') opts.apiImport = value();
    else if (arg === '--tag') opts.tag = value();
    else if (arg === '--keep-host') opts.keepHost = true;
    else if (arg === '--inline') opts.inline = true;
    else if (arg === '--follow-redirects') opts.followRedirects = true;
    else if (arg === '--keep-all-headers') opts.keepAllHeaders = true;
    else if (arg === '--flow') opts.singleFlow = true;
    else if (arg === '--title') opts.title = value();
    else if (arg === '--strict') opts.strict = true;
    else if (arg === '--param') {
      const spec = value();
      const eq = spec.lastIndexOf('=');
      if (eq < 1 || eq === spec.length - 1)
        throw new Error(`--param needs <name-regex>=<ENV_VAR>, got "${spec}"`);
      opts.params.push({ pattern: new RegExp(spec.slice(0, eq), 'i'), envVar: spec.slice(eq + 1) });
    } else if (arg.startsWith('-') && arg !== '-')
      throw new Error(`Unknown option ${arg} (see --help)`);
    else if (!opts.input) opts.input = arg;
    else throw new Error(`Unexpected argument ${arg}`);
  }
  if (!opts.input)
    throw new Error('Give a curl file, a folder of them, or - for standard input (see --help)');
  return opts;
}

function inputFiles(input: string): Array<{ label: string; text: string; base: string }> {
  if (input === '-')
    return [{ label: 'standard input', text: fs.readFileSync(0, 'utf8'), base: 'stdin' }];
  const stat = fs.statSync(input);
  const files = stat.isDirectory()
    ? fs
        .readdirSync(input)
        .filter((f) => /\.(curl|sh|txt)$/i.test(f))
        .sort()
        .map((f) => path.join(input, f))
    : [input];
  if (files.length === 0) throw new Error(`No .curl / .sh / .txt files in ${input}`);
  return files.map((file) => ({
    label: file.split(path.sep).join('/'),
    text: fs.readFileSync(file, 'utf8'),
    base: path.basename(file).replace(/\.[^.]+$/, ''),
  }));
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  const files = inputFiles(opts.input);
  let anyWarning = false;
  for (const file of files) {
    const result = convertCurl(file.text, {
      source: file.label,
      testImport: opts.testImport,
      apiImport: opts.apiImport,
      tag: opts.tag,
      keepHost: opts.keepHost,
      inline: opts.inline,
      followRedirects: opts.followRedirects,
      keepAllHeaders: opts.keepAllHeaders,
      params: opts.params,
      singleFlow: opts.singleFlow,
      title: opts.title,
    });
    if (opts.stdout) {
      process.stdout.write(result.code);
    } else {
      const target =
        opts.out.endsWith('.ts') && files.length === 1
          ? opts.out
          : path.join(opts.out || path.join('tests', 'generated'), `${file.base}.spec.ts`);
      fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
      fs.writeFileSync(target, result.code);
      process.stderr.write(
        `wrote ${target}  (${result.tests} test${result.tests === 1 ? '' : 's'})\n`,
      );
    }
    for (const problem of result.problems) process.stderr.write(`  problem: ${problem}\n`);
    for (const warning of result.warnings) process.stderr.write(`  note: ${warning}\n`);
    if (result.envVars.length > 0)
      process.stderr.write(`  set these environment variables: ${result.envVars.join(', ')}\n`);
    if (
      !opts.keepHost &&
      result.origins.length > 0 &&
      !result.warnings.some((w) => w.includes('different hosts'))
    )
      process.stderr.write(`  API_BASE_URL should be ${result.origins[0]}\n`);
    if (result.problems.length > 0 || result.warnings.length > 0) anyWarning = true;
  }
  if (opts.strict && anyWarning) {
    process.stderr.write('--strict: something could not be converted exactly (see above)\n');
    process.exit(1);
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
