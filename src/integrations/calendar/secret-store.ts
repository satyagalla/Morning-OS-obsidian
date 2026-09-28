import type { SecretStorage } from "obsidian";

const SECRET_ID = "morning-os-calendar-v1";
const MAX_REFRESH_TOKEN_LENGTH = 8192;

export interface CalendarRefreshCredential {
  version: 1;
  refreshToken: string;
}

export interface CalendarRelayCredential {
  version: 2;
  scope: "https://www.googleapis.com/auth/calendar.app.created";
  origin: string;
  relayKey: string;
  refreshToken: string;
}

export type CalendarStoredCredential = CalendarRefreshCredential | CalendarRelayCredential;

export interface CalendarCredentialStore {
  load(): CalendarStoredCredential | null;
  save(credential: CalendarStoredCredential): void;
  disconnect(): void;
}

function validOrigin(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/" && url.origin === value;
  } catch {
    return false;
  }
}

function parseCredential(raw: string | null): CalendarStoredCredential | null {
  if (!raw || raw.length > 20_000) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const credential = value as { version?: unknown; scope?: unknown; origin?: unknown; relayKey?: unknown; refreshToken?: unknown };
    if (typeof credential.refreshToken !== "string" || !credential.refreshToken || credential.refreshToken.trim() !== credential.refreshToken ||
      credential.refreshToken.length > MAX_REFRESH_TOKEN_LENGTH) return null;
    const keys = Object.keys(value as Record<string, unknown>);
    if (credential.version === 1) {
      if (keys.length !== 2 || !keys.includes("version") || !keys.includes("refreshToken")) return null;
      return { version: 1, refreshToken: credential.refreshToken };
    }
    if (credential.version !== 2 || credential.scope !== "https://www.googleapis.com/auth/calendar.app.created" ||
      keys.length !== 5 || !["version", "scope", "origin", "relayKey", "refreshToken"].every(key => keys.includes(key)) ||
      !validOrigin(credential.origin) || typeof credential.relayKey !== "string" || !/^[a-f0-9]{64}$/.test(credential.relayKey)) return null;
    return { version: 2, scope: credential.scope, origin: credential.origin, relayKey: credential.relayKey, refreshToken: credential.refreshToken };
  } catch {
    return null;
  }
}

/** Device-local credentials only. Never copy this record into plugin settings or vault state. */
export class ObsidianCalendarCredentialStore implements CalendarCredentialStore {
  constructor(private readonly secrets: SecretStorage) {}

  load(): CalendarStoredCredential | null {
    return parseCredential(this.secrets.getSecret(SECRET_ID));
  }

  save(credential: CalendarStoredCredential): void {
    const normalized = parseCredential(JSON.stringify(credential));
    if (!normalized) {
      throw new Error("Calendar credentials are invalid.");
    }
    const raw = JSON.stringify(normalized);
    this.secrets.setSecret(SECRET_ID, raw);
    if (this.secrets.getSecret(SECRET_ID) !== raw) {
      throw new Error("Calendar credentials could not be verified after storage.");
    }
  }

  disconnect(): void {
    // SecretStorage exposes no public deletion API. An empty value is a durable
    // disconnected record and is rejected by load(); do not infer physical erase.
    this.secrets.setSecret(SECRET_ID, "");
    const value = this.secrets.getSecret(SECRET_ID);
    if (value !== "" && value !== null) {
      throw new Error("Calendar credentials could not be cleared.");
    }
  }
}
