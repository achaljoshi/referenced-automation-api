import { safeUrl } from './logging';

/** One request/response pair as the client saw it - what a failed test attaches to its report, and what `toCurl` turns into a runnable command. */
export interface Exchange {
  method: string;
  /** Absolute URL including the query string. Credentials in the query are masked. */
  url: string;
  /** Request headers, with credential values masked. */
  requestHeaders: Record<string, string>;
  /** The body as sent (credentials inside a JSON/form body masked), if there was one and it is text. */
  requestBody?: string;
  /** Undefined when no response arrived (network error). */
  status?: number;
  responseHeaders?: Record<string, string>;
  /** Truncated. */
  responseBody?: string;
  durationMs: number;
  /** 1 for the first try, 2+ when the retry policy tried again. */
  attempt: number;
  error?: string;
  at: string;
}

const SENSITIVE_HEADER =
  /authorization|cookie|token|secret|api[-_]?key|password|credential|signature/i;
const SENSITIVE_FIELD =
  /pass(word|wd|code)?|secret|token|api[-_]?key|credential|authorization|signature/i;
export const REDACTED = '[REDACTED]';

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      SENSITIVE_HEADER.test(name) ? REDACTED : value,
    ]),
  );
}

/** Masks the value of every key that looks like a credential, at any depth. */
export function redactFields<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => redactFields(item)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        SENSITIVE_FIELD.test(key) && typeof item === 'string' ? REDACTED : redactFields(item),
      ]),
    ) as T;
  }
  return value;
}

/** A request body as text with credentials masked: JSON and form bodies are parsed and masked by field name, anything else is left as is. */
export function redactBody(
  body: string | undefined,
  contentType: string | undefined,
): string | undefined {
  if (body === undefined) return undefined;
  const type = (contentType ?? '').toLowerCase();
  try {
    if (type.includes('json') || /^\s*[[{]/.test(body))
      return JSON.stringify(redactFields(JSON.parse(body)));
    if (type.includes('x-www-form-urlencoded')) {
      const params = new URLSearchParams(body);
      for (const key of [...params.keys()])
        if (SENSITIVE_FIELD.test(key)) params.set(key, REDACTED);
      return params.toString();
    }
  } catch {
    // not parseable: fall through and return it untouched
  }
  return body;
}

const MAX_BODY = 2000;

export function truncate(text: string, max = MAX_BODY): string {
  return text.length > max
    ? `${text.slice(0, max)}... [${text.length - max} more characters]`
    : text;
}

export function describeExchange(exchange: Exchange): string {
  const target = safeUrl(exchange.url);
  if (exchange.error)
    return `${exchange.method} ${target} FAILED after ${exchange.durationMs}ms: ${exchange.error}`;
  return `${exchange.method} ${target} -> ${exchange.status} (${exchange.durationMs}ms)`;
}

/** A readable, redacted text version of exchanges - the attachment on a failed test. */
export function formatExchanges(exchanges: Exchange[]): string {
  return exchanges
    .map((exchange, index) => {
      const lines = [
        `#${index + 1} ${exchange.at}  ${describeExchange(exchange)}${exchange.attempt > 1 ? `  (attempt ${exchange.attempt})` : ''}`,
      ];
      for (const [name, value] of Object.entries(exchange.requestHeaders))
        lines.push(`  > ${name}: ${value}`);
      if (exchange.requestBody !== undefined)
        lines.push(`  > body: ${truncate(exchange.requestBody)}`);
      for (const [name, value] of Object.entries(exchange.responseHeaders ?? {}))
        lines.push(`  < ${name}: ${SENSITIVE_HEADER.test(name) ? REDACTED : value}`);
      if (exchange.responseBody !== undefined)
        lines.push(`  < body: ${truncate(exchange.responseBody)}`);
      return lines.join('\n');
    })
    .join('\n\n');
}
