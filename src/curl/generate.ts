import * as path from 'node:path';
import type { CurlEntry, Directives } from './curlFile';
import type { ParsedCurl } from './parseCurl';

export interface ParamRule {
  /** Matches the NAME of a header, query parameter, form field or JSON key. */
  pattern: RegExp;
  /** The environment variable its value is read from instead of being written into the test. */
  envVar: string;
}

export interface GenerateOptions {
  /** Shown in the header comment: where the commands came from. */
  source: string;
  /** Module `test` and `expect` are imported from. Default `@automation/referenced-automation-api`; point it at your own base test to add fixtures. */
  testImport?: string;
  /** Module the auth classes (BearerAuth, ...) are imported from. Default `@automation/referenced-automation-api`. */
  apiImport?: string;
  /** Tag added to every test title. Default `@api`. */
  tag?: string;
  /** Keep the scheme and host in every URL instead of relying on API_BASE_URL. Automatic when the commands target more than one host. */
  keepHost?: boolean;
  /** Follow redirects on every request. By default only commands that had curl's -L do (curl does not follow redirects on its own). */
  followRedirects?: boolean;
  /** Keep the headers a browser adds (sec-fetch-*, user-agent, accept-language, ...) that "Copy as cURL" includes. Dropped by default. */
  keepAllHeaders?: boolean;
  /** Extra "this name holds a secret" rules. */
  params?: ParamRule[];
  /** One test with every command as a step, instead of one test per command. */
  singleFlow?: boolean;
  /** Title of the wrapping `test.describe`. Default: the source file name. */
  title?: string;
  /**
   * By default the test starts with two objects the steps refer to: CONSTANTS (every query, header and body sent, every
   * expected status / field / header / timing - secrets as getters that read the environment) and ENDPOINTS (the path of
   * every call), so a changed input or URL is one edit at the top. `inline` writes them in the steps instead.
   */
  inline?: boolean;
}

export interface GeneratedTests {
  code: string;
  tests: number;
  /** Environment variables the generated tests read - secrets and `$VAR`s from the commands. */
  envVars: string[];
  /** The host(s) the commands called; the tests use API_BASE_URL unless keepHost applies. */
  origins: string[];
  warnings: string[];
}

/** Header names that carry a credential. */
const SECRET_NAME =
  /pass(word|wd|code)?|secret|token|api[-_]?key|apikey|credential|authorization|signature|^cookie$|session/i;
/** Headers a browser or curl adds that say nothing about the API contract. */
const NOISE_HEADER =
  /^(host|content-length|connection|accept-encoding|accept-language|cache-control|pragma|priority|upgrade-insecure-requests|dnt|te|sec-.*|user-agent|origin|referer)$/i;

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** A TypeScript string literal in the single-quote style this repo uses. */
function quote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}'`;
}

function envNameFor(name: string): string {
  const snake = name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  return snake.startsWith('API_') ? snake : `API_${snake}`;
}

class Context {
  readonly envVars = new Set<string>();
  readonly warnings: string[] = [];
  readonly origins = new Set<string>();
  usesEnv = false;
  usesFs = false;
  readonly authClasses = new Set<string>();
  /** Variables saved by `# save:` so far in the flow being generated. */
  saved = new Set<string>();
  /** `# secret: inline` on the command being generated. */
  inlineSecrets = false;
  /** Values that read the environment are written as getters (they live in CONSTANTS). */
  get lazy(): boolean {
    return this.objects;
  }

  // CONSTANTS and ENDPOINTS
  readonly constants = new Map<string, Array<{ name: string; code: string }>>();
  readonly endpoints = new Map<string, string>();
  readonly expected = new Map<string, ExpectedEntry>();
  private readonly keys = new Set<string>();
  readonly commandKeys = new Map<CurlEntry, string>();

  constructor(
    readonly options: GenerateOptions,
    readonly rules: ParamRule[],
  ) {}

  env(name: string): string {
    this.usesEnv = true;
    this.envVars.add(name);
    return `env.get(${quote(name)})`;
  }

  warn(message: string): void {
    this.warnings.push(message);
  }

  /** CONSTANTS and ENDPOINTS are written (unless `inline`). */
  get objects(): boolean {
    return !this.options.inline;
  }

