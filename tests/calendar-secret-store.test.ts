import assert from "node:assert/strict";
import test from "node:test";
import { ObsidianCalendarCredentialStore } from "../src/integrations/calendar/secret-store";

class MemorySecrets {
  values = new Map<string, string>();
  setSecret(id: string, secret: string): void { this.values.set(id, secret); }
  getSecret(id: string): string | null { return this.values.get(id) ?? null; }
  listSecrets(): string[] { return [...this.values.keys()]; }
}

test("calendar credentials are versioned, local, and read-back verified", () => {
  const secrets = new MemorySecrets();
  const store = new ObsidianCalendarCredentialStore(secrets);
  assert.equal(store.load(), null);
  store.save({ version: 1, refreshToken: "refresh-token" });
  assert.deepEqual(store.load(), { version: 1, refreshToken: "refresh-token" });
  assert.equal([...secrets.values.values()].some(value => value.includes("refresh-token")), true);
});

test("calendar relay credentials retain only strict fixed-scope configuration", () => {
  const secrets = new MemorySecrets();
  const store = new ObsidianCalendarCredentialStore(secrets);
  const credential = {
    version: 2 as const,
    scope: "https://www.googleapis.com/auth/calendar.app.created" as const,
    origin: "https://relay.example",
    relayKey: "a".repeat(64),
    refreshToken: "refresh-token",
  };
  store.save(credential);
  assert.deepEqual(store.load(), credential);
  assert.throws(() => store.save({ ...credential, origin: "http://relay.example" }), /invalid/);
  assert.throws(() => store.save({ ...credential, origin: "https://relay.example/path" }), /invalid/);
  assert.throws(() => store.save({ ...credential, relayKey: "short" }), /invalid/);
  assert.throws(() => store.save({ ...credential, scope: "https://www.googleapis.com/auth/calendar" as never }), /invalid/);
});

test("calendar credential store rejects malformed values and explicitly disconnects", () => {
  const secrets = new MemorySecrets();
  const store = new ObsidianCalendarCredentialStore(secrets);
  secrets.setSecret("morning-os-calendar-v1", '{"version":2,"refreshToken":"old"}');
  assert.equal(store.load(), null);
  assert.throws(() => store.save({ version: 1, refreshToken: " " }), /invalid/);
  store.save({ version: 1, refreshToken: "refresh-token" });
  store.disconnect();
  assert.equal(store.load(), null);
  assert.equal(secrets.getSecret("morning-os-calendar-v1"), "");
});

test("calendar credential storage fails closed when read-back differs", () => {
  const secrets = new MemorySecrets();
  secrets.setSecret = () => {};
  const store = new ObsidianCalendarCredentialStore(secrets);
  assert.throws(() => store.save({ version: 1, refreshToken: "refresh-token" }), /could not be verified/);
});
