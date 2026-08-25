import type { APIRequestContext } from '@playwright/test';
import type { AuthProvider, AuthTarget } from '../auth/authProvider';
import { ApiResponse } from './apiResponse';
import type { HttpMethod, QueryValue, RequestOptions } from './types';
import { toPlaywrightMultipart } from './multipart';
import { toXml } from './xml';

/**
 * The one object every test talks to for API calls: all HTTP methods,
 * header/auth that persists across calls on this client, per-call
 * query/path params and body (JSON/XML/form/multipart), returning an
 * already-parsed, path-traversable ApiResponse.
 */
export class ApiClient {
  private defaultHeaders: Record<string, string> = {};
  private authProvider?: AuthProvider;

  constructor(
    private readonly context: APIRequestContext,
    private readonly baseUrl: string = '',
  ) {}

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

  // ---- path params ----

  /** Substitutes {name} placeholders, e.g. resolvePath('/users/{id}', { id: 42 }) -> '/users/42'. */
  resolvePath(path: string, pathParams?: Record<string, string | number>): string {
    if (!pathParams) return path;
    return path.replace(/\{(\w+)\}/g, (match, key: string) => {
      if (!(key in pathParams)) {
        throw new Error(`Missing path param "${key}" for path "${path}"`);
      }
      return encodeURIComponent(String(pathParams[key]));
    });
  }

  // ---- the core call every verb below delegates to ----

  async request(method: HttpMethod, path: string, options: RequestOptions = {}): Promise<ApiResponse> {
    const resolvedPath = this.resolvePath(path, options.pathParams);
    const url = this.baseUrl ? new URL(resolvedPath, this.baseUrl).toString() : resolvedPath;

    const target: AuthTarget = {
      headers: { ...this.defaultHeaders, ...options.headers },
      queryParams: { ...(options.queryParams ?? {}) },
    };
    if (this.authProvider) {
      await this.authProvider.apply(target);
    }

    const fetchOptions: Parameters<APIRequestContext['fetch']>[1] = {
      method,
      headers: target.headers,
      params: buildSearchParams(target.queryParams),
      timeout: options.timeoutMs,
      failOnStatusCode: options.failOnStatusCode ?? false,
    };

    if (options.json !== undefined) {
      fetchOptions.data = options.json;
    } else if (options.xml !== undefined) {
      fetchOptions.data = typeof options.xml === 'string' ? options.xml : toXml(options.xml);
      fetchOptions.headers = { 'Content-Type': 'application/xml', ...fetchOptions.headers };
    } else if (options.form) {
      fetchOptions.form = options.form;
    } else if (options.multipart) {
      fetchOptions.multipart = toPlaywrightMultipart(options.multipart);
    } else if (options.rawBody !== undefined) {
      fetchOptions.data = options.rawBody;
    }

    const raw = await this.context.fetch(url, fetchOptions);
    return ApiResponse.from(raw);
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