  /** The name of a command in CONSTANTS: its title in camel case, numbered when two commands share one. */
  keyFor(entry: CurlEntry): string {
    const existing = this.commandKeys.get(entry);
    if (existing) return existing;
    // `Basic auth (credentials come from ...)` -> `basicAuth`: the key names the command, not its explanation
    const base = camelName(titleOf(entry).split(/\s+\(|\s+-\s+/)[0] ?? '') || 'request';
    let key = base;
    for (let n = 2; this.keys.has(key); n++) key = `${base}${n}`;
    this.keys.add(key);
    this.commandKeys.set(entry, key);
    return key;
  }

  /** True when `code` reads something that only exists while a flow runs (a value saved by an earlier step) or a file: it cannot live in a constant. */
  private dynamic(code: string): boolean {
    return [...this.saved].some((name) => code.includes('${' + name + '}')) || /\bfs\./.test(code);
  }

  /** A value of a command as CONSTANTS.<section>.<key> - or the code itself when it cannot (or must not) be a constant. */
  register(section: 'queries' | 'headers' | 'bodies', key: string, code: string): string {
    if (!this.objects || this.dynamic(code)) return code;
    const entries = this.constants.get(section) ?? [];
    this.constants.set(section, entries);
    // the code was laid out for the step it came from; in CONSTANTS it sits one level shallower
    entries.push({
      name: key,
      code: code
        .split('\n')
        .map((line, i) => (i === 0 ? line : line.replace(/^ {2}/, '')))
        .join('\n'),
    });
    return `CONSTANTS.${section}.${key}`;
  }

  /** The path of a call as ENDPOINTS.<name> - or the code itself when it is built at run time. */
  endpoint(code: string, path: string): string {
    if (!this.objects || code.startsWith('`') || this.dynamic(code)) return code;
    const existing = [...this.endpoints.entries()].find(([, value]) => value === code);
    if (existing) return `ENDPOINTS.${existing[0]}`;
    const base = camelName(path.split('?')[0]?.replace(/^https?:\/\/[^/]+/i, '') ?? '') || 'root';
    let name = IDENTIFIER.test(base) ? base : `path${base}`;
    for (let n = 2; this.endpoints.has(name); n++) name = `${base}${n}`;
    this.endpoints.set(name, code);
    return `ENDPOINTS.${name}`;
  }
}

interface ExpectedEntry {
  status?: string;
  statusClass?: string;
  json: Array<[string, string]>;
  headers: Array<[string, string]>;
  headersContain: Array<[string, string]>;
  bodyContains: string[];
  maxMs?: number;
}

const WORD_LIMIT = 6;
/** `Create a user` -> `createAUser`; `GET /users/5` -> `getUsers5`. */
function camelName(text: string): string {
  const words = text
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, WORD_LIMIT);
  const name = words
    .map((w, i) =>
      i === 0 ? w.charAt(0).toLowerCase() + w.slice(1) : w.charAt(0).toUpperCase() + w.slice(1),
    )
    .join('');
  return /^[0-9]/.test(name) ? `n${name}` : name;
}

/** The environment variable a named value must come from, when its NAME marks it as secret (or a --param rule says so). */
function secretVar(ctx: Context, name: string): string | undefined {
  if (ctx.inlineSecrets) return undefined;
  const rule = ctx.rules.find((r) => r.pattern.test(name));
  if (rule) return rule.envVar;
  return SECRET_NAME.test(name) ? envNameFor(name) : undefined;
}

/**
 * A TS expression for a text value: a plain literal, or a template literal when it holds placeholders -
 * `${NAME}` from the shell (read from the environment), `{{env:NAME}}`, or `{{variable}}` saved by an earlier step.
 */
function textExpr(ctx: Context, value: string, shellVars: string[]): string {
  const parts: Array<{ literal: string } | { expr: string }> = [];
  const pattern = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\{\{\s*([^{}]+?)\s*\}\}/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    let expr: string | undefined;
    if (match[1] !== undefined) {
      if (shellVars.includes(match[1])) expr = ctx.env(match[1]);
    } else {
      const inner = match[2] as string;
      if (inner.startsWith('env:')) expr = ctx.env(inner.slice(4).split('|')[0] as string);
      else if (ctx.saved.has(inner)) expr = inner;
      else
        ctx.warn(
          `{{${inner}}} is not a variable saved by an earlier "# save:" in this flow; it was left as text`,
        );
    }
    if (expr === undefined) continue;
    if (match.index > last) parts.push({ literal: value.slice(last, match.index) });
    parts.push({ expr });
    last = match.index + match[0].length;
  }
  if (parts.length === 0) return quote(value);
  if (last < value.length) parts.push({ literal: value.slice(last) });
  if (parts.length === 1 && 'expr' in parts[0]!) return (parts[0] as { expr: string }).expr;
  const body = parts
    .map((part) =>
      'literal' in part
        ? part.literal.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')
        : `\${${part.expr}}`,
    )
    .join('');
  return `\`${body}\``;
}

