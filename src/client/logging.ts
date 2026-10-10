const SENSITIVE_PARAM = /key|token|secret|pass|auth|sig|credential/i;

/** A path segment that names a credential, so an opaque-looking segment after it is one (`/reset/token/<value>`). */
const SECRET_PATH_WORD = /^(tokens?|keys?|api-?keys?|secrets?|passwords?|sessions?|bearer|otp|pin|credentials?)$/i;
const JWT_SEGMENT = /^eyJ[\w-]+\.[\w-]+\.[\w-]*$/;
const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * True when a URL path segment looks like a credential rather than a resource id: a JWT, an opaque segment (10+
 * characters with a digit) right after a word like `token` / `key` / `secret` - `/token/refresh` and `/keys/42` are
 * plain endpoints - or a long opaque string mixing letters and digits (not a UUID, and not a 24-character id such
 * as a MongoDB ObjectId, which is how most resources are named). A heuristic: it errs towards hiding a value in a
 * log over printing a live token.
 */
export function isTokenLikeSegment(segment: string, previous?: string): boolean {
  if (segment === '') return false;
  if (
    previous !== undefined &&
    SECRET_PATH_WORD.test(previous) &&
    /^[\w\-+=~.]{10,}$/.test(segment) &&
    /\d/.test(segment)
  )
    return true;
  if (JWT_SEGMENT.test(segment)) return true;
  if (UUID_SEGMENT.test(segment)) return false;
  return /^[A-Za-z0-9_\-+=~]{32,}$/.test(segment) && /[A-Za-z]/.test(segment) && /\d/.test(segment);
}

/** The path with every token-like segment replaced by `[REDACTED]`. */
export function maskPathTokens(pathname: string): string {
  const segments = pathname.split('/');
  return segments
    .map((segment, index) => {
      let decoded = segment;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        // keep the encoded form
      }
      return isTokenLikeSegment(decoded, segments[index - 1]) ? '[REDACTED]' : segment;
    })
    .join('/');
}

/**
 * The URL, safe to put in a log line: any query parameter whose name looks
 * like a credential (apiKey, access_token, signature, ...) has its value
 * masked, and so does a path segment that looks like a token (`/reset/<token>`).
 * Needed because ApiKeyAuth can place the key in the query string, so
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
    const pathname = maskPathTokens(parsed.pathname);
    return isAbsolute ? `${parsed.origin}${pathname}${search}` : `${pathname}${search}`;
  } catch {
    // Unparseable: drop the query string rather than risk logging a credential in it.
    return url.split('?', 1)[0] ?? '';
  }
}

/** Free text (an error message) with every URL in it passed through `safeUrl`. */
export function scrubUrls(text: string): string {
  return text.replace(/https?:\/\/[^\s'"<>)\]]+/gi, (url) => safeUrl(url));
}
