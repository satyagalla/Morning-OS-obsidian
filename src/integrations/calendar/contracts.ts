import type { CalendarIntegrationState, CalendarReminderMutation, Task } from "../../types";
import type { CalendarHttp } from "./oauth-token";

export interface CalendarClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): number;
  clearTimeout(id: number): void;
}

export interface CalendarTokenProvider {
  accessToken(): Promise<string>;
  refreshAfterUnauthorized(): Promise<string>;
  disconnect(): void;
}

export interface CalendarPublisherStatus {
  state: "disabled" | "idle" | "working" | "pending" | "conflict" | "auth-required" | "permission-denied" | "missed";
  message: string;
  updatedAt: number;
}

export interface CalendarDesiredItem {
  item: Task;
  mutations: readonly CalendarReminderMutation[];
}

export interface CalendarDesiredSnapshot {
  revision: number;
  integration: CalendarIntegrationState;
  items: readonly CalendarDesiredItem[];
}

export interface CalendarRuntimeDependencies {
  http: CalendarHttp;
  tokenProvider: CalendarTokenProvider;
  clock?: CalendarClock;
  random?: () => number;
}

export type CalendarFailureKind = "auth" | "permission" | "retryable" | "unknown" | "conflict" | "invalid";

export class CalendarPublishError extends Error {
  constructor(readonly kind: CalendarFailureKind, message: string, readonly retryAfterMs?: number) {
    super(message);
    this.name = "CalendarPublishError";
  }
}
