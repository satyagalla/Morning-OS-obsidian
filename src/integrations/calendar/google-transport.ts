import type { CalendarIntegrationState } from "../../types";
import { CalendarPublishError } from "./contracts";
import type { CalendarTokenProvider } from "./contracts";
import type { CalendarHttp, CalendarHttpRequest, CalendarHttpResponse } from "./oauth-token";

function retryAfter(response: CalendarHttpResponse, now: number): number | undefined {
  const value = response.headers?.["retry-after"]?.trim();
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

export function authenticatedCalendarHttp(http: CalendarHttp, tokens: CalendarTokenProvider,
  now: () => number = Date.now): CalendarHttp {
  return async request => {
    const send = async (token: string): Promise<CalendarHttpResponse> => {
      try {
        return await http({ ...request, headers: { ...request.headers, Authorization: `Bearer ${token}` } });
      } catch {
        throw new CalendarPublishError("unknown", "Calendar request outcome is unknown");
      }
    };
    let response = await send(await tokens.accessToken());
    if (response.status === 401) response = await send(await tokens.refreshAfterUnauthorized());
    if (response.status === 401) throw new CalendarPublishError("auth", "Calendar authentication requires reconnecting");
    if (response.status === 403) throw new CalendarPublishError("permission", "Calendar permission was denied");
    if (response.status === 429 || response.status >= 500) {
      throw new CalendarPublishError("retryable", `Calendar service is temporarily unavailable (${response.status})`, retryAfter(response, now()));
    }
    return response;
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function calendarMarker(integration: CalendarIntegrationState): string {
  return `Morning OS experimental test calendar\nOwner: ${integration.ownershipToken}\nProtocol: ${integration.protocolVersion}`;
}

export interface DedicatedCalendarResult {
  id: string;
  summary: string;
}

function confirmCalendar(value: unknown, integration: CalendarIntegrationState): DedicatedCalendarResult | null {
  if (!record(value) || typeof value.id !== "string" || !value.id || value.id === "primary" ||
    typeof value.summary !== "string" || value.summary !== "Morning OS Test" || value.description !== calendarMarker(integration)) return null;
  return { id: value.id, summary: value.summary };
}

export async function createDedicatedGoogleCalendar(integration: CalendarIntegrationState, http: CalendarHttp,
  tokens: CalendarTokenProvider): Promise<DedicatedCalendarResult> {
  const response = await authenticatedCalendarHttp(http, tokens)({
    url: "https://www.googleapis.com/calendar/v3/calendars",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ summary: "Morning OS Test", description: calendarMarker(integration), timeZone: integration.timeZone }),
  });
  if (response.status !== 200 && response.status !== 201) {
    throw new CalendarPublishError(response.status >= 400 && response.status < 500 ? "invalid" : "unknown",
      `Dedicated calendar creation failed (${response.status})`);
  }
  const calendar = confirmCalendar(response.body, integration);
  if (!calendar) throw new CalendarPublishError("unknown", "Dedicated calendar creation could not be confirmed");
  return calendar;
}

export async function recoverDedicatedGoogleCalendar(id: string, integration: CalendarIntegrationState, http: CalendarHttp,
  tokens: CalendarTokenProvider): Promise<DedicatedCalendarResult> {
  if (!id || id === "primary") throw new Error("Enter the dedicated test calendar ID");
  const response = await authenticatedCalendarHttp(http, tokens)({
    url: `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(id)}`,
    method: "GET",
  });
  if (response.status !== 200) throw new CalendarPublishError("conflict", "The dedicated calendar could not be inspected");
  const calendar = confirmCalendar(response.body, integration);
  if (!calendar) throw new CalendarPublishError("conflict", "Calendar ownership marker does not match this integration");
  return calendar;
}

export function stripAuthorization(request: CalendarHttpRequest): CalendarHttpRequest {
  const headers = { ...request.headers };
  delete headers.Authorization;
  return { ...request, headers };
}
