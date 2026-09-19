export interface CalendarHttpRequest {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface CalendarHttpResponse {
  status: number;
  body: unknown;
  /** Lower-cased provider headers needed for bounded retry decisions. */
  headers?: Record<string, string>;
}

export type CalendarHttp = (request: CalendarHttpRequest) => Promise<CalendarHttpResponse>;

export interface CalendarOAuthCredentials {
  clientId: string;
  refreshToken: string;
  clientSecret?: string;
}

export type CalendarCredentialSource = () => Promise<CalendarOAuthCredentials>;

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const EXPIRY_SKEW_MS = 60_000;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Transport spike only: credential provisioning and persistence belong to the caller. */
export class CalendarOAuthTokenProvider {
  private cached: { token: string; expiresAt: number } | undefined;
  private pending: Promise<string> | undefined;
  private paused = false;
  private generation = 0;

  constructor(private readonly credentials: CalendarCredentialSource, private readonly http: CalendarHttp,
    private readonly now: () => number = Date.now) {}

  getAccessToken(): Promise<string> {
    if (this.paused) return Promise.reject(new Error("Calendar authentication: reconnect required."));
    if (this.cached && this.now() < this.cached.expiresAt - EXPIRY_SKEW_MS) {
      return Promise.resolve(this.cached.token);
    }
    if (this.pending) return this.pending;
    const generation = this.generation;
    const request = this.exchange(generation);
    this.pending = request;
    void request.then(() => { if (this.pending === request) this.pending = undefined; },
      () => { if (this.pending === request) this.pending = undefined; });
    return request;
  }

  /** Call after the credential source changes or the user reconnects. */
  reset(): void {
    this.generation++;
    this.cached = undefined;
    this.pending = undefined;
    this.paused = false;
  }

  private async exchange(generation: number): Promise<string> {
    let credentials: CalendarOAuthCredentials;
    try {
      credentials = await this.credentials();
    } catch {
      throw new Error("Calendar authentication: credentials unavailable.");
    }
    if (!record(credentials) || !nonempty(credentials.clientId) || !nonempty(credentials.refreshToken)
      || (credentials.clientSecret !== undefined && !nonempty(credentials.clientSecret))) {
      throw new Error("Calendar authentication: invalid OAuth credentials.");
    }
    const startedAt = this.now();
    const body = new URLSearchParams({ grant_type: "refresh_token", client_id: credentials.clientId,
      refresh_token: credentials.refreshToken });
    if (credentials.clientSecret !== undefined) body.set("client_secret", credentials.clientSecret);
    let response: CalendarHttpResponse;
    try {
      response = await this.http({ url: TOKEN_URL, method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString() });
    } catch {
      throw new Error("Calendar authentication: token request failed.");
    }
    if (generation !== this.generation) throw new Error("Calendar authentication: credentials changed during refresh.");
    if (record(response) && record(response.body) && response.status >= 400 && response.body.error === "invalid_grant") {
      this.cached = undefined;
      this.paused = true;
      throw new Error("Calendar authentication: reconnect required.");
    }
    if (!record(response) || response.status !== 200 || !record(response.body)
      || !nonempty(response.body.access_token) || typeof response.body.token_type !== "string"
      || response.body.token_type.toLowerCase() !== "bearer"
      || typeof response.body.expires_in !== "number" || !Number.isFinite(response.body.expires_in)
      || response.body.expires_in <= 0 || response.body.expires_in > 86400) {
      throw new Error("Calendar authentication: invalid token response.");
    }
    this.cached = { token: response.body.access_token, expiresAt: startedAt + response.body.expires_in * 1000 };
    return this.cached.token;
  }
}
