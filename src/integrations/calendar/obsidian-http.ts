import { requestUrl } from "obsidian";
import type { CalendarHttp } from "./oauth-token";

/** Mobile-compatible transport; no Node, fetch/CORS workaround, or private FCR API. */
export const obsidianCalendarHttp: CalendarHttp = async request => {
  const response = await requestUrl({
    url: request.url, method: request.method, headers: request.headers,
    body: request.body, throw: false,
  });
  let body: unknown = null;
  try { body = JSON.parse(response.text); } catch { /* Caller rejects malformed success responses. */ }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(response.headers)) headers[name.toLowerCase()] = value;
  return { status: response.status, body, headers };
};
