import type { QueryValue } from '../client/types';

/** What an AuthProvider is allowed to mutate before a request goes out. */
export interface AuthTarget {
  headers: Record<string, string>;
  queryParams: Record<string, QueryValue>;
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