/** A named value: from the environment when its name marks it secret, else a literal/template. */
function namedValueExpr(ctx: Context, name: string, value: string, shellVars: string[]): string {
  const alreadyIndirect = /\$\{[A-Za-z_]|\{\{/.test(value);
  const secret = alreadyIndirect ? undefined : secretVar(ctx, name);
  return secret ? ctx.env(secret) : textExpr(ctx, value, shellVars);
}

function jsonLiteral(
  ctx: Context,
  value: unknown,
  shellVars: string[],
  indent: number,
  keyName?: string,
): string {
  const pad = '  '.repeat(indent + 1);
  const closePad = '  '.repeat(indent);
  if (value === null) return 'null';
  if (typeof value === 'string')
    return keyName !== undefined
      ? namedValueExpr(ctx, keyName, value, shellVars)
      : textExpr(ctx, value, shellVars);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return `[\n${value.map((item) => `${pad}${jsonLiteral(ctx, item, shellVars, indent + 1, keyName)}`).join(',\n')},\n${closePad}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return '{}';
  return `{\n${entries
    .map(([key, item]) => {
      const code = jsonLiteral(ctx, item, shellVars, indent + 1, key);
      const name = IDENTIFIER.test(key) ? key : quote(key);
      const isObject = item !== null && typeof item === 'object' && !Array.isArray(item);
      // A value that reads the environment is a getter, so a missing variable names itself when used, not when the file loads.
      return ctx.lazy && !isObject && code.includes('env.get(')
        ? `${pad}get ${name}() {\n${pad}  return ${code};\n${pad}}`
        : `${pad}${name}: ${code}`;
    })
    .join(',\n')},\n${closePad}}`;
}

function objectLiteral(entries: Array<[string, string]>, indent: number, lazy = false): string {
  if (entries.length === 0) return '{}';
  const pad = '  '.repeat(indent + 1);
  const lines = entries.map(([key, expr]) => {
    const name = IDENTIFIER.test(key) ? key : quote(key);
    return lazy && expr.includes('env.get(')
      ? `${pad}get ${name}() {\n${pad}  return ${expr};\n${pad}}`
      : `${pad}${name}: ${expr}`;
  });
  return `{\n${lines.join(',\n')},\n${'  '.repeat(indent)}}`;
}

interface RequestCode {
  /** Statements that set auth, in order, before the request. */
  authLines: string[];
  /** The call: `apiClient.post('/x', { ... })`. */
  call: string;
}

function splitUrl(
  ctx: Context,
  parsed: ParsedCurl,
  keepHost: boolean,
): { target: string; queryEntries: Array<[string, string | string[]]> } {
  const raw = parsed.url;
  const startsWithVariable = /^\$\{[A-Za-z_]/.test(raw);
  let urlText = raw;
  let queryText = '';
  const q = urlText.indexOf('?');
  if (q !== -1) {
    queryText = urlText.slice(q + 1);
    urlText = urlText.slice(0, q);
  }
  const hash = queryText.indexOf('#');
  if (hash !== -1) queryText = queryText.slice(0, hash);

  let target = urlText;
  if (!startsWithVariable) {
    const origin = /^(https?:\/\/[^/]+)(\/.*)?$/i.exec(urlText);
    if (origin) {
      ctx.origins.add((origin[1] as string).toLowerCase());
      target = keepHost ? urlText : (origin[2] as string | undefined) ?? '/';
    } else if (!urlText.startsWith('/')) {
      // "localhost:3000/x" or "api.example.com/x" - curl assumes http://
      const bare = /^([^/]+)(\/.*)?$/.exec(urlText);
      if (bare) {
        ctx.origins.add(`http://${(bare[1] as string).toLowerCase()}`);
        target = keepHost ? `http://${urlText}` : (bare[2] as string | undefined) ?? '/';
      }
    }
  }
  if (
    /\{[A-Za-z_]\w*\}/.test(target.replace(/\$\{[A-Za-z_]\w*\}/g, '').replace(/\{\{[^}]*\}\}/g, ''))
  ) {
    ctx.warn(
      `The URL path contains {name}: the ApiClient treats that as a path parameter, so pass it in pathParams (or write the value into the path) - ${target}`,
    );
  }

  const queryEntries: Array<[string, string | string[]]> = [];
  if (queryText) {
    const grouped = new Map<string, string[]>();
    for (const pair of queryText.split('&')) {
      if (pair === '') continue;
      const eq = pair.indexOf('=');
      const decode = (text: string) => {
        try {
          return decodeURIComponent(text.replace(/\+/g, ' '));
        } catch {
          return text;
        }
      };
      const name = decode(eq === -1 ? pair : pair.slice(0, eq));
      const value = eq === -1 ? '' : decode(pair.slice(eq + 1));
      grouped.set(name, [...(grouped.get(name) ?? []), value]);
    }
    for (const [name, values] of grouped)
      queryEntries.push([name, values.length === 1 ? (values[0] as string) : values]);
  }
  return { target, queryEntries };
}

