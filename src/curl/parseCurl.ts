/**
 * Reads curl commands - the format every API tool can export and every API doc shows - into a plain description of
 * the request. Understands the flags people actually paste: -X, -H, -d / --data* / --json, -F, -u, -b, -A, -e, -G, -I,
 * -L, -k, -m, --url, --oauth2-bearer, with bash quoting ('single', "double", $'ansi-c', backslash continuations,
 * `$VAR` references) and Chrome's "Copy as cURL (cmd)" caret escaping. Flags that do not change the request
 * (-s, -v, -i, --compressed, -o ...) are accepted and ignored; anything else is reported in `warnings` rather than
 * silently dropped.
 */

export interface CurlFormField {
  name: string;
  /** Text value, or a file to upload when `file` is set. */
  value: string;
  file?: boolean;
  mimeType?: string;
  fileName?: string;
}

export interface ParsedCurl {
  method: string;
  /** Exactly as written (may contain `${VAR}` placeholders - see `variables`). */
  url: string;
  headers: Array<{ name: string; value: string }>;
  /** Request body text from -d / --data-raw / --json; undefined when none. `@file` references are in `bodyFile`. */
  body?: string;
  bodyFile?: string;
  /** Each -d / --data-urlencode piece, kept apart so `-d a=1 -d b=2` can become a form object. */
  dataPieces: string[];
  /** --json was used (implies JSON content type and accept). */
  json: boolean;
  form: CurlFormField[];
  basicAuth?: { user: string; password?: string };
  bearerToken?: string;
  cookie?: string;
  /** -G / --get: the data goes in the query string. */
  dataInQuery: boolean;
  head: boolean;
  followRedirects: boolean;
  insecure: boolean;
  timeoutSeconds?: number;
  /** Names of `$VAR` / `${VAR}` references found, resolved from the environment by the generated test. */
  variables: string[];
  warnings: string[];
}

/** Flags that take a value we do not use; the value must still be consumed. */
const IGNORED_WITH_VALUE = new Set([
  '-o',
  '--output',
  '-w',
  '--write-out',
  '--connect-timeout',
  '--retry',
  '--retry-delay',
  '--retry-max-time',
  '-x',
  '--proxy',
  '--cacert',
  '--cert',
  '-E',
  '--key',
  '--limit-rate',
  '--max-redirs',
  '--interface',
  '--resolve',
  '--dns-servers',
  '-T',
  '--upload-file',
  '--http-version',
  '-K',
  '--config',
  '--trace',
  '--trace-ascii',
  '-D',
  '--dump-header',
  '--proxy-user',
  '-U',
  '--user-agent-x',
  '--tlsv1.2-x',
  '--noproxy',
  '--cookie-jar',
  '-c',
  '--range',
  '-r',
  '--header-x',
]);
/** Flags that change nothing about the request. */
const IGNORED_FLAGS = new Set([
  '-s',
  '--silent',
  '-S',
  '--show-error',
  '-v',
  '--verbose',
  '-i',
  '--include',
  '--compressed',
  '-f',
  '--fail',
  '-#',
  '--progress-bar',
  '-N',
  '--no-buffer',
  '--http1.1',
  '--http2',
  '--http2-prior-knowledge',
  '--tcp-nodelay',
  '-g',
  '--globoff',
  '--fail-with-body',
  '-O',
  '--remote-name',
  '--path-as-is',
  '--no-keepalive',
  '--tlsv1.2',
  '--tlsv1.3',
  '--ssl-no-revoke',
  '-sS',
  '-Ss',
  '-vs',
  '-sv',
  '-sk',
  '-ks',
]);

/** Splits a script into the individual curl commands in it (continuations joined, comments and blank lines skipped). */
export function splitCommands(text: string): string[] {
  const normalized = normalizeCmdEscapes(text.replace(/\r\n/g, '\n'));
  const joined = normalized.replace(/\\\n[ \t]*/g, ' ');
  const lines = joined.split('\n');
  const commands: string[] = [];
  let current = '';
  let open: string | undefined; // an open quote spans lines: keep reading until it closes
  for (const line of lines) {
    if (!current && !open && (line.trim() === '' || line.trim().startsWith('#'))) continue;
    current += (current ? '\n' : '') + line;
    open = unclosedQuote(current);
    if (!open) {
      if (/^\s*curl\b/.test(current)) commands.push(current.trim());
      current = '';
    }
  }
  if (current.trim()) commands.push(current.trim());
  return commands;
}

export function unclosedQuote(text: string): string | undefined {
  let quote: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote === "'") {
      if (c === "'") quote = undefined;
    } else if (quote === '"') {
      if (c === '\\') i++;
      else if (c === '"') quote = undefined;
    } else if (quote === "$'") {
      if (c === '\\') i++;
      else if (c === "'") quote = undefined;
    } else if (c === '\\') i++;
    else if (c === "'") quote = "'";
    else if (c === '"') quote = '"';
    else if (c === '$' && text[i + 1] === "'") {
      quote = "$'";
      i++;
    }
  }
  return quote;
}

