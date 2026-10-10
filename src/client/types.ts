export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

export type QueryValue = string | number | boolean | Array<string | number | boolean>;

export interface MultipartFile {
  /** File contents. Provide either buffer or filePath, not both. */
  buffer?: Buffer;
  filePath?: string;
  fileName?: string;
  mimeType?: string;
}

export type MultipartValue = string | number | boolean | MultipartFile;

export interface RequestOptions {
  /** Merged on top of the client's default headers for this call only. */
  headers?: Record<string, string>;
  /** ?key=value pairs. Array values are repeated (key=a&key=b). */
  queryParams?: Record<string, QueryValue>;
  /** Substituted into {placeholders} in the path, e.g. { id: 42 } for '/users/{id}'. */
  pathParams?: Record<string, string | number>;
  /** JSON request body - sets Content-Type: application/json. */
  json?: unknown;
  /** XML request body. A string is sent as-is; an object is serialized to XML first. */
  xml?: unknown;
  /** application/x-www-form-urlencoded body. */
  form?: Record<string, string | number | boolean>;
  /** multipart/form-data body - text fields and/or files in the same object. */
  multipart?: Record<string, MultipartValue>;
  /** Raw body escape hatch - used as-is, no Content-Type inference. */
  rawBody?: string | Buffer;
  timeoutMs?: number;
  /** How many redirects to follow (Playwright's default is 20). 0 returns the 3xx response itself - what `curl` does without `-L`. */
  maxRedirects?: number;
  /** Playwright's own retries of a request that failed at the network level (connection reset, ECONNRESET...). Not for HTTP statuses: use `retry` for those. */
  maxRetries?: number;
  /** Accept an invalid/self-signed TLS certificate for this call only. */
  ignoreHTTPSErrors?: boolean;
  /** Sends an `Idempotency-Key` header (a fresh UUID for `true`, or your own string) and makes the call safe to retry even if it is a POST. */
  idempotencyKey?: string | true;
  /** Retry on HTTP statuses / network errors with backoff for this call. Overrides the client's `setRetryPolicy`. `false` turns a client-wide policy off. */
  retry?: RetryPolicy | false;
  /**
   * Playwright throws by default on network-level failures only, never on
   * 4xx/5xx - this framework keeps that behaviour (default false) so
   * response.expectStatus()/status assertions are what gate a test, not an
   * unhandled exception. Set true to opt into Playwright's own throwing
   * behaviour for a single call.
   */
  failOnStatusCode?: boolean;
}

export interface RetryPolicy {
  /** Total tries including the first. Default 3. */
  attempts?: number;
  /** Statuses worth another try. Default 429, 502, 503, 504. A function can decide on the status and headers. */
  onStatus?: number[] | ((status: number, headers: Record<string, string>) => boolean);
  /** Retry when no response arrived at all (connection refused/reset, timeout). Default true. */
  onNetworkError?: boolean;
  /** First wait, doubled each time (with jitter). Default 250 ms. */
  backoffMs?: number;
  /** Longest single wait. Default 5000 ms. */
  maxBackoffMs?: number;
  /** Obey a `Retry-After` header (seconds or HTTP date), capped by maxBackoffMs. Default true. */
  respectRetryAfter?: boolean;
  /** Also retry POST/PATCH. Off by default: repeating a non-idempotent call can do the thing twice. */
  retryUnsafeMethods?: boolean;
}
