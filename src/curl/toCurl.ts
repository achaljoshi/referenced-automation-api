import { redactHeaders } from '../client/exchange';

export interface CurlRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
}

/** Single-quotes a shell word: the one quoting that needs no other escaping except for the quote itself. */
function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The curl command for a request - to paste into a terminal, a bug report, or `api-curl-to-playwright`
 * (which reads it back into a test). Credentials are masked unless `redact: false`, so a command taken from a
 * CI log never leaks them; the masked value (`[REDACTED]`) is obviously a placeholder to replace.
 */
export function toCurl(request: CurlRequest, options: { redact?: boolean } = {}): string {
  const headers =
    options.redact === false ? request.headers ?? {} : redactHeaders(request.headers ?? {});
  const parts = ['curl', '-X', request.method.toUpperCase(), quote(request.url)];
  for (const [name, value] of Object.entries(headers)) parts.push('-H', quote(`${name}: ${value}`));
  if (request.body !== undefined) parts.push('--data-raw', quote(request.body));
  return parts.join(' ');
}
