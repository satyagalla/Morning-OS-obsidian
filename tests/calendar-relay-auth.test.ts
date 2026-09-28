import assert from "node:assert/strict";
import test from "node:test";
import { CALENDAR_APP_SCOPE, RelayAuthError, RelayCalendarAuth } from "../src/integrations/calendar/relay-auth";
import type { CalendarHttp, CalendarHttpRequest, CalendarHttpResponse } from "../src/integrations/calendar/oauth-token";
import type { CalendarCredentialStore, CalendarStoredCredential } from "../src/integrations/calendar/secret-store";

class MemoryStore implements CalendarCredentialStore {
  value: CalendarStoredCredential | null = null;
  load(): CalendarStoredCredential | null { return this.value && structuredClone(this.value); }
  save(value: CalendarStoredCredential): void { this.value = structuredClone(value); }
  disconnect(): void { this.value = null; }
}

const relayKey = "a".repeat(64);
const randomBytes = (length: number) => new Uint8Array(length).fill(7);
const tokenResponse = (patch: Record<string, unknown> = {}): CalendarHttpResponse => ({
  status: 200,
  body: { access_token: "access", refresh_token: "refresh", expires_in: 3600, token_type: "Bearer", scope: CALENDAR_APP_SCOPE, ...patch },
});

function consentUrl(request: CalendarHttpRequest): CalendarHttpResponse {
  const body = JSON.parse(request.body!) as Record<string, string>;
  const query = new URLSearchParams({
    state: body.state,
    code_challenge: body.challenge,
    code_challenge_method: "S256",
    scope: CALENDAR_APP_SCOPE,
    redirect_uri: "https://relay.example/oauth/callback",
  });
  return { status: 200, body: { state: body.state, url: `https://accounts.google.com/o/oauth2/v2/auth?${query}` } };
}

test("login uses cryptographic PKCE/state, fixed relay paths, vault binding, and single-use completion", async () => {
  const requests: CalendarHttpRequest[] = [];
  const http: CalendarHttp = async request => {
    requests.push(request);
    if (request.url.endsWith("/start")) return consentUrl(request);
    if (request.url.endsWith("/redeem")) return tokenResponse();
    throw new Error("unexpected");
  };
  const store = new MemoryStore();
  const auth = new RelayCalendarAuth(http, store, { now: () => 1000, randomBytes });
  assert.throws(() => auth.configure("http://relay.example", relayKey), RelayAuthError);
  auth.configure("https://relay.example", relayKey);
  const login = await auth.start("vault-id");
  assert.equal(requests[0].url, "https://relay.example/start");
  assert.equal(requests[0].headers?.Authorization, `Bearer ${relayKey}`);
  const startBody = JSON.parse(requests[0].body!) as Record<string, string>;
  assert.equal(startBody.scope, CALENDAR_APP_SCOPE);
  assert.equal(startBody.vault, "vault-id");
  assert.match(startBody.state, /^[A-Za-z0-9_-]{43}$/);
  assert.match(startBody.challenge, /^[A-Za-z0-9_-]{43}$/);
  await assert.rejects(auth.start("vault-id"), (error: unknown) => error instanceof RelayAuthError && error.code === "session");
  await assert.rejects(auth.redeem(login.state, "other-vault"), /did not match/);
  assert.deepEqual(await auth.redeem(login.state, "vault-id"), { status: "connected", expiresAt: 3_601_000 });
  assert.equal(requests[1].url, "https://relay.example/redeem");
  assert.equal((store.value as { version: number }).version, 2);
  await assert.rejects(auth.redeem(login.state, "vault-id"), /No calendar login/);
});

test("pending consent remains retryable while expiry and bad consent URLs fail closed", async () => {
  let now = 0;
  let redeemCalls = 0;
  const auth = new RelayCalendarAuth(async request => {
    if (request.url.endsWith("/start")) return consentUrl(request);
    redeemCalls++;
    return redeemCalls === 1 ? { status: 409, body: { error: "login_pending" } } : tokenResponse();
  }, new MemoryStore(), { now: () => now, randomBytes });
  auth.configure("https://relay.example", relayKey);
  const login = await auth.start("vault");
  assert.deepEqual(await auth.redeem(login.state, "vault"), { status: "pending" });
  assert.equal((await auth.redeem(login.state, "vault")).status, "connected");

  const expired = new RelayCalendarAuth(async request => consentUrl(request), new MemoryStore(), { now: () => now, randomBytes });
  expired.configure("https://relay.example", relayKey);
  const expiring = await expired.start("vault");
  now = expiring.expiresAt;
  await assert.rejects(expired.redeem(expiring.state, "vault"), /expired/);
});

