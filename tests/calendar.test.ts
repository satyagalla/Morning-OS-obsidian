import assert from "node:assert/strict";
import test from "node:test";
import { calendarEventId, GoogleCalendarAdapter } from "../src/integrations/calendar/google-adapter";
import type { CalendarIntent } from "../src/integrations/calendar/google-adapter";
import type { CalendarHttpRequest, CalendarHttpResponse } from "../src/integrations/calendar/oauth-token";

const initial: CalendarIntent = {
  integrationId: "test-vault", itemId: "item-1", mutationId: "A", predecessorId: null,
  active: true, title: "Test reminder", start: "2030-09-18T09:00:00-04:00",
  end: "2030-09-18T09:05:00-04:00", timeZone: "America/New_York",
};

class Provider {
  event: Record<string, unknown> | null = null;
  writes: CalendarHttpRequest[] = [];
  version = 0;
  timeout = false;
  race = false;
  raceCreate = false;
  creationAttempted = false;
  async http(request: CalendarHttpRequest): Promise<CalendarHttpResponse> {
    if (request.method === "GET") return { status: this.event ? 200 : 404, body: this.event && structuredClone(this.event) };
    this.writes.push(request);
    const body = JSON.parse(request.body!);
    if (request.method === "POST") {
      if (this.event) return { status: 409, body: {} };
      this.event = { ...body, status: "confirmed", etag: `"${++this.version}"` };
      if (this.raceCreate) return { status: 409, body: {} };
    } else {
      assert.equal(request.method, "PATCH");
      if (this.race || request.headers?.["If-Match"] !== this.event?.etag) return { status: 412, body: {} };
      this.event = { ...this.event, ...body, etag: `"${++this.version}"` };
    }
    if (this.timeout) { this.timeout = false; throw new Error("secret response must not leak"); }
    return { status: 200, body: structuredClone(this.event) };
  }
  adapter(): GoogleCalendarAdapter {
    return new GoogleCalendarAdapter("dedicated@example", request => this.http(request), async () => "test-token", () => 0,
      async () => {
        if (this.creationAttempted) return false;
        this.creationAttempted = true;
        return true;
      });
  }
}

function successor(mutationId: string, predecessorId: string, patch: Partial<CalendarIntent> = {}): CalendarIntent {
  return { ...initial, mutationId, predecessorId, ...patch };
}

test("calendar IDs bind vault and item and satisfy provider alphabet", async () => {
  const id = await calendarEventId("vault", "item");
  assert.match(id, /^[0-9a-v]{5,1024}$/);
  assert.equal(id, await calendarEventId("vault", "item"));
  assert.notEqual(id, await calendarEventId("other", "item"));
  assert.notEqual(id, await calendarEventId("vault", "other"));
});

test("publication and replacement use one owned event and conditional writes", async () => {
  const provider = new Provider();
  const a = await provider.adapter().reconcile(initial);
  const b = await provider.adapter().reconcile(successor("B", "A", { start: "2030-09-19T09:00:00-04:00", end: "2030-09-19T09:05:00-04:00" }));
  assert.equal(a.status, "published");
  assert.equal(b.status, "published");
  if (a.status === "published" && b.status === "published") assert.equal(a.eventId, b.eventId);
  assert.equal(provider.writes[1].headers?.["If-Match"], '"1"');
  assert.equal(provider.writes.length, 2);
});

test("stale A and stale cancellation cannot replace B even without mappings", async () => {
  const provider = new Provider();
  await provider.adapter().reconcile(initial);
  await provider.adapter().reconcile(successor("B", "A"));
  assert.equal((await provider.adapter().reconcile(initial)).status, "conflict");
  assert.equal((await provider.adapter().reconcile(successor("clear", "A", { active: false }))).status, "conflict");
  assert.equal((await provider.adapter().reconcile({ ...initial, mutationId: "unknown" })).status, "conflict");
  assert.equal(provider.writes.length, 2);
});

test("clear retains a non-alerting fence and stale device cannot resurrect", async () => {
  const provider = new Provider();
  await provider.adapter().reconcile(initial);
  const clear = successor("clear", "A", { active: false });
  assert.equal((await provider.adapter().reconcile(clear)).status, "cancelled");
  assert.deepEqual(provider.event?.reminders, { useDefault: false, overrides: [] });
  assert.equal(provider.event?.transparency, "transparent");
  assert.equal((await provider.adapter().reconcile(initial)).status, "conflict");
  assert.equal((await provider.adapter().reconcile(clear)).status, "cancelled");
  assert.equal(provider.writes.length, 2);
  assert.equal((await provider.adapter().reconcile(successor("C", "clear"))).status, "published");
});

