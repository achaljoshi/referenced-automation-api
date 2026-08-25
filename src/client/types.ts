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
  /**
   * Playwright throws by default on network-level failures only, never on
   * 4xx/5xx - this framework keeps that behaviour (default false) so
   * response.expectStatus()/status assertions are what gate a test, not an
   * unhandled exception. Set true to opt into Playwright's own throwing
   * behaviour for a single call.
   */
  failOnStatusCode?: boolean;
}