function contentTypeOf(parsed: ParsedCurl): string | undefined {
  return parsed.headers.find((h) => h.name.toLowerCase() === 'content-type')?.value;
}

function buildRequest(
  ctx: Context,
  parsed: ParsedCurl,
  keepHost: boolean,
  indent: number,
  key: string,
): RequestCode {
  const options = ctx.options;
  const shellVars = parsed.variables;
  const authLines: string[] = [];
  const optionEntries: Array<[string, string]> = [];
  const { target, queryEntries } = splitUrl(ctx, parsed, keepHost);

  // ---- auth: turned into the framework's own providers, with the secret read from the environment ----
  const headers = [...parsed.headers];
  const takeHeader = (predicate: (name: string, value: string) => boolean) => {
    const index = headers.findIndex((h) => predicate(h.name.toLowerCase(), h.value));
    return index === -1 ? undefined : headers.splice(index, 1)[0];
  };
  const authHeader = takeHeader((name) => name === 'authorization');
  const fromValueOrEnv = (value: string, fallbackEnv: string) =>
    ctx.inlineSecrets || /\$\{[A-Za-z_]|\{\{/.test(value)
      ? textExpr(ctx, value, shellVars)
      : ctx.env(fallbackEnv);
  if (parsed.basicAuth) {
    ctx.authClasses.add('BasicAuth');
    const user = fromValueOrEnv(parsed.basicAuth.user, 'API_USER');
    const password =
      parsed.basicAuth.password === undefined
        ? ctx.env('API_PASSWORD')
        : fromValueOrEnv(parsed.basicAuth.password, 'API_PASSWORD');
    authLines.push(`apiClient.setAuth(new BasicAuth(${user}, ${password}));`);
  }
  if (authHeader) {
    const bearer = /^bearer\s+(.+)$/i.exec(authHeader.value);
    const basic = /^basic\s+(.+)$/i.exec(authHeader.value);
    if (bearer) {
      ctx.authClasses.add('BearerAuth');
      authLines.push(
        `apiClient.setAuth(new BearerAuth(${fromValueOrEnv(bearer[1] as string, 'API_TOKEN')}));`,
      );
    } else if (basic && !ctx.inlineSecrets && !/\$\{[A-Za-z_]|\{\{/.test(basic[1] as string)) {
      ctx.authClasses.add('BasicAuth');
      authLines.push(
        `apiClient.setAuth(new BasicAuth(${ctx.env('API_USER')}, ${ctx.env('API_PASSWORD')}));`,
      );
      ctx.warn(
        'The Basic credentials in the Authorization header were not written into the test - set API_USER and API_PASSWORD',
      );
    } else {
      headers.unshift(authHeader); // some other scheme: keep as a header, value from the environment below
    }
  }
  const apiKeyHeader = takeHeader(
    (name) => name === 'x-api-key' || name === 'api-key' || name === 'apikey',
  );
  if (apiKeyHeader) {
    ctx.authClasses.add('ApiKeyAuth');
    authLines.push(
      `apiClient.setAuth(new ApiKeyAuth(${quote(apiKeyHeader.name)}, ${fromValueOrEnv(apiKeyHeader.value, 'API_KEY')}));`,
    );
  }
  if (parsed.cookie !== undefined) headers.push({ name: 'Cookie', value: parsed.cookie });

  // ---- body ----
  const type = contentTypeOf(parsed);
  const typeLower = (type ?? '').toLowerCase();
  const dropContentType = () => {
    const index = headers.findIndex((h) => h.name.toLowerCase() === 'content-type');
    if (index !== -1) headers.splice(index, 1);
  };

  if (parsed.form.length > 0) {
    const entries: Array<[string, string]> = parsed.form.map((field): [string, string] => {
      if (field.file) {
        const parts = [`filePath: ${quote(field.value)}`];
        if (field.fileName) parts.push(`fileName: ${quote(field.fileName)}`);
        if (field.mimeType) parts.push(`mimeType: ${quote(field.mimeType)}`);
        return [field.name, `{ ${parts.join(', ')} }`];
      }
      return [field.name, namedValueExpr(ctx, field.name, field.value, shellVars)];
    });
    optionEntries.push(['multipart', objectLiteral(entries, indent + 1, ctx.lazy)]);
    dropContentType();
  } else if (parsed.bodyFile !== undefined) {
    ctx.usesFs = true;
    const file = quote(parsed.bodyFile);
    if (parsed.json || typeLower.includes('json')) {
      optionEntries.push(['json', `JSON.parse(fs.readFileSync(${file}, 'utf8'))`]);
      dropContentType();
    } else {
      optionEntries.push(['rawBody', `fs.readFileSync(${file})`]);
    }
  } else if (parsed.body !== undefined) {
    const body = parsed.body;
    let parsedJson: { ok: boolean; value?: unknown } = { ok: false };
    if (parsed.json || typeLower.includes('json') || /^\s*[[{]/.test(body)) {
      try {
        parsedJson = { ok: true, value: JSON.parse(body) };
      } catch {
        parsedJson = { ok: false };
      }
    }
    if (parsedJson.ok) {
      if (!parsed.json && !typeLower.includes('json')) {
        ctx.warn(
          'The body looks like JSON but the command has no JSON Content-Type: curl would have sent it as form-urlencoded. It is sent as JSON here.',
        );
      }
      optionEntries.push(['json', jsonLiteral(ctx, parsedJson.value, shellVars, indent + 1)]);
      if (/^application\/json\s*(;.*)?$/i.test(type ?? '') || !type) dropContentType();
    } else if (typeLower.includes('xml')) {
      optionEntries.push(['xml', textExpr(ctx, body, shellVars)]);
      if (/^application\/xml\s*(;.*)?$/i.test(type ?? '')) dropContentType();
    } else if (
      typeLower.includes('x-www-form-urlencoded') ||
      (!type && /^[^=&\s]+=[^&]*(&[^=&\s]+=[^&]*)*$/.test(body))
    ) {
      const params = new URLSearchParams(body);
      const keys = [...params.keys()];
      if (new Set(keys).size !== keys.length) {
        optionEntries.push(['rawBody', textExpr(ctx, body, shellVars)]);
        ctx.warn(
          'The form body repeats a field name, which a form object cannot hold; it is sent as a raw body',
        );
      } else {
        optionEntries.push([
          'form',
          objectLiteral(
            [...params.entries()].map(([k, v]): [string, string] => [
              k,
              namedValueExpr(ctx, k, v, shellVars),
            ]),
            indent + 1,
            ctx.lazy,
          ),
        ]);
        dropContentType();
      }
    } else {
      optionEntries.push(['rawBody', textExpr(ctx, body, shellVars)]);
    }
  }

  // ---- headers: what is left, without browser noise, secrets from the environment ----
  const kept: Array<[string, string]> = [];
  let dropped = 0;
  for (const header of headers) {
    const lower = header.name.toLowerCase();
    if (lower === 'content-length' || lower === 'host' || lower === 'connection') {
      dropped++;
      continue;
    }
    if (
      !options.keepAllHeaders &&
      NOISE_HEADER.test(header.name) &&
      !(lower === 'user-agent' && parsed.headers.length === 0)
    ) {
      dropped++;
      continue;
    }
    kept.push([header.name, namedValueExpr(ctx, header.name, header.value, shellVars)]);
  }
  if (dropped > 0)
    ctx.warn(
      `Dropped ${dropped} header(s) that describe the client rather than the API (Host, Content-Length, sec-*, User-Agent, Accept-Language ...); use --keep-all-headers to keep them`,
    );

  // ---- query ----
  const query: Array<[string, string]> = queryEntries.map(([name, value]): [string, string] => [
    name,
    Array.isArray(value)
      ? `[${value.map((v) => namedValueExpr(ctx, name, v, shellVars)).join(', ')}]`
      : namedValueExpr(ctx, name, value, shellVars),
  ]);

  const ordered: Array<[string, string]> = [];
  if (kept.length > 0)
    ordered.push([
      'headers',
      ctx.register('headers', key, objectLiteral(kept, indent + 1, ctx.lazy)),
    ]);
  if (query.length > 0)
    ordered.push([
      'queryParams',
      ctx.register('queries', key, objectLiteral(query, indent + 1, ctx.lazy)),
    ]);
  // the one body (json / form / multipart / xml / raw), unless it is read from a file or built from a saved value
  ordered.push(
    ...optionEntries.map(([name, code]): [string, string] => [
      name,
      ctx.register('bodies', key, code),
    ]),
  );
  if (parsed.timeoutSeconds !== undefined)
    ordered.push(['timeoutMs', String(Math.round(parsed.timeoutSeconds * 1000))]);
  if (!parsed.followRedirects && !options.followRedirects) ordered.push(['maxRedirects', '0']);
  if (parsed.insecure)
    ctx.warn(
      'curl -k (insecure TLS) is not applied per request: set IGNORE_HTTPS_ERRORS=true in the .env file for this environment, or pass ignoreHTTPSErrors',
    );

  const method = parsed.method.toLowerCase();
  const verb = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(method)
    ? method
    : undefined;
  const optionsText = ordered.length > 0 ? `, ${objectLiteral(ordered, indent)}` : '';
  const pathCode = ctx.endpoint(textExpr(ctx, target, shellVars), target);
  const call = verb
    ? `apiClient.${verb}(${pathCode}${optionsText})`
    : `apiClient.request(${quote(parsed.method)}, ${pathCode}${optionsText})`;
  if (!verb)
    ctx.warn(
      `HTTP method ${parsed.method} is not one of the ApiClient's verbs; it is sent with apiClient.request()`,
    );
  return { authLines, call };
}

const OK_MESSAGE =
  'Expected a 2xx response but got ${response.status()}\\n${response.text().slice(0, 500)}';

/** `.json.name` for a plain key, `.json['data[0].name']` for a path. */
const access = (key: string) => (IDENTIFIER.test(key) ? `.${key}` : `[${quote(key)}]`);

/** TypeScript source for a value in this repo's style. */
function valueLiteral(value: unknown): string {
  if (typeof value === 'string') return quote(value);
  if (Array.isArray(value)) return `[${value.map(valueLiteral).join(', ')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    return entries.length === 0
      ? '{}'
      : `{ ${entries.map(([k, v]) => `${IDENTIFIER.test(k) ? k : quote(k)}: ${valueLiteral(v)}`).join(', ')} }`;
  }
  return JSON.stringify(value);
}

function assertions(ctx: Context, directives: Directives, key: string): string[] {
  const lines: string[] = [];
  const entry: ExpectedEntry = { json: [], headers: [], headersContain: [], bodyContains: [] };
  const ref = (path: string) => `CONSTANTS.expected.${key}${path}`;
  const objects = ctx.objects;

  // ---- status ----
  const status = directives.expect;
  if (!status || /^2xx$/i.test(status)) {
    lines.push(`expect(response.ok(), \`${OK_MESSAGE}\`).toBe(true);`);
  } else if (/^[1-5]xx$/i.test(status)) {
    const klass = status.charAt(0);
    if (objects) entry.statusClass = klass;
    lines.push(
      `expect(Math.floor(response.status() / 100)).toBe(${objects ? ref('.statusClass') : klass});`,
    );
  } else if (status.includes(',')) {
    const list = `[${status.split(',').join(', ')}]`;
    if (objects) entry.status = list;
    lines.push(`expect(${objects ? ref('.status') : list}).toContain(response.status());`);
  } else {
    if (objects) entry.status = status;
    lines.push(
      `expect(response.status(), \`Unexpected status; body: \${response.text().slice(0, 500)}\`).toBe(${objects ? ref('.status') : status});`,
    );
  }

  // ---- body fields ----
  for (const check of directives.expectJson) {
    if (check.present) {
      lines.push(`expect(response.has(${quote(check.path)})).toBe(true);`);
      continue;
    }
    const matcher = check.value !== null && typeof check.value === 'object' ? 'toEqual' : 'toBe';
    if (objects) entry.json.push([check.path, valueLiteral(check.value)]);
    lines.push(
      `expect(response.get(${quote(check.path)})).${matcher}(${objects ? ref(`.json${access(check.path)}`) : valueLiteral(check.value)});`,
    );
  }
  // ---- headers ----
  for (const header of directives.expectHeader) {
    const name = header.name.toLowerCase();
    if (objects)
      (header.contains ? entry.headersContain : entry.headers).push([name, quote(header.value)]);
    const expected = objects
      ? ref(`.${header.contains ? 'headersContain' : 'headers'}${access(name)}`)
      : quote(header.value);
    lines.push(
      `expect(response.header(${quote(header.name)})).${header.contains ? 'toContain' : 'toBe'}(${expected});`,
    );
  }
  directives.expectBodyContains.forEach((text, index) => {
    if (objects) entry.bodyContains.push(quote(text));
    lines.push(
      `expect(response.text()).toContain(${objects ? ref(`.bodyContains[${index}]`) : quote(text)});`,
    );
  });
  if (directives.maxMs !== undefined) {
    if (objects) entry.maxMs = directives.maxMs;
    lines.push(
      `expect(response.durationMs).toBeLessThan(${objects ? ref('.maxMs') : directives.maxMs});`,
    );
  }
  if (directives.schema) {
    ctx.usesFs = true;
    lines.push(
      `response.expectSchema(JSON.parse(fs.readFileSync(${quote(directives.schema)}, 'utf8')));`,
    );
  }
  if (
    objects &&
    (entry.status ||
      entry.statusClass ||
      entry.json.length ||
      entry.headers.length ||
      entry.headersContain.length ||
      entry.bodyContains.length ||
      entry.maxMs !== undefined)
  ) {
    ctx.expected.set(key, entry);
  }
  return lines;
}

function titleOf(entry: CurlEntry): string {
  if (entry.directives.name) return entry.directives.name;
  const url = entry.parsed.url.replace(/^https?:\/\/[^/]+/i, '').replace(/\?.*$/, '') || '/';
  return `${entry.parsed.method} ${url}`;
}

/** The CONSTANTS object: what every command sends (queries, headers, bodies) and what every command expects, named per command. */
function constantsBlock(ctx: Context): string[] {
  const sections: Array<[string, string, string[]]> = [];
  const describe: Record<string, string> = {
    queries: 'query parameters sent',
    headers: 'headers sent (secrets are read from the environment)',
    bodies: 'request bodies sent (secrets are read from the environment)',
  };
  for (const section of ['queries', 'headers', 'bodies']) {
    const entries = ctx.constants.get(section);
    if (!entries || entries.length === 0) continue;
    sections.push([
      section,
      describe[section] as string,
      entries.map((e) => entryCode(e.name, e.code)),
    ]);
  }
  if (ctx.expected.size > 0) {
    const lines = [...ctx.expected.entries()].map(([key, e]) => {
      const fields: string[] = [];
      if (e.status) fields.push(`status: ${e.status}`);
      if (e.statusClass) fields.push(`statusClass: ${e.statusClass}`);
      const group = (name: string, list: Array<[string, string]>) => {
        if (list.length > 0)
          fields.push(
            `${name}: { ${list.map(([k, v]) => `${IDENTIFIER.test(k) ? k : quote(k)}: ${v}`).join(', ')} }`,
          );
      };
      group('json', e.json);
      group('headers', e.headers);
      group('headersContain', e.headersContain);
      if (e.bodyContains.length > 0) fields.push(`bodyContains: [${e.bodyContains.join(', ')}]`);
      if (e.maxMs !== undefined) fields.push(`maxMs: ${e.maxMs}`);
      return `${key}: { ${fields.join(', ')} },`;
    });
    sections.push(['expected', 'what each command checks', lines]);
  }
  if (sections.length === 0) return [];
  return [
    '/** Everything the commands send and expect. Change a value here and every step that uses it follows. */',
    'const CONSTANTS = {',
    ...sections.flatMap(([name, comment, entries]) => [
      `  // ${comment}`,
      `  ${name}: {`,
      ...entries.flatMap((entry) => entry.split('\n').map((line) => `    ${line}`)),
      '  },',
    ]),
    '};',
    '',
  ];
}

/** `name: code,` where a multi-line code (an object) keeps its closing brace aligned. */
function entryCode(name: string, code: string): string {
  return `${name}: ${code},`;
}

/** The ENDPOINTS object: where every call goes. */
function endpointsBlock(ctx: Context): string[] {
  if (ctx.endpoints.size === 0) return [];
  return [
    '/** Where each call goes. When an endpoint moves, change it here. */',
    'const ENDPOINTS = {',
    ...[...ctx.endpoints.entries()].map(([name, code]) => `  ${name}: ${code},`),
    '};',
    '',
  ];
}

function indentLines(lines: string[], pad: string): string[] {
  return lines.flatMap((line) => line.split('\n').map((l) => (l === '' ? '' : `${pad}${l}`)));
}

/** Turns parsed curl commands into a Playwright spec that uses the framework's own `apiClient`, auth providers and assertions. */
export function generateTests(entries: CurlEntry[], options: GenerateOptions): GeneratedTests {
  const ctx = new Context(options, options.params ?? []);
  const tag = options.tag ?? '@api';
  const keepHostAuto = options.keepHost === true;

  // Decide keepHost up front: more than one host in the commands means API_BASE_URL cannot stand for them all.
  const hosts = new Set<string>();
  for (const entry of entries) {
    const raw = entry.parsed.url;
    const origin = /^(https?:\/\/[^/?#]+)/i.exec(raw);
    if (origin) hosts.add((origin[1] as string).toLowerCase());
  }
  const keepHost = keepHostAuto || hosts.size > 1;
  if (hosts.size > 1 && !keepHostAuto)
    ctx.warn(
      `The commands call ${hosts.size} different hosts (${[...hosts].join(', ')}), so full URLs are kept instead of using API_BASE_URL`,
    );

  // Group: flows are consecutive entries sharing a flow name; everything else is its own test.
  type Unit = { flow?: string; entries: CurlEntry[] };
  const units: Unit[] = [];
  for (const entry of entries) {
    const flowName = options.singleFlow
      ? entry.flow ?? options.title ?? path.basename(options.source)
      : entry.flow;
    const last = units[units.length - 1];
    if (flowName !== undefined && last && last.flow === flowName) last.entries.push(entry);
    else units.push({ flow: flowName, entries: [entry] });
  }

  const body: string[] = [];
  const seenTitles = new Map<string, number>();
  const unitTitles = units.map((unit) => {
    const tags = [tag, ...new Set(unit.entries.flatMap((e) => e.directives.tags))]
      .filter(Boolean)
      .join(' ');
    const base = unit.flow !== undefined ? unit.flow : titleOf(unit.entries[0] as CurlEntry);
    const count = (seenTitles.get(base) ?? 0) + 1;
    seenTitles.set(base, count);
    // Playwright refuses two tests with the same title in one file: a repeat gets its line number.
    return `${count === 1 ? base : `${base} (line ${(unit.entries[0] as CurlEntry).line})`} ${tags}`.trim();
  });

  units.forEach((unit, unitIndex) => {
    const title = unitTitles[unitIndex] as string;
    ctx.saved = new Set();
    const lines: string[] = [];
    const isFlow = unit.flow !== undefined;

    if (isFlow) {
      const declared = unit.entries.flatMap((e) => e.directives.save.map((s) => s.variable));
      for (const variable of new Set(declared)) lines.push(`let ${variable} = '';`);
    }
    unit.entries.forEach((entry, entryIndex) => {
      const stepLines: string[] = [];
      ctx.inlineSecrets = entry.directives.inlineSecrets === true;
      const key = ctx.keyFor(entry);
      const request = buildRequest(ctx, entry.parsed, keepHost, 0, key);
      stepLines.push(...request.authLines);
      stepLines.push(`const response = await ${request.call};`);
      stepLines.push(...assertions(ctx, entry.directives, key));
      for (const save of entry.directives.save) {
        if (!isFlow) {
          ctx.warn(
            `"# save: ${save.variable}" above the command on line ${entry.line} was ignored: values are only carried between commands inside a "# flow:"`,
          );
          continue;
        }
        stepLines.push(`${save.variable} = String(response.require(${quote(save.path)}));`);
        ctx.saved.add(save.variable);
      }
      for (const warning of entry.parsed.warnings) ctx.warn(`line ${entry.line}: ${warning}`);
      if (isFlow) {
        lines.push(
          `await test.step(${quote(titleOf(entry).replace(/\s+@\w+/g, '') || `Step ${entryIndex + 1}`)}, async () => {`,
          ...indentLines(stepLines, '  '),
          '});',
        );
      } else {
        lines.push(...stepLines);
      }
    });

    const first = unit.entries[0] as CurlEntry;
    const skipReason = unit.entries.map((e) => e.directives.skip).find(Boolean);
    const declaration = skipReason !== undefined ? 'test.skip' : 'test';
    const origin = `curl ${isFlow ? `commands from line ${first.line}` : `command on line ${first.line}`}`;
    body.push(`// ${origin}${skipReason ? ` - skipped: ${skipReason.replace(/\n/g, ' ')}` : ''}`);
    body.push(`${declaration}(${quote(title)}, async ({ apiClient }) => {`);
    body.push(...indentLines(lines, '  '));
    body.push('});');
    body.push('');
  });

  const testImport = options.testImport ?? '@automation/referenced-automation-api';
  const apiImport = options.apiImport ?? '@automation/referenced-automation-api';
  const imports: string[] = [];
  if (ctx.usesFs) imports.push("import * as fs from 'node:fs';");
  if (ctx.usesEnv)
    imports.push("import { loadEnv } from '@automation/referenced-automation-utils';");
  const authClasses = [...ctx.authClasses].sort();
  if (testImport === apiImport)
    imports.push(
      `import { ${[...authClasses, 'expect', 'test'].join(', ')} } from ${quote(testImport)};`,
    );
  else {
    if (authClasses.length > 0)
      imports.push(`import { ${authClasses.join(', ')} } from ${quote(apiImport)};`);
    imports.push(`import { expect, test } from ${quote(testImport)};`);
  }

  const title = options.title ?? path.basename(options.source).replace(/\.[^.]+$/, '');
  const header = [
    `// Generated by api-curl-to-playwright from ${options.source}.`,
    '// Edit freely - or keep the curl file as the source of truth and regenerate to a new file.',
    ...(ctx.envVars.size > 0
      ? [
          `// Secrets are never written into the test; set these environment variables (e.g. in .env.<ENV>.local): ${[...ctx.envVars].sort().join(', ')}`,
        ]
      : []),
  ];
  const origins = [...ctx.origins].sort();
  if (!keepHost && origins.length > 0)
    header.push(
      `// Requests go to API_BASE_URL - set it to ${origins[0]} to call what the curl file called.`,
    );

  const code = [
    ...header,
    ...imports,
    '',
    ...(ctx.usesEnv ? ['const env = loadEnv();', ''] : []),
    ...constantsBlock(ctx),
    ...endpointsBlock(ctx),
    `test.describe(${quote(title)}, () => {`,
    ...indentLines(body, '  ').slice(0, -1),
    '});',
    '',
  ].join('\n');

  return {
    code,
    tests: units.length,
    envVars: [...ctx.envVars].sort(),
    origins,
    warnings: [...new Set(ctx.warnings)],
  };
}
