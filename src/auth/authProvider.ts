import { createHash, createHmac } from 'node:crypto';
import type { QueryValue } from '../client/types';

/** What an AuthProvider is allowed to mutate before a request goes out. */
export interface AuthTarget {
  headers: Record<string, string>;
  queryParams: Record<string, QueryValue>;
  /** Request method, path and body as text - for providers that sign the request (HmacAuth). Set by ApiClient. */
  method?: string;
  path?: string;
  body?: string;
  /** How a provider that has to call an identity provider (token, login) makes that call. Set by ApiClient: the call goes through the client's own connection (proxy, TLS, timeout) and shows in its exchange log. */
  transport?: AuthTransport;
}

export interface AuthProvider {
  apply(target: AuthTarget): Promise<void> | void;
  /**
   * Called by ApiClient when a request answered 401. Drop whatever credential was cached and return true if a fresh one
   * could help; the client then re-applies the provider and sends the request once more (once per request).
   */
  reauthenticate?(): Promise<boolean> | boolean;
}

/** A POST to an identity provider: a form (or JSON) body, no redirects followed unless asked. */
export interface AuthRequest {
  url: string;
  form?: Record<string, string>;
  json?: unknown;
  timeoutMs: number;
  followRedirects?: boolean;
}

export interface AuthReply {
  status: number;
  /** Lower-case names. */
  headers: Record<string, string>;
  /** Every Set-Cookie, one entry each. */
  setCookies: string[];
  text: string;
}

export interface AuthTransport {
  post(request: AuthRequest): Promise<AuthReply>;
}

const DEFAULT_AUTH_TIMEOUT_MS = 30_000;

/**
 * What a provider uses when it is called outside an ApiClient (no `target.transport`): the global `fetch`, with a
 * timeout. It does not know the project's proxy or TLS settings - inside an ApiClient the call goes through the
 * client's connection instead.
 */
