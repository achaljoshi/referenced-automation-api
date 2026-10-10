import { test as playwrightTest, type APIRequestContext } from '@playwright/test';
import {
  getCorrelationId,
  getLogger,
  newCorrelationId,
} from '@automation/referenced-automation-utils';
import type { AuthProvider, AuthTarget, AuthTransport } from '../auth/authProvider';
import { ApiResponse } from './apiResponse';
import type { HttpMethod, QueryValue, RequestOptions, RetryPolicy } from './types';
import { safeUrl, scrubUrls } from './logging';
import {
  describeExchange,
  isCredentialHeader,
  redactBody,
  redactHeaders,
  truncate,
  type Exchange,
} from './exchange';
import { pollUntil, sleep, type PollOptions } from '../util/poll';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import { toPlaywrightMultipart } from './multipart';
import { toXml } from './xml';

/**
 * The one object every test talks to for API calls: all HTTP methods,
 * header/auth that persists across calls on this client, per-call
 * query/path params and body (JSON/XML/form/multipart), returning an
 * already-parsed, path-traversable ApiResponse.
 */
/** Sent on every request so one flow can be traced across this client, the gateway, and the target system's logs. */
export const CORRELATION_HEADER = 'X-Correlation-Id';

const log = getLogger('api');

/** Shared by a client and every client scoped from it, so one place sees all the calls a test made. */
interface ExchangeLog {
  entries: Exchange[];
  listeners: Array<(exchange: Exchange) => void>;
}

const MAX_LOGGED_EXCHANGES = 200;
const IDEMPOTENT_METHODS = new Set<HttpMethod>(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);
const DEFAULT_RETRY_STATUSES = [429, 502, 503, 504];

export interface ScopeOverrides {
  baseUrl?: string;
  headers?: Record<string, string>;
  /** A different auth strategy, or `null` to send no auth. Omit to keep this client's. */
  auth?: AuthProvider | null;
  retry?: RetryPolicy;
  /** Do not inherit this client's default headers that carry a credential (Authorization, Cookie, X-Api-Key ...) - for "another user" clients. */
  dropCredentialHeaders?: boolean;
}

/** `path` is a full URL (`https://host/x` or `//host/x`) rather than a path under the base URL. */
const ABSOLUTE_URL = /^(?:[a-z][a-z0-9+.-]*:)?\/\//i;

