import assert from "node:assert/strict";
import test from "node:test";
import { resolveReminderWindow } from "../src/integrations/calendar/time-policy";

test("resolves an ordinary explicit-zone reminder to a fifteen-minute RFC3339 window", () => {
  const result = resolveReminderWindow("2030-09-18", "09:00", "America/New_York", Date.parse("2030-09-18T12:59:59Z"));
  assert.deepEqual(result, {
    start: "2030-09-18T09:00:00-04:00",
    end: "2030-09-18T09:15:00-04:00",
    missed: false,
    ambiguity: "none",
  });
  assert.equal(Date.parse(result.end) - Date.parse(result.start), 15 * 60_000);
});

test("rejects nonexistent spring-forward wall times", () => {
  assert.throws(() => resolveReminderWindow("2026-03-08", "02:30", "America/New_York", 0), /does not exist/);
});

test("chooses the earlier instant during a fall-back overlap", () => {
  const result = resolveReminderWindow("2026-11-01", "01:30", "America/New_York", 0);
  assert.equal(result.start, "2026-11-01T01:30:00-04:00");
  assert.equal(result.ambiguity, "earlier");
});

test("supports non-hour offsets and marks elapsed occurrences missed", () => {
  const result = resolveReminderWindow("2030-01-02", "09:10", "Asia/Kathmandu", Date.parse("2030-01-02T03:25:00Z"));
  assert.equal(result.start, "2030-01-02T09:10:00+05:45");
  assert.equal(result.end, "2030-01-02T09:25:00+05:45");
  assert.equal(result.missed, true);
});

test("uses the supplied zone independently of the device zone", () => {
  const tokyo = resolveReminderWindow("2030-06-01", "09:00", "Asia/Tokyo", 0);
  const losAngeles = resolveReminderWindow("2030-06-01", "09:00", "America/Los_Angeles", 0);
  assert.equal(tokyo.start, "2030-06-01T09:00:00+09:00");
  assert.equal(losAngeles.start, "2030-06-01T09:00:00-07:00");
  assert.notEqual(Date.parse(tokyo.start), Date.parse(losAngeles.start));
});

test("rejects malformed dates, times, zones, and clocks", () => {
  for (const args of [
    ["2030-02-30", "09:00", "UTC", 0],
    ["2030-01-01", "24:00", "UTC", 0],
    ["2030-01-01", "09:00", "Not/AZone", 0],
    ["2030-01-01", "09:00", "UTC", Number.NaN],
  ] as const) assert.throws(() => resolveReminderWindow(...args));
});