const fetchTransport: AuthTransport = {
  async post(request) {
    const where = (() => {
      try {
        const url = new URL(request.url);
        return `${url.origin}${url.pathname}`;
      } catch {
        return 'the identity provider';
      }
    })();
    let response: Response;
    try {
      response = await fetch(request.url, {
        method: 'POST',
        headers: {
          'Content-Type': request.form ? 'application/x-www-form-urlencoded' : 'application/json',
        },
        body: request.form
          ? new URLSearchParams(request.form).toString()
          : JSON.stringify(request.json),
        redirect: request.followRedirects === false ? 'manual' : 'follow',
        signal: AbortSignal.timeout(request.timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError')
        throw new Error(`Request to ${where} timed out after ${request.timeoutMs}ms`);
      throw new Error(
        `Request to ${where} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      setCookies: response.headers.getSetCookie(),
      text: await response.text(),
    };
  },
};

function transportOf(target: AuthTarget): AuthTransport {
  return target.transport ?? fetchTransport;
}

/** `text` with every secret value in it masked. */
function scrub(text: string, secrets: Array<string | undefined>): string {
  let out = text;
  for (const secret of secrets) if (secret) out = out.split(secret).join('[REDACTED]');
  return out;
}

/**
 * A failure message that never echoes the identity provider's body: only the standard OAuth `error` and
 * `error_description`, cut short, with the credentials we sent masked in case the provider repeats them.
 */
function failure(what: string, reply: AuthReply, secrets: Array<string | undefined>): Error {
  let detail = '';
  try {
    const json = JSON.parse(reply.text) as { error?: unknown; error_description?: unknown };
    detail = [json.error, json.error_description]
      .filter((part): part is string => typeof part === 'string')
      .join(': ');
  } catch {
    // not JSON: say nothing about the body
  }
  detail = scrub(detail, secrets).slice(0, 200);
  return new Error(`${what} failed: ${reply.status}${detail ? ` (${detail})` : ''}`);
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

function readToken(what: string, reply: AuthReply, secrets: Array<string | undefined>): TokenResponse {
  if (reply.status < 200 || reply.status > 299) throw failure(what, reply, secrets);
  let json: Partial<TokenResponse> | undefined;
  try {
    json = JSON.parse(reply.text) as Partial<TokenResponse>;
  } catch {
    throw new Error(`${what} answered ${reply.status} but not with JSON`);
  }
  if (typeof json?.access_token !== 'string' || json.access_token === '')
    throw new Error(`${what} answered ${reply.status} without an access_token`);
  return json as TokenResponse;
}

export class BasicAuth implements AuthProvider {
  constructor(
    private readonly username: string,
    private readonly password: string,
  ) {}

  apply(target: AuthTarget): void {
    const encoded = Buffer.from(`${this.username}:${this.password}`).toString('base64');
    target.headers.Authorization = `Basic ${encoded}`;
  }
}

export class BearerAuth implements AuthProvider {
  constructor(private readonly token: string | (() => string | Promise<string>)) {}

  async apply(target: AuthTarget): Promise<void> {
    const token = typeof this.token === 'function' ? await this.token() : this.token;
    target.headers.Authorization = `Bearer ${token}`;
  }
}

export type ApiKeyLocation = 'header' | 'query';

export class ApiKeyAuth implements AuthProvider {
  constructor(
    private readonly name: string,
    private readonly value: string,
    private readonly location: ApiKeyLocation = 'header',
  ) {}

  apply(target: AuthTarget): void {
    if (this.location === 'header') {
      target.headers[this.name] = this.value;
    } else {
      target.queryParams[this.name] = this.value;
    }
  }
}

export interface OAuth2ClientCredentialsOptions {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope?: string;
  /** How early to refresh before expiry, in seconds. Default 30. */
  refreshSkewSeconds?: number;
  /** Give up on the token request after this long. Default 30 s. */
  timeoutMs?: number;
}

/**
 * OAuth2 client-credentials flow: fetches an access token from `tokenUrl`
 * the first time it's needed, then reuses it (auto-refreshing shortly
 * before it expires) rather than fetching a new token on every request.
 */
export class OAuth2ClientCredentials implements AuthProvider {
  private cachedToken?: string;
  private expiresAtMs = 0;
  private inflight?: Promise<string>;

  constructor(private readonly options: OAuth2ClientCredentialsOptions) {}

  async apply(target: AuthTarget): Promise<void> {
    const token = await this.getToken(target);
    target.headers.Authorization = `Bearer ${token}`;
  }

  /** One token request at a time: calls that arrive while it is out wait for it instead of each fetching their own. */
  private getToken(target: AuthTarget): Promise<string> {
    const skewMs = (this.options.refreshSkewSeconds ?? 30) * 1000;
    if (this.cachedToken && Date.now() < this.expiresAtMs - skewMs) {
      return Promise.resolve(this.cachedToken);
    }
    this.inflight ??= this.fetchToken(target).finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async fetchToken(target: AuthTarget): Promise<string> {
    const reply = await transportOf(target).post({
      url: this.options.tokenUrl,
      form: {
        grant_type: 'client_credentials',
        client_id: this.options.clientId,
        client_secret: this.options.clientSecret,
        ...(this.options.scope ? { scope: this.options.scope } : {}),
      },
      timeoutMs: this.options.timeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS,
    });
    const json = readToken('OAuth2 client-credentials token request', reply, [
      this.options.clientSecret,
    ]);
    this.cachedToken = json.access_token;
    this.expiresAtMs = Date.now() + (json.expires_in ?? 3600) * 1000;
    return this.cachedToken;
  }
}

/** Applies several providers in order - e.g. an API key for the gateway plus a bearer token for the service behind it. */
export class CompositeAuth implements AuthProvider {
  private readonly providers: AuthProvider[];

  constructor(...providers: AuthProvider[]) {
    this.providers = providers;
  }

  async apply(target: AuthTarget): Promise<void> {
    for (const provider of this.providers) await provider.apply(target);
  }
}

export interface OAuth2PasswordOptions {
  tokenUrl: string;
  username: string;
  password: string;
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  /** How early to refresh before expiry, in seconds. Default 30. */
  refreshSkewSeconds?: number;
  /** Give up on a token request after this long. Default 30 s. */
  timeoutMs?: number;
}

/**
 * OAuth2 resource-owner password grant (a user's own login, for APIs that still use it): fetches a token the first
 * time, reuses it until shortly before it expires, then uses the refresh token when the server issued one (falling
 * back to logging in again).
 */
export class OAuth2PasswordAuth implements AuthProvider {
  private accessToken?: string;
  private refreshToken?: string;
  private expiresAtMs = 0;
  private inflight?: Promise<string>;

  constructor(private readonly options: OAuth2PasswordOptions) {}

  async apply(target: AuthTarget): Promise<void> {
    target.headers.Authorization = `Bearer ${await this.token(target)}`;
  }

  /**
   * One refresh/login at a time: a refresh token is usually single-use (rotation), so two parallel requests that each
   * tried to use it would make the second one fail and fall back to a full login.
   */
  private token(target: AuthTarget): Promise<string> {
    const skewMs = (this.options.refreshSkewSeconds ?? 30) * 1000;
    if (this.accessToken && Date.now() < this.expiresAtMs - skewMs)
      return Promise.resolve(this.accessToken);
    this.inflight ??= this.renew(target).finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async renew(target: AuthTarget): Promise<string> {
    if (this.refreshToken) {
      try {
        return await this.fetchToken(target, {
          grant_type: 'refresh_token',
          refresh_token: this.refreshToken,
        });
      } catch {
        this.refreshToken = undefined; // expired or revoked: log in again below
      }
    }
    return this.fetchToken(target, {
      grant_type: 'password',
      username: this.options.username,
      password: this.options.password,
    });
  }

  private async fetchToken(target: AuthTarget, grant: Record<string, string>): Promise<string> {
    const reply = await transportOf(target).post({
      url: this.options.tokenUrl,
      form: {
        ...grant,
        ...(this.options.clientId ? { client_id: this.options.clientId } : {}),
        ...(this.options.clientSecret ? { client_secret: this.options.clientSecret } : {}),
        ...(this.options.scope ? { scope: this.options.scope } : {}),
      },
      timeoutMs: this.options.timeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS,
    });
    const json = readToken(`OAuth2 ${grant.grant_type} grant`, reply, [
      this.options.password,
      this.options.clientSecret,
      grant.refresh_token,
    ]);
    this.accessToken = json.access_token;
    this.refreshToken = json.refresh_token ?? this.refreshToken;
    this.expiresAtMs = Date.now() + (json.expires_in ?? 3600) * 1000;
    return this.accessToken;
  }
}

export interface JwtAuthOptions {
  /** Shared secret for HS256. */
  secret: string;
  /** Claims in the token, e.g. { sub: 'ada', roles: ['admin'] }. `iat` and `exp` are added. */
  claims: Record<string, unknown>;
  /** Token lifetime in seconds. Default 300. */
  expiresInSeconds?: number;
  /** Header the token is sent in, with `Bearer ` prefix. Default Authorization. */
  header?: string;
}

const base64Url = (input: Buffer | string) => Buffer.from(input).toString('base64url');

/** A self-signed HS256 JWT built per request - for services in a test environment that trust a shared secret instead of an identity provider. */
export class JwtAuth implements AuthProvider {
  constructor(private readonly options: JwtAuthOptions) {}

  apply(target: AuthTarget): void {
    const issuedAt = Math.floor(Date.now() / 1000);
    const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const payload = base64Url(
      JSON.stringify({
        iat: issuedAt,
        exp: issuedAt + (this.options.expiresInSeconds ?? 300),
        ...this.options.claims,
      }),
    );
    const signature = base64Url(
      createHmac('sha256', this.options.secret).update(`${header}.${payload}`).digest(),
    );
    target.headers[this.options.header ?? 'Authorization'] =
      `Bearer ${header}.${payload}.${signature}`;
  }
}

export interface HmacAuthOptions {
  /** Identifies the key to the server, sent in `keyHeader`. */
  keyId: string;
  secret: string;
  keyHeader?: string;
  signatureHeader?: string;
  timestampHeader?: string;
  /** What gets signed. Default `${timestamp}\n${METHOD}\n${path+query}\n${sha256(body)}`. */
  canonicalize?: (parts: {
    timestamp: string;
    method: string;
    pathAndQuery: string;
    bodyHash: string;
  }) => string;
}

/**
 * Request signing for APIs that verify an HMAC-SHA256 signature over the request (webhook-style and many partner
 * APIs): adds the key id, a timestamp and the signature as headers. The signature covers the method, path, query and
 * a hash of the body, so it needs the request's body and method: set `target.method` / `target.body` (ApiClient does).
 */
export class HmacAuth implements AuthProvider {
  constructor(private readonly options: HmacAuthOptions) {}

  apply(target: AuthTarget): void {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const query = new URLSearchParams(
      Object.entries(target.queryParams).flatMap(([k, v]) =>
        Array.isArray(v)
          ? v.map((i): [string, string] => [k, String(i)])
          : [[k, String(v)] as [string, string]],
      ),
    ).toString();
    const pathAndQuery = `${target.path ?? ''}${query ? `?${query}` : ''}`;
    const bodyHash = createHash('sha256')
      .update(target.body ?? '')
      .digest('hex');
    const parts = {
      timestamp,
      method: (target.method ?? 'GET').toUpperCase(),
      pathAndQuery,
      bodyHash,
    };
    const canonical = this.options.canonicalize
      ? this.options.canonicalize(parts)
      : `${timestamp}\n${parts.method}\n${pathAndQuery}\n${bodyHash}`;
    target.headers[this.options.keyHeader ?? 'X-Key-Id'] = this.options.keyId;
    target.headers[this.options.timestampHeader ?? 'X-Timestamp'] = timestamp;
    target.headers[this.options.signatureHeader ?? 'X-Signature'] = createHmac(
      'sha256',
      this.options.secret,
    )
      .update(canonical)
      .digest('hex');
  }
}

export interface SessionCookieAuthOptions {
  loginUrl: string;
  /** Sent as JSON, or as a form when `asForm`. */
  credentials: Record<string, string>;
  asForm?: boolean;
  /** Give up on the login after this long. Default 30 s. */
  timeoutMs?: number;
}

/**
 * Logs in once (a POST that answers with Set-Cookie) and sends that session cookie on every request after - for APIs
 * behind a login form rather than a token. Parallel first requests share one login, and a request answered 401 (the
 * session expired) logs in again and is sent once more.
 */
export class SessionCookieAuth implements AuthProvider {
  private cookie?: string;
  private inflight?: Promise<string>;

  constructor(private readonly options: SessionCookieAuthOptions) {}

  async apply(target: AuthTarget): Promise<void> {
    if (!this.cookie) {
      this.inflight ??= this.login(target).finally(() => {
        this.inflight = undefined;
      });
      this.cookie = await this.inflight;
    }
    target.headers.Cookie = this.cookie;
  }

  reauthenticate(): boolean {
    this.cookie = undefined;
    return true;
  }

  private async login(target: AuthTarget): Promise<string> {
    const reply = await transportOf(target).post({
      url: this.options.loginUrl,
      ...(this.options.asForm ? { form: this.options.credentials } : { json: this.options.credentials }),
      timeoutMs: this.options.timeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS,
      followRedirects: false,
    });
    if (reply.status >= 400)
      throw failure('Session login', reply, Object.values(this.options.credentials));
    const cookies = reply.setCookies.map((c) => c.split(';')[0]);
    if (cookies.length === 0)
      throw new Error('Session login succeeded but the server sent no Set-Cookie');
    return cookies.join('; ');
  }
}