/** Chrome's "Copy as cURL (cmd)" escapes every special character with ^ and continues lines with ^: undo that. */
export function normalizeCmdEscapes(text: string): string {
  if (!/\^"|\^\r?\n/.test(text)) return text;
  return text.replace(/\^\n/g, ' ').replace(/\^(.)/gs, '$1');
}

export function tokenize(command: string): { tokens: string[]; variables: string[] } {
  const tokens: string[] = [];
  const variables = new Set<string>();
  let current = '';
  let inToken = false;
  let i = 0;
  const pushVar = (name: string) => {
    variables.add(name);
    current += '${' + name + '}';
  };
  while (i < command.length) {
    const c = command[i] as string;
    if (/\s/.test(c)) {
      if (inToken) tokens.push(current);
      current = '';
      inToken = false;
      i++;
      continue;
    }
    inToken = true;
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      if (end === -1) throw new Error('Unterminated single quote in curl command');
      current += command.slice(i + 1, end);
      i = end + 1;
    } else if (c === '$' && command[i + 1] === "'") {
      i += 2;
      while (i < command.length && command[i] !== "'") {
        if (command[i] === '\\') {
          const next = command[i + 1] as string;
          const simple: Record<string, string> = {
            n: '\n',
            t: '\t',
            r: '\r',
            '\\': '\\',
            "'": "'",
            '"': '"',
          };
          if (next === 'u' || next === 'x') {
            const length = next === 'u' ? 4 : 2;
            current += String.fromCharCode(parseInt(command.slice(i + 2, i + 2 + length), 16));
            i += 2 + length;
          } else {
            current += simple[next] ?? next;
            i += 2;
          }
        } else {
          current += command[i];
          i++;
        }
      }
      i++;
    } else if (c === '"') {
      i++;
      while (i < command.length && command[i] !== '"') {
        if (command[i] === '\\' && /["\\$`]/.test(command[i + 1] ?? '')) {
          current += command[i + 1];
          i += 2;
        } else if (command[i] === '$' && /[A-Za-z_{]/.test(command[i + 1] ?? '')) {
          i = readVariable(command, i, pushVar);
        } else {
          current += command[i];
          i++;
        }
      }
      if (i >= command.length) throw new Error('Unterminated double quote in curl command');
      i++;
    } else if (c === '\\') {
      current += command[i + 1] ?? '';
      i += 2;
    } else if (c === '$' && /[A-Za-z_{]/.test(command[i + 1] ?? '')) {
      i = readVariable(command, i, pushVar);
    } else {
      current += c;
      i++;
    }
  }
  if (inToken) tokens.push(current);
  return { tokens, variables: [...variables] };
}

function readVariable(text: string, start: number, push: (name: string) => void): number {
  if (text[start + 1] === '{') {
    const end = text.indexOf('}', start);
    push(text.slice(start + 2, end).split(/[:-]/)[0] as string);
    return end + 1;
  }
  const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(start + 1)) as RegExpExecArray;
  push(match[0]);
  return start + 1 + match[0].length;
}

export function parseCurl(command: string): ParsedCurl {
  const { tokens, variables } = tokenize(command);
  if (tokens[0] !== 'curl') throw new Error(`Not a curl command: ${command.slice(0, 60)}`);
  const result: ParsedCurl = {
    method: '',
    url: '',
    headers: [],
    dataPieces: [],
    json: false,
    form: [],
    dataInQuery: false,
    head: false,
    followRedirects: false,
    insecure: false,
    variables,
    warnings: [],
  };
  let explicitMethod: string | undefined;
  const positional: string[] = [];

  for (let i = 1; i < tokens.length; i++) {
    let flag = tokens[i] as string;
    let inline: string | undefined;
    const eq = /^(--[a-z0-9-]+)=([\s\S]*)$/.exec(flag);
    if (eq) {
      flag = eq[1] as string;
      inline = eq[2];
    } else if (/^-[A-Za-z]/.test(flag) && flag.length > 2 && !IGNORED_FLAGS.has(flag)) {
      // -XPOST, -H'x: y', -d@file: a short flag with its value attached. (Bundles of switches like -sSL are handled below.)
      const first = flag.slice(0, 2);
      if (/^-[XHdFubAemxoTcDrwKUE]$/.test(first)) {
        inline = flag.slice(2);
        flag = first;
      } else if (/^-[sSvikLGIfgNO#]+$/.test(flag)) {
        for (const ch of flag.slice(1)) tokens.splice(i + 1, 0, `-${ch}`);
        continue;
      }
    }
    const value = (): string => {
      if (inline !== undefined) return inline;
      const next = tokens[++i];
      if (next === undefined) throw new Error(`curl: ${flag} needs a value`);
      return next;
    };

    switch (flag) {
      case '-X':
      case '--request':
        explicitMethod = value().toUpperCase();
        break;
      case '-H':
      case '--header': {
        const header = value();
        const colon = header.indexOf(':');
        if (colon === -1) {
          if (header.endsWith(';')) result.headers.push({ name: header.slice(0, -1), value: '' });
          else result.warnings.push(`Header "${header}" has no colon and was ignored`);
        } else {
          const name = header.slice(0, colon).trim();
          const headerValue = header.slice(colon + 1).trim();
          if (headerValue === '')
            result.warnings.push(
              `curl "-H '${name}:'" removes a default header; there is none to remove, so it was ignored`,
            );
          else result.headers.push({ name, value: headerValue });
        }
        break;
      }
      case '-d':
      case '--data':
      case '--data-ascii':
      case '--data-raw':
      case '--data-binary': {
        const data = value();
        if (flag !== '--data-raw' && data.startsWith('@')) result.bodyFile = data.slice(1);
        else result.dataPieces.push(data);
        break;
      }
      case '--data-urlencode': {
        const data = value();
        const eqIndex = data.indexOf('=');
        const encoded =
          eqIndex === -1
            ? encodeURIComponent(data)
            : `${data.slice(0, eqIndex) ? `${data.slice(0, eqIndex)}=` : ''}${encodeURIComponent(data.slice(eqIndex + 1))}`;
        result.dataPieces.push(encoded);
        break;
      }
      case '--json': {
        const data = value();
        if (data.startsWith('@')) result.bodyFile = data.slice(1);
        else result.dataPieces.push(data);
        result.json = true;
        break;
      }
      case '-F':
      case '--form':
      case '--form-string': {
        const field = value();
        const separator = field.indexOf('=');
        if (separator === -1) {
          result.warnings.push(`Form field "${field}" has no "=" and was ignored`);
          break;
        }
        const name = field.slice(0, separator);
        let fieldValue = field.slice(separator + 1);
        if (flag !== '--form-string' && fieldValue.startsWith('@')) {
          const parts = fieldValue.slice(1).split(';');
          const entry: CurlFormField = { name, value: parts[0] as string, file: true };
          for (const part of parts.slice(1)) {
            const [k, v] = part.split('=');
            if (k === 'type') entry.mimeType = v;
            if (k === 'filename') entry.fileName = v;
          }
          result.form.push(entry);
        } else {
          if (fieldValue.startsWith('<')) fieldValue = fieldValue.slice(1);
          result.form.push({ name, value: fieldValue });
        }
        break;
      }
      case '-u':
      case '--user': {
        const credentials = value();
        const colon = credentials.indexOf(':');
        result.basicAuth =
          colon === -1
            ? { user: credentials }
            : { user: credentials.slice(0, colon), password: credentials.slice(colon + 1) };
        break;
      }
      case '--oauth2-bearer':
        result.bearerToken = value();
        break;
      case '-b':
      case '--cookie':
        result.cookie = value();
        break;
      case '-A':
      case '--user-agent':
        result.headers.push({ name: 'User-Agent', value: value() });
        break;
      case '-e':
      case '--referer':
        result.headers.push({ name: 'Referer', value: value() });
        break;
      case '-G':
      case '--get':
        result.dataInQuery = true;
        break;
      case '-I':
      case '--head':
        result.head = true;
        break;
      case '-L':
      case '--location':
      case '--location-trusted':
        result.followRedirects = true;
        break;
      case '-k':
      case '--insecure':
        result.insecure = true;
        break;
      case '-m':
      case '--max-time': {
        const seconds = Number(value());
        if (Number.isFinite(seconds)) result.timeoutSeconds = seconds;
        break;
      }
      case '--url':
        positional.push(value());
        break;
      default:
        if (IGNORED_FLAGS.has(flag)) break;
        if (IGNORED_WITH_VALUE.has(flag)) {
          value();
          break;
        }
        if (flag.startsWith('-')) {
          result.warnings.push(`Unsupported curl option ${flag} was ignored`);
          break;
        }
        positional.push(flag);
    }
  }

  if (positional.length === 0) throw new Error('curl command has no URL');
  if (positional.length > 1)
    result.warnings.push(`Several URLs given; only the first (${positional[0]}) was used`);
  result.url = positional[0] as string;

  const hasBodyData = result.dataPieces.length > 0 || result.bodyFile !== undefined;
  if (result.dataInQuery && result.dataPieces.length > 0) {
    // -G: the data is the query string, not a body.
    const query = result.dataPieces.join('&');
    result.url += (result.url.includes('?') ? '&' : '?') + query;
    result.dataPieces = [];
  } else if (result.dataPieces.length > 0) {
    result.body = result.json ? result.dataPieces.join('') : result.dataPieces.join('&');
  }

  if (result.head) result.method = 'HEAD';
  else if (explicitMethod) result.method = explicitMethod;
  else if (result.form.length > 0 || (hasBodyData && !result.dataInQuery)) result.method = 'POST';
  else result.method = 'GET';

  if (
    result.bearerToken !== undefined &&
    !result.headers.some((h) => h.name.toLowerCase() === 'authorization')
  ) {
    result.headers.push({ name: 'Authorization', value: `Bearer ${result.bearerToken}` });
  }
  return result;
}
