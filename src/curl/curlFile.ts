import { normalizeCmdEscapes, parseCurl, unclosedQuote, type ParsedCurl } from './parseCurl';

/** What a test should check about a response, written as `# key: value` comments above a curl command. */
export interface Directives {
  /** Test / step title. */
  name?: string;
  /** Expected status: `201`, `200,201` (any of), or `2xx`. Without it the response must be 2xx. */
  expect?: string;
  /** `path = value` (value read as JSON when it is JSON: true, 42, "text", [1]); `path` alone means "is present". */
  expectJson: Array<{ path: string; value?: unknown; present: boolean }>;
  /** `name = exact value` or `name ~ contains`. */
  expectHeader: Array<{ name: string; value: string; contains: boolean }>;
  expectBodyContains: string[];
  /** Slowest acceptable response, in milliseconds. */
  maxMs?: number;
  /** Path of a JSON Schema file the body must satisfy. */
  schema?: string;
  /** `variable = response.path`: remember a value for the commands after it (in the same flow). */
  save: Array<{ variable: string; path: string }>;
  tags: string[];
  /** The reason this command is skipped. */
  skip?: string;
  /** `# secret: inline` - the credentials in this command are deliberately fake (a wrong-password test): write them into the test instead of reading API_TOKEN & co. from the environment. */
  inlineSecrets?: boolean;
  /** Starts a flow: this and the following commands become steps of ONE test, sharing saved values. `# flow: end` closes it. */
  flow?: string;
}

export interface CurlEntry {
  /** 1-based line of the command's first line in the file. */
  line: number;
  command: string;
  parsed: ParsedCurl;
  directives: Directives;
  /** The flow this entry belongs to, if any. */
  flow?: string;
}

const KEYS = new Set([
  'name',
  'expect',
  'expect-json',
  'expect-header',
  'expect-body-contains',
  'expect-max-ms',
  'schema',
  'save',
  'tag',
  'skip',
  'flow',
  'secret',
]);

const emptyDirectives = (): Directives => ({
  expectJson: [],
  expectHeader: [],
  expectBodyContains: [],
  save: [],
  tags: [],
});

function jsonOrString(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Applies one `# key: value` line. Returns an error message when the line is a known key with a bad value. */
function applyDirective(directives: Directives, key: string, value: string): string | undefined {
  switch (key) {
    case 'name':
      directives.name = value;
      return;
    case 'expect':
      if (!/^(\d{3}(\s*,\s*\d{3})*|[1-5]xx)$/i.test(value))
        return `"# expect: ${value}" - use a status (201), several (200,201) or a class (2xx)`;
      directives.expect = value.replace(/\s+/g, '');
      return;
    case 'expect-json': {
      const eq = value.indexOf('=');
      if (eq === -1) directives.expectJson.push({ path: value.trim(), present: true });
      else
        directives.expectJson.push({
          path: value.slice(0, eq).trim(),
          value: jsonOrString(value.slice(eq + 1).trim()),
          present: false,
        });
      return;
    }
    case 'expect-header': {
      const match = /^([^=~]+?)\s*([=~])\s*([\s\S]*)$/.exec(value);
      if (!match) return `"# expect-header: ${value}" - use "name = value" or "name ~ contains"`;
      directives.expectHeader.push({
        name: (match[1] as string).trim(),
        value: (match[3] as string).trim(),
        contains: match[2] === '~',
      });
      return;
    }
    case 'expect-body-contains':
      directives.expectBodyContains.push(value);
      return;
    case 'expect-max-ms': {
      const ms = Number(value);
      if (!Number.isFinite(ms) || ms <= 0)
        return `"# expect-max-ms: ${value}" - use a number of milliseconds`;
      directives.maxMs = ms;
      return;
    }
    case 'schema':
      directives.schema = value;
      return;
    case 'save': {
      const match = /^([A-Za-z_$][\w$]*)\s*=\s*(.+)$/.exec(value);
      if (!match) return `"# save: ${value}" - use "variableName = response.path"`;
      directives.save.push({ variable: match[1] as string, path: (match[2] as string).trim() });
      return;
    }
    case 'tag':
      directives.tags.push(
        ...value
          .split(/[\s,]+/)
          .filter(Boolean)
          .map((t) => (t.startsWith('@') ? t : `@${t}`)),
      );
      return;
    case 'skip':
      directives.skip = value || 'skipped in the curl file';
      return;
    case 'flow':
      directives.flow = value;
      return;
    case 'secret':
      if (value !== 'inline') return `"# secret: ${value}" - the only value is "inline"`;
      directives.inlineSecrets = true;
      return;
  }
}

export interface ParsedCurlFile {
  entries: CurlEntry[];
  /** Problems found while reading: bad directives, commands that could not be parsed. Reading continues past them. */
  problems: string[];
}

/**
 * Reads a curl file: any number of curl commands (bash, or Chrome's "Copy as cURL" in bash or cmd form), each optionally
 * preceded by `# key: value` comment lines saying what to check. Everything else in a comment is ignored, so ordinary
 * notes are fine. Blank lines separate nothing - a command ends where its quotes close and its line does.
 *
 *   # name: Create a user
 *   # expect: 201
 *   # expect-json: name = Ada
 *   # save: userId = id
 *   curl -X POST https://api.example.com/users -H 'Content-Type: application/json' -d '{"name":"Ada"}'
 */
export function parseCurlFile(text: string): ParsedCurlFile {
  const entries: CurlEntry[] = [];
  const problems: string[] = [];
  const lines = normalizeCmdEscapes(text.replace(/\r\n/g, '\n')).split('\n');
  let pending = emptyDirectives();
  let activeFlow: string | undefined;
  let current = '';
  let startLine = 0;

  const finish = () => {
    const command = current.replace(/\\\n[ \t]*/g, ' ').trim();
    current = '';
    if (!command) return;
    try {
      const parsed = parseCurl(command);
      if (pending.flow !== undefined)
        activeFlow = /^(end|none)$/i.test(pending.flow) ? undefined : pending.flow;
      entries.push({ line: startLine, command, parsed, directives: pending, flow: activeFlow });
    } catch (error) {
      problems.push(`line ${startLine}: ${error instanceof Error ? error.message : String(error)}`);
    }
    pending = emptyDirectives();
  };

  lines.forEach((line, index) => {
    if (!current) {
      const trimmed = line.trim();
      if (trimmed === '') return;
      if (trimmed.startsWith('#')) {
        const match = /^#\s*([a-z-]+)\s*:\s*(.*)$/i.exec(trimmed);
        if (match && KEYS.has((match[1] as string).toLowerCase())) {
          const problem = applyDirective(
            pending,
            (match[1] as string).toLowerCase(),
            (match[2] as string).trim(),
          );
          if (problem) problems.push(`line ${index + 1}: ${problem}`);
        }
        // a flow line on its own (no command yet) still opens the flow for the commands after it
        return;
      }
      startLine = index + 1;
    }
    current += (current ? '\n' : '') + line;
    if (!unclosedQuote(current) && !/\\$/.test(current)) finish();
  });
  if (current.trim()) finish();
  return { entries, problems };
}
