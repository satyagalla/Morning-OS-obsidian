import assert from "node:assert/strict";
import { test } from "node:test";
import { CalendarOAuthTokenProvider } from "../src/integrations/calendar/oauth-token";
import type { CalendarHttpResponse } from "../src/integrations/calendar/oauth-token";

const credentials = async () => ({ clientId: "client", refreshToken: "refresh-secret" });
const success = (token = "access-secret"): CalendarHttpResponse => ({
  status: 200, body: { access_token: token, token_type: "Bearer", expires_in: 3600 },
});

test("refresh uses fixed Google endpoint and caches until expiry skew", async () => {
  let now = 0;
  let calls = 0;
  const auth = new CalendarOAuthTokenProvider(credentials, async request => {
    calls++;
    assert.equal(request.url, "https://oauth2.googleapis.com/token");
    assert.equal(request.method, "POST");
    assert.equal(request.headers?.["Content-Type"], "application/x-www-form-urlencoded");
    const body = new URLSearchParams(request.body);
    assert.equal(body.get("grant_type"), "refresh_token");
    assert.equal(body.get("client_id"), "client");
    assert.equal(body.get("refresh_token"), "refresh-secret");
    assert.equal(body.has("client_secret"), false);
    return success(`token-${calls}`);
  }, () => now);
  assert.equal(await auth.getAccessToken(), "token-1");
  now = 3_539_999;
  assert.equal(await auth.getAccessToken(), "token-1");
  now = 3_540_000;
  assert.equal(await auth.getAccessToken(), "token-2");
  assert.equal(calls, 2);
});

test("concurrent calls share a refresh and failed refresh can retry without leaking errors", async () => {
  let calls = 0;
  const auth = new CalendarOAuthTokenProvider(credentials, async () => {
    calls++;
    if (calls === 1) throw new Error("refresh-secret access-secret server details");
    return success();
  });
  const first = auth.getAccessToken();
  assert.equal(first, auth.getAccessToken());
  await assert.rejects(first, { message: "Calendar authentication: token request failed." });
  assert.equal(await auth.getAccessToken(), "access-secret");
  assert.equal(calls, 2);
});

test("invalid_grant pauses refresh until reset and reloads credentials", async () => {
  let calls = 0;
  let refreshToken = "old";
  const auth = new CalendarOAuthTokenProvider(async () => ({ clientId: "client", refreshToken, clientSecret: "client-secret" }),
    async request => {
      calls++;
      const body = new URLSearchParams(request.body);
      assert.equal(body.get("client_secret"), "client-secret");
      if (calls === 1) return { status: 400, body: { error: "invalid_grant", error_description: "sensitive" } };
      assert.equal(body.get("refresh_token"), "new");
      return success();
    });
  await assert.rejects(auth.getAccessToken(), { message: "Calendar authentication: reconnect required." });
  await assert.rejects(auth.getAccessToken(), { message: "Calendar authentication: reconnect required." });
  assert.equal(calls, 1);
  refreshToken = "new";
  auth.reset();
  assert.equal(await auth.getAccessToken(), "access-secret");
  assert.equal(calls, 2);
});

test("malformed token responses fail closed with sanitized errors", async () => {
  for (const response of [
    { status: 500, body: { access_token: "sensitive" } },
    { status: 200, body: { access_token: "", token_type: "Bearer", expires_in: 3600 } },
    { status: 200, body: { access_token: "sensitive", token_type: "MAC", expires_in: 3600 } },
    { status: 200, body: { access_token: "sensitive", token_type: "Bearer", expires_in: -1 } },
    { status: 200, body: { access_token: "sensitive", token_type: "Bearer", expires_in: "3600" } },
    { status: 200, body: null },
  ]) {
    const auth = new CalendarOAuthTokenProvider(credentials, async () => response);
    await assert.rejects(auth.getAccessToken(), { message: "Calendar authentication: invalid token response." });
  }
});

test("invalid and unavailable credentials fail without issuing HTTP requests", async () => {
  let calls = 0;
  const http = async () => { calls++; return success(); };
  await assert.rejects(new CalendarOAuthTokenProvider(async () => ({ clientId: "", refreshToken: "secret" }), http).getAccessToken(),
    { message: "Calendar authentication: invalid OAuth credentials." });
  await assert.rejects(new CalendarOAuthTokenProvider(async () => { throw new Error("credential secret"); }, http).getAccessToken(),
    { message: "Calendar authentication: credentials unavailable." });
  assert.equal(calls, 0);
});

test("reset prevents an in-flight old refresh from caching a stale token or pausing new credentials", async () => {
  let resolveOld: (response: CalendarHttpResponse) => void = () => {};
  let calls = 0;
  const auth = new CalendarOAuthTokenProvider(credentials, async () => {
    calls++;
    if (calls === 1) return new Promise<CalendarHttpResponse>(resolve => { resolveOld = resolve; });
    return success("new-token");
  });
  const old = auth.getAccessToken();
  await Promise.resolve();
  auth.reset();
  assert.equal(await auth.getAccessToken(), "new-token");
  resolveOld({ status: 400, body: { error: "invalid_grant" } });
  await assert.rejects(old, { message: "Calendar authentication: credentials changed during refresh." });
  assert.equal(await auth.getAccessToken(), "new-token");
  assert.equal(calls, 2);
});