test("restore refreshes through the fixed endpoint and concurrent access shares one refresh", async () => {
  const store = new MemoryStore();
  store.value = { version: 2, scope: CALENDAR_APP_SCOPE, origin: "https://relay.example", relayKey, refreshToken: "old-refresh" };
  let resolveResponse: (value: CalendarHttpResponse) => void = () => {};
  const requests: CalendarHttpRequest[] = [];
  const http: CalendarHttp = request => {
    requests.push(request);
    return new Promise(resolve => { resolveResponse = resolve; });
  };
  const auth = new RelayCalendarAuth(http, store, { now: () => 0, randomBytes });
  const restoring = auth.restore();
  await Promise.resolve();
  const concurrent = auth.getAccessToken();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://relay.example/refresh");
  assert.equal(JSON.parse(requests[0].body!).refresh_token, "old-refresh");
  resolveResponse(tokenResponse({ refresh_token: "rotated" }));
  assert.equal(await restoring, "access");
  assert.equal(await concurrent, "access");
  assert.equal(store.value?.refreshToken, "rotated");
});

test("disconnect and unload fence late responses without restoring credentials", async () => {
  for (const action of ["disconnect", "unload"] as const) {
    const store = new MemoryStore();
    store.value = { version: 2, scope: CALENDAR_APP_SCOPE, origin: "https://relay.example", relayKey, refreshToken: "refresh" };
    let resolveResponse: (value: CalendarHttpResponse) => void = () => {};
    const auth = new RelayCalendarAuth(() => new Promise(resolve => { resolveResponse = resolve; }), store, { now: () => 0, randomBytes });
    const operation = auth.restore();
    await Promise.resolve();
    auth[action]();
    resolveResponse(tokenResponse());
    await assert.rejects(operation, (error: unknown) => error instanceof RelayAuthError && error.code === "stale");
    if (action === "disconnect") assert.equal(store.value, null);
  }
});

test("invalid grants clear credentials, revoke is confirmed, and errors never expose secrets", async () => {
  const store = new MemoryStore();
  store.value = { version: 2, scope: CALENDAR_APP_SCOPE, origin: "https://relay.example", relayKey, refreshToken: "sensitive-refresh" };
  const invalid = new RelayCalendarAuth(async () => ({ status: 400, body: { error: "invalid_grant", detail: "sensitive-refresh" } }), store);
  await assert.rejects(invalid.restore(), (error: unknown) => {
    assert.equal(String(error).includes("sensitive-refresh"), false);
    return error instanceof RelayAuthError && error.code === "reconnect";
  });
  assert.equal(store.value, null);

  store.value = { version: 2, scope: CALENDAR_APP_SCOPE, origin: "https://relay.example", relayKey, refreshToken: "refresh" };
  const paths: string[] = [];
  const auth = new RelayCalendarAuth(async request => {
    paths.push(request.url);
    return request.url.endsWith("/refresh") ? tokenResponse() : { status: 200, body: { revoked: true } };
  }, store);
  await auth.restore();
  assert.equal(await auth.revoke(), true);
  assert.deepEqual(paths, ["https://relay.example/refresh", "https://relay.example/revoke"]);
  assert.equal(store.value, null);
});

test("token responses cannot broaden the calendar scope", async () => {
  const store = new MemoryStore();
  store.value = { version: 2, scope: CALENDAR_APP_SCOPE, origin: "https://relay.example", relayKey, refreshToken: "refresh" };
  const auth = new RelayCalendarAuth(async () => tokenResponse({ scope: `${CALENDAR_APP_SCOPE} https://www.googleapis.com/auth/calendar` }), store);
  await assert.rejects(auth.restore(), (error: unknown) => error instanceof RelayAuthError && error.code === "response");
});
