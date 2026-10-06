const SENSITIVE_PARAM = /key|token|secret|pass|auth|sig|credential/i;

/**
 * The URL, safe to put in a log line: any query parameter whose name looks
 * like a credential (apiKey, access_token, signature, ...) has its value
 * masked. Needed because ApiKeyAuth can place the key in the query string, so
 * a naive "log the URL" would write live credentials into every CI log.
 */
export function safeUrl(url: string): string {
  try {
    const parsed = new URL(url, 'http://placeholder.invalid');
    for (const key of [...parsed.searchParams.keys()]) {
      if (SENSITIVE_PARAM.test(key)) parsed.searchParams.set(key, '[REDACTED]');
    }
    const isAbsolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(url);
    const search = decodeURIComponent(parsed.search);
    return isAbsolute ? `${parsed.origin}${parsed.pathname}${search}` : `${parsed.pathname}${search}`;
  } catch {
    // Unparseable: drop the query string rather than risk logging a credential in it.
    return url.split('?', 1)[0] ?? '';
  }
}
