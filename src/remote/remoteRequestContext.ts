import type { APIRequestContext, APIResponse } from '@playwright/test';
import { remote } from '@automation/referenced-automation-utils';
import { safeUrl } from '../client/logging';

/** Said by every refusal: the call has to be made from the test machine, where the full Playwright context exists. */
const RUN_LOCALLY = 'Run this call from the test machine instead (the normal `apiClient` fixture, without API_VIA_REMOTE).';

/** What went wrong with a call made on the remote host. `code` is the `RemoteError` code, when there was one. */
export class RemoteRequestError extends Error {
  readonly code?: remote.RemoteErrorCode;

  constructor(message: string, options: { code?: remote.RemoteErrorCode; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = 'RemoteRequestError';
    this.code = options.code;
    Object.setPrototypeOf(this, RemoteRequestError.prototype);
  }
}

/** The part of Playwright's `APIRequestContext` options a remote call can honour. Anything else is refused. */
export interface RemoteRequestContextOptions {
  baseURL?: string;
  extraHTTPHeaders?: Record<string, string>;
  ignoreHTTPSErrors?: boolean;
  /** Default per-request timeout in ms (Playwright's default is 30 000; 0 means no timeout there and here the agent default). */
  timeout?: number;
  /** Let the host's proxy settings apply. Default false: the host reaches internal APIs directly. */
  useProxy?: boolean;
  // Refused with a clear error when set, so a copied `use` block never silently loses them.
  storageState?: unknown;
  clientCertificates?: unknown;
  httpCredentials?: unknown;
  proxy?: unknown;
}

/** The per-call options of `fetch` that are understood. */
export interface RemoteFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  params?: URLSearchParams | Record<string, string | number | boolean>;
  data?: string | Buffer | object | number | boolean;
  form?: Record<string, string | number | boolean>;
  multipart?: unknown;
  timeout?: number;
  failOnStatusCode?: boolean;
  maxRedirects?: number;
  maxRetries?: number;
  ignoreHTTPSErrors?: boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;

function headerKey(headers: Record<string, string>, name: string): string | undefined {
  return Object.keys(headers).find((key) => key.toLowerCase() === name);
}

/** Several `Set-Cookie` values are joined with ", " on the wire; a comma inside an `Expires` date is not a separator. */
function splitSetCookie(joined: string): string[] {
  return joined.split(/,\s*(?=[^;,=\s]+=)/);
}

/** The response of a call made on the remote host: the members of Playwright's `APIResponse` that `ApiResponse` and the auth providers use. */
export class RemoteApiResponse {
  private readonly bytes: Buffer;
  private readonly lowerHeaders: Record<string, string> = {};

  constructor(private readonly reply: remote.RemoteHttpResponse) {
    this.bytes = remote.decodeBody(reply);
    for (const [name, value] of Object.entries(reply.headers ?? {})) this.lowerHeaders[name.toLowerCase()] = value;
  }

  status(): number {
    return this.reply.status;
  }

  statusText(): string {
    return this.reply.statusText;
  }

  ok(): boolean {
    return this.reply.status >= 200 && this.reply.status <= 299;
  }

  url(): string {
    return this.reply.url;
  }

  headers(): Record<string, string> {
    return { ...this.lowerHeaders };
  }

  headersArray(): Array<{ name: string; value: string }> {
    return Object.entries(this.lowerHeaders).flatMap(([name, value]) =>
      name === 'set-cookie' ? splitSetCookie(value).map((one) => ({ name, value: one })) : [{ name, value }],
    );
  }

  async body(): Promise<Buffer> {
    return this.bytes;
  }

  async text(): Promise<string> {
    return this.bytes.toString('utf8');
  }

  async json(): Promise<unknown> {
    return JSON.parse(this.bytes.toString('utf8'));
  }

  async dispose(): Promise<void> {
    // nothing is held: the body is already in memory
  }
}

/** The message for a failed remote operation; names the operation and, for the known codes, what to do. */
function describeRemoteError(error: remote.RemoteError, what: string): string {
  switch (error.code) {
    case 'DENIED':
      return `remote host operation "http" was denied (${what}): REMOTE_ALLOW must include http - add it (for example REMOTE_ALLOW=http,db,sap).`;
    case 'AGENT_STALE':
      return `remote host operation "http" failed (${what}) with AGENT_STALE: the agent on the remote host stopped answering. The RDP session was probably closed, disconnected or logged off - keep it connected and see agent.log in the mailbox folder. ${error.message}`;
    case 'TIMEOUT':
      return `remote host operation "http" timed out (${what}) with TIMEOUT: ${error.message}`;
    default:
      return `remote host operation "http" failed (${what}) with ${error.code}: ${error.message}`;
  }
}

/**
 * An object that stands in for Playwright's `APIRequestContext` and sends each request through `RemoteHost.http()`, so
 * the call is made FROM the remote desktop host (which can reach APIs the test machine cannot). Hand it to
 * `new ApiClient(context.asApiRequestContext(), baseUrl)`: everything ApiClient does (auth providers, retries, polling,
 * the masked exchange log) works the same.
 *
 * Only what ApiClient needs is implemented: `fetch`, `get/post/put/patch/delete/head`, `dispose`. Things that cannot
 * cross the mailbox (multipart uploads, storageState, client certificates ...) throw an error that says to run that
 * call from the test machine.
 */
export class RemoteRequestContext {
  constructor(
    private readonly host: remote.RemoteHost,
    private readonly options: RemoteRequestContextOptions = {},
  ) {
    for (const key of ['storageState', 'clientCertificates', 'httpCredentials', 'proxy'] as const)
      if (options[key] !== undefined)
        throw new RemoteRequestError(
          `The remote request context does not support "${key}": it cannot be applied to a call made on the remote host. ${RUN_LOCALLY}`,
        );
  }