test("clear before first publication fences a concurrent stale creation", async () => {
  const provider = new Provider();
  assert.equal((await provider.adapter().reconcile(successor("clear", "A", { active: false }))).status, "cancelled");
  assert.equal((await provider.adapter().reconcile(initial)).status, "conflict");
  assert.equal(provider.writes.length, 1);
});

test("clear that loses an insert race conditionally cancels its predecessor", async () => {
  const provider = new Provider();
  let firstGet = true;
  const adapter = new GoogleCalendarAdapter("dedicated@example", async request => {
    if (firstGet && request.method === "GET") {
      firstGet = false;
      await provider.adapter().reconcile(initial);
      return { status: 404, body: {} };
    }
    return provider.http(request);
  }, async () => "token", () => 0);
  assert.equal((await adapter.reconcile(successor("clear", "A", { active: false }))).status, "cancelled");
  assert.deepEqual(provider.event?.reminders, { useDefault: false, overrides: [] });
  assert.equal(provider.writes.at(-1)?.method, "PATCH");
});

test("deleted initial event or lost creation evidence cannot automatically recreate", async () => {
  const provider = new Provider();
  await provider.adapter().reconcile(initial);
  provider.event = null;
  assert.equal((await provider.adapter().reconcile(initial)).status, "conflict");
  const freshDevice = new GoogleCalendarAdapter("test-calendar", request => provider.http(request), async () => "token", () => 0);
  assert.equal((await freshDevice.reconcile(initial)).status, "conflict");
  assert.equal(provider.writes.length, 1);
});

test("timeout after creation or replacement recovers without duplicate writes", async () => {
  const provider = new Provider();
  provider.timeout = true;
  await assert.rejects(provider.adapter().reconcile(initial), /Calendar request failed/);
  assert.equal((await provider.adapter().reconcile(initial)).status, "published");
  provider.timeout = true;
  const b = successor("B", "A");
  await assert.rejects(provider.adapter().reconcile(b), /Calendar request failed/);
  assert.equal((await provider.adapter().reconcile(b)).status, "published");
  assert.equal(provider.writes.length, 2);
});

test("concurrent initial insert conflict recovers only matching intended payload", async () => {
  const provider = new Provider();
  provider.raceCreate = true;
  assert.equal((await provider.adapter().reconcile(initial)).status, "published");
  assert.equal(provider.writes.length, 1);
});

test("ETag conflict never fetches a new revision and blindly overwrites", async () => {
  const provider = new Provider();
  await provider.adapter().reconcile(initial);
  provider.race = true;
  assert.equal((await provider.adapter().reconcile(successor("B", "A"))).status, "conflict");
  assert.equal(provider.writes.length, 2);
  assert.equal((provider.event?.extendedProperties as { private: { mosMutation: string } }).private.mosMutation, "A");
});

test("external edits, unrelated ownership, and remote deletion stop writes", async () => {
  for (const change of [
    (event: Record<string, unknown>) => { event.summary = "Edited externally"; },
    (event: Record<string, unknown>) => { event.extendedProperties = { private: { mosProducer: "other" } }; },
    (event: Record<string, unknown>) => { event.status = "cancelled"; },
  ]) {
    const provider = new Provider();
    await provider.adapter().reconcile(initial);
    change(provider.event!);
    assert.equal((await provider.adapter().reconcile(initial)).status, "conflict");
    assert.equal((await provider.adapter().reconcile(successor("B", "A"))).status, "conflict");
    assert.equal(provider.writes.length, 1);
  }
  const provider = new Provider();
  assert.equal((await provider.adapter().reconcile(successor("B", "A"))).status, "conflict");
  assert.equal(provider.writes.length, 0);
});

test("late new receipts are missed but confirmed past events are never rearmed", async () => {
  const provider = new Provider();
  const adapter = new GoogleCalendarAdapter("test-calendar", request => provider.http(request), async () => "token", () => Date.parse(initial.end) + 1);
  assert.equal((await adapter.reconcile(initial)).status, "missed");
  assert.equal(provider.writes.length, 0);
  await provider.adapter().reconcile(initial);
  assert.equal((await adapter.reconcile(initial)).status, "published");
  assert.equal(provider.writes.length, 1);
});

test("malformed desired input blocks provider calls", async () => {
  const provider = new Provider();
  for (const patch of [{ timeZone: "invalid" }, { end: initial.start }, { start: "2030-09-18" }, { mutationId: "" },
    { start: "2030-02-30T09:00:00-04:00" }, { start: "2030-09-18T24:00:00-04:00" }]) {
    await assert.rejects(provider.adapter().reconcile({ ...initial, ...patch }), /Invalid/);
  }
  assert.equal(provider.writes.length, 0);
});
