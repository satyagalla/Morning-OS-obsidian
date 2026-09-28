import type { CalendarCredentialStore, CalendarRelayCredential } from "./secret-store";
import type { CalendarHttp, CalendarHttpResponse } from "./oauth-token";

export const CALENDAR_APP_SCOPE = "https://www.googleapis.com/auth/calendar.app.created";
export const CALENDAR_AUTH_ACTION = "morning-os-calendar-auth";
const SESSION_MS = 10 * 60_000;
const EXPIRY_SKEW_MS = 60_000;

export type RelayAuthErrorCode = "configuration" | "session" | "transport" | "response" | "reconnect" | "stale" | "storage";

export class RelayAuthError extends Error {
  constructor(readonly code: RelayAuthErrorCode, message: string) {
    super(message);
    this.name = "RelayAuthError";
  }
}

export interface RelayLoginStart {
  authorizationUrl: string;
  state: string;
  expiresAt: number;
}

export type RelayRedeemResult =
  | { status: "connected"; expiresAt: number }
  | { status: "pending" };

interface RelayConfiguration {
  origin: string;
  relayKey: string;
}

interface Tokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

interface PendingLogin {
  state: string;
  verifier: string;
  vaultId: string;
  expiresAt: number;
}

export interface RelayAuthOptions {
  now?: () => number;
  randomBytes?: (length: number) => Uint8Array;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function configuration(origin: string, relayKey: string): RelayConfiguration {
  let url: URL;
  try { url = new URL(origin.trim()); }
  catch { throw new RelayAuthError("configuration", "Calendar authentication service configuration is invalid."); }
  const key = relayKey.trim();
  if (origin.length > 2048 || url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      !/^[a-f0-9]{64}$/.test(key)) {
    throw new RelayAuthError("configuration", "Calendar authentication service configuration is invalid.");
  }
  return { origin: url.origin, relayKey: key };
}

function base64Url(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function secureRandom(length: number): Uint8Array {
  const value = new Uint8Array(length);
  globalThis.crypto.getRandomValues(value);
  return value;
}

function validVaultId(value: string): boolean {
  return value.trim().length > 0 && value.length <= 512;
}

export class RelayCalendarAuth {
  private config: RelayConfiguration | null = null;
  private tokens: Tokens | null = null;
  private pendingLogin: PendingLogin | null = null;
  private loginStarting = false;
  private refreshPending: Promise<string> | null = null;
  private generation = 0;
  private readonly now: () => number;
  private readonly randomBytes: (length: number) => Uint8Array;

  constructor(private readonly http: CalendarHttp, private readonly credentials: CalendarCredentialStore, options: RelayAuthOptions = {}) {
    this.now = options.now ?? Date.now;
    this.randomBytes = options.randomBytes ?? secureRandom;
  }

  configure(origin: string, relayKey: string): void {
    const next = configuration(origin, relayKey);
    this.invalidateMemory();
    this.config = next;
  }

  async restore(): Promise<string> {
    this.prepareSavedCredential();
    return this.refresh();
  }

  /** Load device-local configuration without network activity. */
  prepareSavedCredential(): boolean {
    let saved;
    try { saved = this.credentials.load(); }
    catch { throw new RelayAuthError("storage", "Calendar credentials could not be loaded."); }
    if (!saved || saved.version !== 2) return false;
    this.invalidateMemory();
    this.config = configuration(saved.origin, saved.relayKey);
    this.tokens = { accessToken: "", refreshToken: saved.refreshToken, expiresAt: 0 };
    return true;
  }

  async start(vaultId: string): Promise<RelayLoginStart> {
    if (!this.config) throw new RelayAuthError("configuration", "Calendar authentication service is not configured.");
    if (!validVaultId(vaultId)) throw new RelayAuthError("session", "Calendar login vault identity is invalid.");
    if (this.pendingLogin || this.loginStarting) throw new RelayAuthError("session", "A calendar login is already pending.");
    if (this.tokens) throw new RelayAuthError("session", "Disconnect the current calendar login before starting another.");
    const generation = this.generation;
    this.loginStarting = true;
    try {
      const verifier = base64Url(this.randomBytes(32));
      const state = base64Url(this.randomBytes(32));
      let digest: Uint8Array;
      try { digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))); }
      catch { throw new RelayAuthError("session", "Calendar login security could not be initialized."); }
      this.assertGeneration(generation);
      const challenge = base64Url(digest);
      const response = await this.call("/start", { challenge, state, vault: vaultId, scope: CALENDAR_APP_SCOPE }, generation);
      if (response.status !== 200 || !record(response.body) || response.body.state !== state || typeof response.body.url !== "string") {
        throw new RelayAuthError("response", "Calendar login could not be started.");
      }
      let consent: URL;
      try { consent = new URL(response.body.url); }
      catch { throw new RelayAuthError("response", "Calendar login service returned an invalid response."); }
      if (consent.origin !== "https://accounts.google.com" || consent.pathname !== "/o/oauth2/v2/auth" ||
        consent.searchParams.get("state") !== state || consent.searchParams.get("code_challenge") !== challenge ||
        consent.searchParams.get("code_challenge_method") !== "S256" || consent.searchParams.get("scope") !== CALENDAR_APP_SCOPE ||
        consent.searchParams.get("redirect_uri") !== `${this.config.origin}/oauth/callback`) {
        throw new RelayAuthError("response", "Calendar login service returned an invalid response.");
      }
      const expiresAt = this.now() + SESSION_MS;
      this.pendingLogin = { state, verifier, vaultId, expiresAt };
      return { authorizationUrl: consent.href, state, expiresAt };
    } finally {
      this.loginStarting = false;
    }
  }

  async redeem(state: string, vaultId: string): Promise<RelayRedeemResult> {
    const pending = this.pendingLogin;
    if (!pending) throw new RelayAuthError("session", "No calendar login is pending.");
    if (this.now() >= pending.expiresAt) {
      this.pendingLogin = null;
      throw new RelayAuthError("session", "Calendar login expired; start again.");
    }
    if (state !== pending.state || vaultId !== pending.vaultId) {
      throw new RelayAuthError("session", "Calendar login callback did not match this vault.");
    }
    const generation = this.generation;
    this.pendingLogin = null;
    const response = await this.call("/redeem", { state: pending.state, verifier: pending.verifier }, generation);
    if (response.status === 409 && record(response.body) && response.body.error === "login_pending") {
      this.assertGeneration(generation);
      this.pendingLogin = pending;
      return { status: "pending" };
    }
    if (response.status === 401 || response.status === 403) throw new RelayAuthError("reconnect", "Calendar login was not authorized.");
    if (response.status !== 200) throw new RelayAuthError("response", "Calendar login could not be completed.");
    const tokens = this.parseTokens(response.body);
    this.saveCredential(tokens.refreshToken);
    this.tokens = tokens;
    return { status: "connected", expiresAt: tokens.expiresAt };
  }

  getAccessToken(): Promise<string> {
    if (this.tokens?.accessToken && this.now() < this.tokens.expiresAt - EXPIRY_SKEW_MS) return Promise.resolve(this.tokens.accessToken);
    return this.refresh();
  }

  accessToken(): Promise<string> {
    return this.getAccessToken();
  }

  refreshAfterUnauthorized(): Promise<string> {
    this.tokens = this.tokens ? { ...this.tokens, accessToken: "", expiresAt: 0 } : null;
    return this.refresh();
  }

  refresh(): Promise<string> {
    if (this.refreshPending) return this.refreshPending;
    const generation = this.generation;
    const request = this.refreshOnce(generation);
    this.refreshPending = request;
    void request.then(() => { if (this.refreshPending === request) this.refreshPending = null; },
      () => { if (this.refreshPending === request) this.refreshPending = null; });
    return request;
  }

  private async refreshOnce(generation: number): Promise<string> {
    const refreshToken = this.tokens?.refreshToken;
    if (!refreshToken || !this.config) throw new RelayAuthError("reconnect", "Calendar authentication requires reconnection.");
    const response = await this.call("/refresh", { refresh_token: refreshToken }, generation);
    if (response.status === 401 || (record(response.body) && response.body.error === "invalid_grant")) {
      this.tokens = null;
      this.clearCredential();
      throw new RelayAuthError("reconnect", "Calendar authentication requires reconnection.");
    }
    if (response.status !== 200) throw new RelayAuthError("response", "Calendar token refresh failed.");
    const tokens = this.parseTokens(response.body, refreshToken);
    this.saveCredential(tokens.refreshToken);
    this.tokens = tokens;
    return tokens.accessToken;
  }

  async revoke(): Promise<boolean> {
    const refreshToken = this.tokens?.refreshToken;
    if (!refreshToken || !this.config) throw new RelayAuthError("reconnect", "Calendar authentication requires reconnection.");
    const generation = this.generation;
    const response = await this.call("/revoke", { refresh_token: refreshToken }, generation);
    if (response.status !== 200 || !record(response.body) || response.body.revoked !== true) {
      throw new RelayAuthError("response", "Calendar revocation was not confirmed.");
    }
    this.disconnect();
    return true;
  }

  disconnect(): void {
    this.invalidateMemory();
    this.config = null;
    this.clearCredential();
  }

  unload(): void {
    this.invalidateMemory();
    this.config = null;
  }

  private invalidateMemory(): void {
    this.generation++;
    this.pendingLogin = null;
    this.loginStarting = false;
    this.tokens = null;
    this.refreshPending = null;
  }

  private assertGeneration(generation: number): void {
    if (generation !== this.generation) throw new RelayAuthError("stale", "Calendar authentication changed while a request was running.");
  }

  private async call(path: "/start" | "/redeem" | "/refresh" | "/revoke", body: Record<string, string>, generation: number): Promise<CalendarHttpResponse> {
    const config = this.config;
    if (!config) throw new RelayAuthError("configuration", "Calendar authentication service is not configured.");
    let response: CalendarHttpResponse;
    try {
      response = await this.http({ url: config.origin + path, method: "POST", headers: {
        Authorization: `Bearer ${config.relayKey}`,
        "Content-Type": "application/json",
      }, body: JSON.stringify(body) });
    } catch {
      throw new RelayAuthError("transport", "Calendar authentication service could not be reached.");
    }
    this.assertGeneration(generation);
    return response;
  }

  private parseTokens(value: unknown, priorRefreshToken?: string): Tokens {
    const scopes = record(value) && typeof value.scope === "string" ? value.scope.split(" ").filter(Boolean) : [];
    if (!record(value) || typeof value.access_token !== "string" || !value.access_token || value.access_token.length > 8192 ||
      typeof value.expires_in !== "number" || !Number.isFinite(value.expires_in) || value.expires_in <= 0 || value.expires_in > 86400 ||
      typeof value.token_type !== "string" || value.token_type.toLowerCase() !== "bearer" || typeof value.scope !== "string" ||
      scopes.length !== 1 || scopes[0] !== CALENDAR_APP_SCOPE) {
      throw new RelayAuthError("response", "Calendar authentication service returned an invalid token response.");
    }
    const refreshToken = typeof value.refresh_token === "string" && value.refresh_token ? value.refresh_token : priorRefreshToken;
    if (!refreshToken || refreshToken.length > 8192) {
      throw new RelayAuthError("response", "Calendar login did not provide an offline credential.");
    }
    return { accessToken: value.access_token, refreshToken, expiresAt: this.now() + value.expires_in * 1000 };
  }

  private saveCredential(refreshToken: string): void {
    if (!this.config) throw new RelayAuthError("configuration", "Calendar authentication service is not configured.");
    const credential: CalendarRelayCredential = {
      version: 2, scope: CALENDAR_APP_SCOPE, origin: this.config.origin,
      relayKey: this.config.relayKey, refreshToken,
    };
    try { this.credentials.save(credential); }
    catch { throw new RelayAuthError("storage", "Calendar credentials could not be saved."); }
  }

  private clearCredential(): void {
    try { this.credentials.disconnect(); }
    catch { throw new RelayAuthError("storage", "Calendar credentials could not be cleared."); }
  }
}