  /** For `new ApiClient(...)`, whose constructor is typed with Playwright's context. */
  asApiRequestContext(): APIRequestContext {
    return this as unknown as APIRequestContext;
  }

  async fetch(urlOrRequest: string | { url(): string }, options: RemoteFetchOptions = {}): Promise<APIResponse> {
    if (typeof urlOrRequest !== 'string')
      throw new RemoteRequestError(`The remote request context sends a URL string, not a Request object. ${RUN_LOCALLY}`);
    if (options.multipart !== undefined)
      throw new RemoteRequestError(
        `multipart/form-data uploads are not supported on the remote host (files cannot cross the mailbox). ${RUN_LOCALLY}`,
      );

    let url = this.resolveUrl(urlOrRequest);
    const query = this.queryOf(options.params);
    if (query) url += `${url.includes('?') ? '&' : '?'}${query}`;

    const headers: Record<string, string> = { ...this.options.extraHTTPHeaders, ...options.headers };
    const { body, contentType } = this.encodeBody(options, headers);
    if (contentType && headerKey(headers, 'content-type') === undefined) headers['Content-Type'] = contentType;

    const timeoutMs = options.timeout && options.timeout > 0 ? options.timeout : this.options.timeout || DEFAULT_TIMEOUT_MS;
    const request: remote.RemoteHttpRequest = {
      method: (options.method ?? 'GET').toUpperCase(),
      url,
      headers,
      timeoutMs,
      followRedirects: options.maxRedirects !== 0,
      ignoreTlsErrors: options.ignoreHTTPSErrors ?? this.options.ignoreHTTPSErrors ?? false,
      useProxy: this.options.useProxy ?? false,
    };
    if (body !== undefined) request.bodyBase64 = remote.encodeBody(body);

    const what = `${request.method} ${safeUrl(url)}`;
    const reply = await this.send(request, what, options.maxRetries ?? 0);
    const response = new RemoteApiResponse(reply);
    if (options.failOnStatusCode && !response.ok())
      throw new RemoteRequestError(`${response.status()} ${response.statusText()} (${what} on the remote host)`);
    return response as unknown as APIResponse;
  }

  /** Playwright's `maxRetries` retries network failures only (never an HTTP status): the same here, for failures of the call itself. */
  private async send(request: remote.RemoteHttpRequest, what: string, maxRetries: number): Promise<remote.RemoteHttpResponse> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.host.http(request);
      } catch (error) {
        if (error instanceof remote.RemoteError) {
          if (error.code === 'REMOTE_ERROR' && attempt < maxRetries) continue;
          throw new RemoteRequestError(describeRemoteError(error, what), { code: error.code, cause: error });
        }
        throw error;
      }
    }
  }

  get(url: string, options: RemoteFetchOptions = {}): Promise<APIResponse> {
    return this.fetch(url, { ...options, method: 'GET' });
  }
  post(url: string, options: RemoteFetchOptions = {}): Promise<APIResponse> {
    return this.fetch(url, { ...options, method: 'POST' });
  }
  put(url: string, options: RemoteFetchOptions = {}): Promise<APIResponse> {
    return this.fetch(url, { ...options, method: 'PUT' });
  }
  patch(url: string, options: RemoteFetchOptions = {}): Promise<APIResponse> {
    return this.fetch(url, { ...options, method: 'PATCH' });
  }
  delete(url: string, options: RemoteFetchOptions = {}): Promise<APIResponse> {
    return this.fetch(url, { ...options, method: 'DELETE' });
  }
  head(url: string, options: RemoteFetchOptions = {}): Promise<APIResponse> {
    return this.fetch(url, { ...options, method: 'HEAD' });
  }

  async storageState(): Promise<never> {
    throw new RemoteRequestError(`storageState is not supported on the remote host (cookies live on the host, not here). ${RUN_LOCALLY}`);
  }

  /** Nothing to release: the shared RemoteHost belongs to the worker (see the `remoteHost` fixture). */
  async dispose(): Promise<void> {
    // the host is closed by closeRemoteHost(), not per context
  }

  private resolveUrl(url: string): string {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return url;
    if (!this.options.baseURL)
      throw new RemoteRequestError(`"${url}" is not a full URL and the remote request context has no base URL.`);
    return `${this.options.baseURL.replace(/\/+$/, '')}/${url.replace(/^\/+/, '')}`;
  }

  private queryOf(params: RemoteFetchOptions['params']): string {
    if (!params) return '';
    if (params instanceof URLSearchParams) return params.toString();
    return new URLSearchParams(Object.entries(params).map(([name, value]): [string, string] => [name, String(value)])).toString();
  }

  private encodeBody(
    options: RemoteFetchOptions,
    headers: Record<string, string>,
  ): { body?: string | Buffer; contentType?: string } {
    if (options.form !== undefined) {
      const form = new URLSearchParams(Object.entries(options.form).map(([name, value]): [string, string] => [name, String(value)]));
      return { body: form.toString(), contentType: 'application/x-www-form-urlencoded' };
    }
    const data = options.data;
    if (data === undefined) return {};
    if (Buffer.isBuffer(data)) return { body: data };
    if (typeof data === 'string') {
      const type = headers[headerKey(headers, 'content-type') ?? ''];
      if (type?.includes('json')) {
        try {
          JSON.parse(data);
          return { body: data };
        } catch {
          return { body: JSON.stringify(data) };
        }
      }
      return { body: data };
    }
    return { body: JSON.stringify(data), contentType: 'application/json' };
  }
}
