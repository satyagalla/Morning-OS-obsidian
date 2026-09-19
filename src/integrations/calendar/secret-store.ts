import type { SecretStorage } from "obsidian";

const SECRET_ID = "morning-os-calendar-v1";
const MAX_REFRESH_TOKEN_LENGTH = 8192;

export interface CalendarRefreshCredential {
  version: 1;
  refreshToken: string;
}

export interface CalendarCredentialStore {
  load(): CalendarRefreshCredential | null;
  save(credential: CalendarRefreshCredential): void;
  disconnect(): void;
}

function parseCredential(raw: string | null): CalendarRefreshCredential | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const credential = value as { version?: unknown; refreshToken?: unknown };
    if (credential.version !== 1 || typeof credential.refreshToken !== "string" || !credential.refreshToken.trim() ||
      credential.refreshToken.length > MAX_REFRESH_TOKEN_LENGTH) return null;
    return { version: 1, refreshToken: credential.refreshToken };
  } catch {
    return null;
  }
}

/** Device-local credentials only. Never copy this record into plugin settings or vault state. */
export class ObsidianCalendarCredentialStore implements CalendarCredentialStore {
  constructor(private readonly secrets: SecretStorage) {}

  load(): CalendarRefreshCredential | null {
    return parseCredential(this.secrets.getSecret(SECRET_ID));
  }

  save(credential: CalendarRefreshCredential): void {
    if (credential.version !== 1 || !credential.refreshToken.trim() || credential.refreshToken.length > MAX_REFRESH_TOKEN_LENGTH) {
      throw new Error("Calendar credentials are invalid.");
    }
    const raw = JSON.stringify({ version: 1, refreshToken: credential.refreshToken });
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
