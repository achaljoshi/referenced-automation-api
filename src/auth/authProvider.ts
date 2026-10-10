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
}

export interface AuthProvider {
  apply(target: AuthTarget): Promise<void> | void;
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
}

/**
 * OAuth2 client-credentials flow: fetches an access token from `tokenUrl`
 * the first time it's needed, then reuses it (auto-refreshing shortly
 * before it expires) rather than fetching a new token on every request.
 */
export class OAuth2ClientCredentials implements AuthProvider {
  private cachedToken?: string;
  private expiresAtMs = 0;

  constructor(private readonly options: OAuth2ClientCredentialsOptions) {}

  async apply(target: AuthTarget): Promise<void> {
    const token = await this.getToken();
    target.headers.Authorization = `Bearer ${token}`;
  }

  private async getToken(): Promise<string> {
    const skewMs = (this.options.refreshSkewSeconds ?? 30) * 1000;
    if (this.cachedToken && Date.now() < this.expiresAtMs - skewMs) {
      return this.cachedToken;
    }

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.options.clientId,
      client_secret: this.options.clientSecret,
      ...(this.options.scope ? { scope: this.options.scope } : {}),
    });

    const response = await fetch(this.options.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!response.ok) {
      throw new Error(
        `OAuth2 client-credentials token request failed: ${response.status} ${await response.text()}`,
      );
    }

    const json = (await response.json()) as { access_token: string; expires_in?: number };
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

  constructor(private readonly options: OAuth2PasswordOptions) {}

  async apply(target: AuthTarget): Promise<void> {
    target.headers.Authorization = `Bearer ${await this.token()}`;
  }

  private async token(): Promise<string> {
    const skewMs = (this.options.refreshSkewSeconds ?? 30) * 1000;
    if (this.accessToken && Date.now() < this.expiresAtMs - skewMs) return this.accessToken;
    if (this.refreshToken) {
      try {
        return await this.fetchToken({
          grant_type: 'refresh_token',
          refresh_token: this.refreshToken,
        });
      } catch {
        this.refreshToken = undefined; // expired or revoked: log in again below
      }
    }
    return this.fetchToken({
      grant_type: 'password',
      username: this.options.username,
      password: this.options.password,
    });
  }

  private async fetchToken(grant: Record<string, string>): Promise<string> {
    const body = new URLSearchParams({
      ...grant,
      ...(this.options.clientId ? { client_id: this.options.clientId } : {}),
      ...(this.options.clientSecret ? { client_secret: this.options.clientSecret } : {}),
      ...(this.options.scope ? { scope: this.options.scope } : {}),
    });
    const response = await fetch(this.options.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!response.ok)
      throw new Error(
        `OAuth2 ${grant.grant_type} grant failed: ${response.status} ${await response.text()}`,
      );
    const json = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };
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
}

/** Logs in once (a POST that answers with Set-Cookie) and sends that session cookie on every request after - for APIs behind a login form rather than a token. */
export class SessionCookieAuth implements AuthProvider {
  private cookie?: string;

  constructor(private readonly options: SessionCookieAuthOptions) {}

  async apply(target: AuthTarget): Promise<void> {
    if (!this.cookie) this.cookie = await this.login();
    target.headers.Cookie = this.cookie;
  }

  private async login(): Promise<string> {
    const response = await fetch(this.options.loginUrl, {
      method: 'POST',
      headers: {
        'Content-Type': this.options.asForm
          ? 'application/x-www-form-urlencoded'
          : 'application/json',
      },
      body: this.options.asForm
        ? new URLSearchParams(this.options.credentials).toString()
        : JSON.stringify(this.options.credentials),
      redirect: 'manual',
    });
    if (response.status >= 400)
      throw new Error(`Session login failed: ${response.status} ${await response.text()}`);
    const cookies = response.headers.getSetCookie().map((c) => c.split(';')[0]);
    if (cookies.length === 0)
      throw new Error('Session login succeeded but the server sent no Set-Cookie');
    return cookies.join('; ');
  }
}