/** The base URL and a path joined with exactly one slash, keeping the base URL's own path (`https://h/api/v1` + `/users` -> `https://h/api/v1/users`). `new URL('/users', base)` would drop `/api/v1`. */
export function joinUrl(baseUrl: string, path: string): string {
  const split = path.search(/[?#]/);
  const pathPart = split === -1 ? path : path.slice(0, split);
  const rest = split === -1 ? '' : path.slice(split);
  return `${baseUrl.replace(/\/+$/, '')}/${pathPart.replace(/^\/+/, '')}${rest}`;
}

/** The URL without its query string (and fragment), and that query as parameters - repeated names become arrays. */
function splitQuery(full: string): { url: string; inlineQuery: Record<string, QueryValue> } {
  const start = full.indexOf('?');
  const hash = full.indexOf('#');
  if (start === -1 || (hash !== -1 && hash < start))
    return { url: hash === -1 ? full : full.slice(0, hash), inlineQuery: {} };
  const inlineQuery: Record<string, QueryValue> = {};
  for (const [name, value] of new URLSearchParams(
    full.slice(start + 1, hash === -1 ? undefined : hash),
  )) {
    const existing = inlineQuery[name];
    inlineQuery[name] =
      existing === undefined ? value : [...(Array.isArray(existing) ? existing : [existing]), value];
  }
  return { url: full.slice(0, start), inlineQuery };
}

/** Records a call that needed more than one try as a test annotation, so a "passing" test that leaned on retries shows up in the report. */
function annotateRetries(logged: string, outcomes: string[]): void {
  if (outcomes.length <= 1) return;
  try {
    const retries = outcomes.length - 1;
    playwrightTest.info().annotations.push({
      type: 'api-retries',
      description: `${logged}: ${retries} ${retries === 1 ? 'retry' : 'retries'} (${outcomes.join(', ')})`,
    });
  } catch {
    // not inside a Playwright test (a global setup, a script): nowhere to annotate
  }
}

export class ApiClient {
  private defaultHeaders: Record<string, string> = {};
  private authProvider?: AuthProvider;
  private retryPolicy?: RetryPolicy;
  private exchangeLog: ExchangeLog = { entries: [], listeners: [] };

  constructor(
    private readonly context: APIRequestContext,
    private baseUrl: string = '',
  ) {}

  // ---- base URL ----

  setBaseUrl(baseUrl: string): this {
    this.baseUrl = baseUrl;
    return this;
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  // ---- header CRUD (persists across every request made by this client) ----

  setHeader(name: string, value: string): this {
    this.defaultHeaders[name] = value;
    return this;
  }

  setHeaders(headers: Record<string, string>): this {
    Object.assign(this.defaultHeaders, headers);
    return this;
  }

  getHeader(name: string): string | undefined {
    return this.defaultHeaders[name];
  }

  removeHeader(name: string): this {
    delete this.defaultHeaders[name];
    return this;
  }

  clearHeaders(): this {
    this.defaultHeaders = {};
    return this;
  }

  // ---- auth ----

  setAuth(provider: AuthProvider): this {
    this.authProvider = provider;
    return this;
  }

  clearAuth(): this {
    this.authProvider = undefined;
    return this;
  }

  // ---- retry policy ----

  /** Retry throttled/unavailable responses and network errors with backoff on every call of this client (a per-call `retry` option overrides it). */
  setRetryPolicy(policy: RetryPolicy | undefined): this {
    this.retryPolicy = policy;
    return this;
  }

  // ---- exchange log: every call this client (and clients scoped from it) made ----

  /** The calls made so far (newest last), headers and bodies with credentials masked. A failed test attaches these to its report. */
  exchanges(): readonly Exchange[] {
    return this.exchangeLog.entries;
  }

  clearExchanges(): this {
    this.exchangeLog.entries.length = 0;
    return this;
  }

  /** Called for every exchange as it completes. Returns a function that stops listening. */
  onExchange(listener: (exchange: Exchange) => void): () => void {
    this.exchangeLog.listeners.push(listener);
    return () => {
      this.exchangeLog.listeners = this.exchangeLog.listeners.filter((l) => l !== listener);
    };
  }

  /**
   * A client that shares this one's connection and exchange log but has its own headers/auth/base URL - for "the same
   * API as another user" or "the same API with one different header" without mutating the client other steps use.
   */
  scoped(overrides: ScopeOverrides = {}): ApiClient {
    const child = new ApiClient(this.context, overrides.baseUrl ?? this.baseUrl);
    child.defaultHeaders = {
      ...Object.fromEntries(
        Object.entries(this.defaultHeaders).filter(
          ([name]) => !(overrides.dropCredentialHeaders && isCredentialHeader(name)),
        ),
      ),
      ...overrides.headers,
    };
    child.authProvider = overrides.auth === null ? undefined : overrides.auth ?? this.authProvider;
    child.retryPolicy = overrides.retry ?? this.retryPolicy;
    child.exchangeLog = this.exchangeLog;
    return child;
  }

  /** The same client (headers, auth, retry policy, exchange log) on a different connection - used by `apiFor`, rarely needed directly. */
  withContext(context: APIRequestContext): ApiClient {
    const child = new ApiClient(context, this.baseUrl);
    child.defaultHeaders = { ...this.defaultHeaders };
    child.authProvider = this.authProvider;
    child.retryPolicy = this.retryPolicy;
    child.exchangeLog = this.exchangeLog;
    return child;
  }

  // ---- path params ----

  /** Substitutes {name} placeholders, e.g. resolvePath('/users/{id}', { id: 42 }) -> '/users/42'. A placeholder with no value throws: `/users/{id}` must never be sent as it is. */
  resolvePath(path: string, pathParams?: Record<string, string | number>): string {
    return path.replace(/\{(\w+)\}/g, (match, key: string) => {
      if (!pathParams || !(key in pathParams)) {
        throw new Error(`Missing path param "${key}" for path "${path}"`);
      }
      return encodeURIComponent(String(pathParams[key]));
    });
  }

  /**
   * The URL a call goes to: the path joined to the base URL, keeping the base URL's own path prefix. A full URL in
   * place of a path is refused unless the call says `absoluteUrl: true` - it would take the client's auth and headers
   * to whatever host it names.
   */
  private resolveUrl(resolvedPath: string, options: RequestOptions): string {
    if (ABSOLUTE_URL.test(resolvedPath)) {
      if (!options.absoluteUrl)
        throw new Error(
          `Refusing to send to the full URL ${safeUrl(resolvedPath)}: a path is relative to the base URL (${this.baseUrl || 'none set'}), and a full URL would receive this client's auth and headers. Pass { absoluteUrl: true } to call another host on purpose.`,
        );
      return resolvedPath;
    }
    return this.baseUrl ? joinUrl(this.baseUrl, resolvedPath) : resolvedPath;
  }

  /** What an auth provider calls its identity provider with: this client's own connection, so proxy/TLS/timeout match and the call shows in `exchanges()` (credentials masked). */
  private authTransport(): AuthTransport {
    return {
      post: async (request) => {
        const startedAt = Date.now();
        const contentType = request.form ? 'application/x-www-form-urlencoded' : 'application/json';
        const bodyText = request.form
          ? new URLSearchParams(request.form).toString()
          : JSON.stringify(request.json);
        const exchange: Exchange = {
          method: 'POST',
          url: safeUrl(request.url),
          requestHeaders: { 'Content-Type': contentType },
          requestBody: redactBody(bodyText, contentType),
          durationMs: 0,
          attempt: 1,
          at: new Date().toISOString(),
        };
        try {
          const raw = await this.context.fetch(request.url, {
            method: 'POST',
            ...(request.form ? { form: request.form } : { data: request.json }),
            timeout: request.timeoutMs,
            failOnStatusCode: false,
            maxRedirects: request.followRedirects === false ? 0 : undefined,
          });
          const text = await raw.text();
          exchange.durationMs = Date.now() - startedAt;
          exchange.status = raw.status();
          exchange.responseHeaders = redactHeaders(raw.headers());
          exchange.responseBody = truncate(redactBody(text, raw.headers()['content-type']) ?? '');
          this.record(exchange);
          log.info(`POST ${exchange.url} -> ${exchange.status} (${exchange.durationMs}ms) [auth]`);
          return {
            status: raw.status(),
            headers: raw.headers(),
            setCookies: raw
              .headersArray()
              .filter((header) => header.name.toLowerCase() === 'set-cookie')
              .map((header) => header.value),
            text,
          };
        } catch (error) {
          exchange.durationMs = Date.now() - startedAt;
          exchange.error = scrubUrls(error instanceof Error ? error.message : String(error));
          this.record(exchange);
          log.error(`POST ${exchange.url} FAILED (${exchange.durationMs}ms) [auth]: ${exchange.error}`);
          throw error;
        }
      },
    };
  }

  // ---- the core call every verb below delegates to ----

  async request(
    method: HttpMethod,
    path: string,
    options: RequestOptions = {},
  ): Promise<ApiResponse> {
    const resolvedPath = this.resolvePath(path, options.pathParams);
    const { url, inlineQuery } = splitQuery(this.resolveUrl(resolvedPath, options));

    const target: AuthTarget = {
      headers: { ...this.defaultHeaders, ...options.headers },
      // a query written in the path (`/search?a=1`) and `queryParams` are one query: Playwright would let `params` replace the former
      queryParams: { ...inlineQuery, ...(options.queryParams ?? {}) },
    };
    // Use the test's active correlation ID when there is one (so every call a
    // test makes shares it); otherwise mint one for this request alone. A
    // header the caller set explicitly always wins.
    const hasCorrelationHeader = Object.keys(target.headers).some(
      (h) => h.toLowerCase() === CORRELATION_HEADER.toLowerCase(),
    );
    if (!hasCorrelationHeader)
      target.headers[CORRELATION_HEADER] = getCorrelationId() ?? newCorrelationId();
    if (
      options.idempotencyKey !== undefined &&
      !Object.keys(target.headers).some((h) => h.toLowerCase() === 'idempotency-key')
    ) {
      target.headers['Idempotency-Key'] =
        options.idempotencyKey === true ? randomUUID() : options.idempotencyKey;
    }
    const correlationId = Object.entries(target.headers).find(
      ([h]) => h.toLowerCase() === CORRELATION_HEADER.toLowerCase(),
    )?.[1];
    // What the server will see as the path (base URL prefix included) - the thing a signing provider must sign.
    const sentPath = new URL(url, 'http://placeholder.invalid').pathname;
    const applyAuth = async (to: AuthTarget): Promise<void> => {
      if (!this.authProvider) return;
      to.method = method;
      to.path = sentPath;
      to.body = bodyAsText(options);
      to.transport = this.authTransport();
      await this.authProvider.apply(to);
    };
    await applyAuth(target);

    const fetchOptions: Parameters<APIRequestContext['fetch']>[1] = {
      method,
      headers: target.headers,
      params: buildSearchParams(target.queryParams),
      timeout: options.timeoutMs,
      failOnStatusCode: options.failOnStatusCode ?? false,
      maxRedirects: options.maxRedirects,
      maxRetries: options.maxRetries,
      ignoreHTTPSErrors: options.ignoreHTTPSErrors,
    };

    let loggedBody: string | undefined;
    let defaultContentType: string | undefined;
    if (options.json !== undefined) {
      fetchOptions.data = options.json;
      loggedBody = JSON.stringify(options.json);
    } else if (options.xml !== undefined) {
      fetchOptions.data = typeof options.xml === 'string' ? options.xml : toXml(options.xml);
      defaultContentType = 'application/xml';
      fetchOptions.headers = { 'Content-Type': defaultContentType, ...fetchOptions.headers };
      loggedBody = fetchOptions.data as string;
    } else if (options.form) {
      fetchOptions.form = options.form;
      loggedBody = new URLSearchParams(
        Object.entries(options.form).map(([k, v]): [string, string] => [k, String(v)]),
      ).toString();
    } else if (options.multipart) {
      fetchOptions.multipart = toPlaywrightMultipart(options.multipart);
      loggedBody = `[multipart: ${Object.keys(options.multipart).join(', ')}]`;
    } else if (options.rawBody !== undefined) {
      fetchOptions.data = options.rawBody;
      loggedBody =
        typeof options.rawBody === 'string'
          ? options.rawBody
          : `[binary: ${options.rawBody.length} bytes]`;
    }

    const query = buildSearchParams(target.queryParams).toString();
    const fullUrl = query ? `${url}${url.includes('?') ? '&' : '?'}${query}` : url;
    const logged = `${method} ${safeUrl(fullUrl)}`;
    const contentType = Object.entries(fetchOptions.headers ?? {}).find(
      ([h]) => h.toLowerCase() === 'content-type',
    )?.[1];
    const policy = this.resolveRetry(method, options);
    const cid = String(correlationId).slice(0, 8);
    const outcomes: string[] = [];
    let reauthenticated = false;

    for (let attempt = 1; ; attempt++) {
      const startedAt = Date.now();
      const exchange: Exchange = {
        method,
        url: safeUrl(fullUrl),
        requestHeaders: redactHeaders(fetchOptions.headers as Record<string, string>),
        requestBody: redactBody(loggedBody, contentType),
        durationMs: 0,
        attempt,
        at: new Date().toISOString(),
      };
      try {
        const raw = await this.context.fetch(url, fetchOptions);
        exchange.durationMs = Date.now() - startedAt;
        exchange.status = raw.status();
        exchange.responseHeaders = redactHeaders(raw.headers());
        const response = await ApiResponse.from(raw, { durationMs: exchange.durationMs, exchange });
        exchange.responseBody = truncate(
          redactBody(response.text(), exchange.responseHeaders['content-type']) ?? '',
        );
        this.record(exchange);
        // The session or token expired: drop it, log in again and send this request once more (not a retry-policy attempt).
        if (
          response.status() === 401 &&
          !reauthenticated &&
          this.authProvider?.reauthenticate &&
          (await this.authProvider.reauthenticate())
        ) {
          reauthenticated = true;
          log.warn(`${logged} answered 401 - authenticating again and retrying once`);
          await applyAuth(target); // overwrites the Authorization / Cookie it set the first time
          fetchOptions.headers = defaultContentType
            ? { 'Content-Type': defaultContentType, ...target.headers }
            : target.headers;
          fetchOptions.params = buildSearchParams(target.queryParams);
          attempt--;
          continue;
        }
        outcomes.push(String(response.status()));
        log.info(
          `${logged} -> ${response.status()} (${exchange.durationMs}ms) cid=${cid}${attempt > 1 ? ` attempt ${attempt}` : ''}`,
        );
        if (
          policy &&
          attempt < policy.attempts &&
          policy.shouldRetryStatus(response.status(), response.headers())
        ) {
          const wait = policy.waitMs(attempt, response.headers());
          log.warn(
            `${logged} answered ${response.status()} - retrying in ${wait}ms (attempt ${attempt + 1} of ${policy.attempts})`,
          );
          await sleep(wait);
          continue;
        }
        annotateRetries(logged, outcomes);
        return response;
      } catch (error) {
        exchange.durationMs = Date.now() - startedAt;
        exchange.error = scrubUrls(error instanceof Error ? error.message : String(error));
        outcomes.push('network error');
        this.record(exchange);
        log.error(`${logged} FAILED (${exchange.durationMs}ms) cid=${cid}: ${exchange.error}`);
        if (policy && policy.onNetworkError && attempt < policy.attempts) {
          const wait = policy.waitMs(attempt, {});
          log.warn(
            `${logged} had no response - retrying in ${wait}ms (attempt ${attempt + 1} of ${policy.attempts})`,
          );
          await sleep(wait);
          continue;
        }
        annotateRetries(logged, outcomes);
        throw error;
      }
    }
  }

  private record(exchange: Exchange): void {
    const { entries, listeners } = this.exchangeLog;
    entries.push(exchange);
    if (entries.length > MAX_LOGGED_EXCHANGES) entries.shift();
    for (const listener of listeners) listener(exchange);
  }

  /** The effective retry policy for one call, or undefined when there is none (or the method is not safe to repeat). */
  private resolveRetry(method: HttpMethod, options: RequestOptions) {
    const configured = options.retry === false ? undefined : options.retry ?? this.retryPolicy;
    if (!configured) return undefined;
    const safe =
      IDEMPOTENT_METHODS.has(method) ||
      configured.retryUnsafeMethods === true ||
      options.idempotencyKey !== undefined;
    if (!safe) return undefined;
    const attempts = Math.max(1, configured.attempts ?? 3);
    const backoffMs = configured.backoffMs ?? 250;
    const maxBackoffMs = configured.maxBackoffMs ?? 5000;
    const onStatus = configured.onStatus ?? DEFAULT_RETRY_STATUSES;
    return {
      attempts,
      onNetworkError: configured.onNetworkError ?? true,
      shouldRetryStatus: (status: number, headers: Record<string, string>) =>
        typeof onStatus === 'function' ? onStatus(status, headers) : onStatus.includes(status),
      waitMs: (attempt: number, headers: Record<string, string>) => {
        if (configured.respectRetryAfter !== false) {
          const hinted = parseRetryAfter(headers['retry-after']);
          if (hinted !== undefined) return Math.min(hinted, maxBackoffMs);
        }
        const exponential = Math.min(backoffMs * 2 ** (attempt - 1), maxBackoffMs);
        return Math.round(exponential * (0.75 + Math.random() * 0.5));
      },
    };
  }

  get(path: string, options?: RequestOptions): Promise<ApiResponse> {
    return this.request('GET', path, options);
  }

  post(path: string, options?: RequestOptions): Promise<ApiResponse> {
    return this.request('POST', path, options);
  }

  put(path: string, options?: RequestOptions): Promise<ApiResponse> {
    return this.request('PUT', path, options);
  }

  patch(path: string, options?: RequestOptions): Promise<ApiResponse> {
    return this.request('PATCH', path, options);
  }

  delete(path: string, options?: RequestOptions): Promise<ApiResponse> {
    return this.request('DELETE', path, options);
  }

  head(path: string, options?: RequestOptions): Promise<ApiResponse> {
    return this.request('HEAD', path, options);
  }

  options(path: string, options?: RequestOptions): Promise<ApiResponse> {
    return this.request('OPTIONS', path, options);
  }

  // ---- conveniences built on request() ----

  /** GET that must succeed (2xx), returning the parsed body typed as T. A failure shows the status and body. */
  async getJson<T = unknown>(path: string, options?: RequestOptions): Promise<T> {
    const response = await this.get(path, options);
    response.expectStatusInRange(200, 299);
    return response.body<T>();
  }

  /** GET that must succeed (2xx), returning the raw text. */
  async getText(path: string, options?: RequestOptions): Promise<string> {
    const response = await this.get(path, options);
    response.expectStatusInRange(200, 299);
    return response.text();
  }

  /** GET a file: returns the bytes (not corrupted by text decoding) and, when `saveTo` is given, writes them there (folders are created). */
  async download(
    path: string,
    options: RequestOptions & { saveTo?: string } = {},
  ): Promise<Buffer> {
    const { saveTo, ...requestOptions } = options;
    const response = await this.get(path, requestOptions);
    response.expectStatusInRange(200, 299);
    const bytes = await response.bytes();
    if (saveTo) {
      fs.mkdirSync(nodePath.dirname(nodePath.resolve(saveTo)), { recursive: true });
      fs.writeFileSync(saveTo, bytes);
      log.info(`Saved ${bytes.length} bytes to ${saveTo}`);
    }
    return bytes;
  }

  /** A GraphQL call: POSTs `{ query, variables, operationName }` as JSON (default endpoint /graphql). Check `response.expectNoGraphqlErrors()` - GraphQL reports failures with a 200. */
  graphql(
    query: string,
    variables?: Record<string, unknown>,
    options: RequestOptions & { operationName?: string; path?: string } = {},
  ): Promise<ApiResponse> {
    const { operationName, path, ...requestOptions } = options;
    return this.post(path ?? '/graphql', {
      ...requestOptions,
      json: { query, variables, ...(operationName ? { operationName } : {}) },
    });
  }

  /** A SOAP call: wraps `body` (the XML inside the Body element) in an envelope and sets Content-Type / SOAPAction for SOAP 1.1 (default) or 1.2. */
  soap(
    path: string,
    options: RequestOptions & {
      action: string;
      body: string;
      version?: '1.1' | '1.2';
      headerXml?: string;
    },
  ): Promise<ApiResponse> {
    const { action, body, version, headerXml, ...requestOptions } = options;
    const v12 = version === '1.2';
    const ns = v12
      ? 'http://www.w3.org/2003/05/soap-envelope'
      : 'http://schemas.xmlsoap.org/soap/envelope/';
    const envelope = `<?xml version="1.0" encoding="UTF-8"?><soap:Envelope xmlns:soap="${ns}">${headerXml ? `<soap:Header>${headerXml}</soap:Header>` : ''}<soap:Body>${body}</soap:Body></soap:Envelope>`;
    const headers: Record<string, string> = v12
      ? { 'Content-Type': `application/soap+xml; charset=utf-8; action="${action}"` }
      : { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: `"${action}"` };
    return this.post(path, {
      ...requestOptions,
      headers: { ...headers, ...requestOptions.headers },
      rawBody: envelope,
    });
  }

  /**
   * Repeats a request until `until(response)` is true - for the things an API does in the background. Returns the
   * response that satisfied it; on timeout throws PollTimeoutError carrying the last response.
   *
   *   const done = await client.poll('GET', '/jobs/{id}', { pathParams: { id }, until: (r) => r.get('state') === 'DONE' });
   */
  poll(
    method: HttpMethod,
    path: string,
    options: RequestOptions &
      PollOptions & { until: (response: ApiResponse) => boolean | Promise<boolean> },
  ): Promise<ApiResponse> {
    const { until, timeoutMs, intervalsMs, description, ...requestOptions } = options;
    return pollUntil(() => this.request(method, path, requestOptions), until, {
      timeoutMs,
      intervalsMs,
      description: description ?? `${method} ${path}`,
    });
  }

  /** Logs a one-line summary of every exchange so far (for debugging a flow from the console). */
  logExchanges(): void {
    for (const exchange of this.exchangeLog.entries) log.info(describeExchange(exchange));
  }
}

/** The body as text, for providers that sign it. Multipart and binary bodies have no stable text form, so they sign as empty. */
function bodyAsText(options: RequestOptions): string | undefined {
  if (options.json !== undefined) return JSON.stringify(options.json);
  if (options.xml !== undefined)
    return typeof options.xml === 'string' ? options.xml : toXml(options.xml);
  if (options.form)
    return new URLSearchParams(
      Object.entries(options.form).map(([k, v]): [string, string] => [k, String(v)]),
    ).toString();
  if (typeof options.rawBody === 'string') return options.rawBody;
  return undefined;
}

function parseRetryAfter(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function buildSearchParams(queryParams: Record<string, QueryValue>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(queryParams)) {
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, String(item));
    } else {
      params.append(key, String(value));
    }
  }
  return params;
}
