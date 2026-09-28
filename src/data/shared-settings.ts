import type { MorningOSSettings } from "../settings";

export const SHARED_SETTINGS_PATH = "_generated/data/settings.json";
export const SHARED_SETTINGS_KEYS = [
  "briefsDir", "dailyNoteDir", "feedbackDir", "sectionWins", "sourceTacticalRules",
  "sourceEmotionalRules", "sourceGoals", "sourceTechnicalTasks", "sourceIdentity",
  "sectionRedAlert", "sectionRegular", "sectionThoughts", "goalsShortTerm", "goalsLongTerm",
  "modeTacticalRules", "modeIdentityRules", "modeGoals", "modeSuggestion", "modeWins",
  "aiEnabled", "intelligenceProvider", "intelligenceModel", "intelligenceRegion", "awsRegion",
  "tacticalRulesCount", "identityRulesCount", "goalsShortTermCount", "goalsLongTermCount",
  "suggestionCount", "showIdentity", "showGoals", "showRulesForToday", "carryLookbackDays",
  "sourceWins", "llmSectionMappings", "areas", "advancedAreaFeatures",
  "requireSubtasksComplete", "showNotesIndicator",
] as const satisfies readonly (keyof MorningOSSettings)[];
export type SharedSettings = Pick<MorningOSSettings, typeof SHARED_SETTINGS_KEYS[number]>;
export function cloneSettings<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
export function sharedSettings(settings: MorningOSSettings): SharedSettings {
  return Object.fromEntries(SHARED_SETTINGS_KEYS.map(key => [key, cloneSettings(settings[key])])) as SharedSettings;
}
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Shared settings: ${message}`);
}
function only(value: Record<string, unknown>, keys: readonly string[]): void {
  assert(Object.keys(value).every(key => keys.includes(key)), "unknown fields; upgrade or review the file before writing");
}
function keyed(values: unknown, keys: readonly string[], validate: (value: Record<string, unknown>) => void): void {
  assert(Array.isArray(values), "expected a configuration list");
  const seen = new Set<string>();
  for (const value of values) {
    assert(record(value), "invalid configuration entry"); only(value, keys);
    assert(typeof value.key === "string" && /^[a-zA-Z0-9_-]+$/.test(value.key) && !["__proto__", "constructor", "prototype"].includes(value.key), "invalid configuration key");
    assert(!seen.has(value.key), `duplicate key ${value.key}`); seen.add(value.key);
    assert(typeof value.label === "string", "invalid label"); validate(value);
  }
}
export function validateSharedSettings(value: unknown, defaults: MorningOSSettings): SharedSettings {
  assert(record(value), "invalid settings object"); only(value, SHARED_SETTINGS_KEYS);
  for (const key of SHARED_SETTINGS_KEYS) {
    const expected = defaults[key]; const actual = value[key];
    if (!Array.isArray(expected)) {
      assert(typeof actual === typeof expected, `invalid or missing ${key}`);
      if (typeof actual === "number") assert(Number.isInteger(actual) && actual >= 0 && actual <= 10000, `invalid ${key}`);
    }
  }
  keyed(value.areas, ["key", "label", "icon", "feedToLLM", "tabs"], area => {
    assert(typeof area.icon === "string" && typeof area.feedToLLM === "boolean", "invalid Area icon/privacy permission");
    keyed(area.tabs, ["key", "label", "fields", "view_mode"], tab => {
      assert(tab.view_mode === "cards" || tab.view_mode === "table", "invalid tab view mode");
      keyed(tab.fields, ["key", "label", "type", "options"], field => {
        assert(["text", "url", "dropdown", "date"].includes(field.type as string), "invalid field type");
        if (field.options !== undefined) assert(Array.isArray(field.options) && field.options.every(option => typeof option === "string"), "invalid dropdown options");
      });
    });
  });
  assert(Array.isArray(value.llmSectionMappings), "invalid section mappings");
  for (const mapping of value.llmSectionMappings) {
    assert(record(mapping), "invalid section mapping"); only(mapping, ["heading", "target", "enabled"]);
    assert(typeof mapping.heading === "string" && typeof mapping.enabled === "boolean" &&
      ["tactical_rules", "emotional_rules", "goals_short", "goals_long"].includes(mapping.target as string), "invalid section mapping");
  }
  return cloneSettings(value) as SharedSettings;
}
interface SettingsHost {
  adapter: { exists(path: string): Promise<boolean>; read(path: string): Promise<string>; write(path: string, content: string): Promise<void>; mkdir(path: string): Promise<void> };
  loadLocal(key: string): unknown;
  saveLocal(key: string, value: unknown): void;
}
const CACHE_KEY = "morning-os-shared-settings-v1";
export class SharedSettingsStore {
  private queue: Promise<unknown> = Promise.resolve();
  private adopted = false;
  private baseline: SharedSettings;
  private bytes: string | null = null;
  error = "";
  constructor(private host: SettingsHost, private settings: MorningOSSettings, private defaults: MorningOSSettings) {
    this.baseline = sharedSettings(settings);
    const cached = host.loadLocal(CACHE_KEY);
    if (cached !== null && cached !== undefined) {
      this.adopted = true;
      try { this.apply(validateSharedSettings(cached, defaults)); }
      catch { this.error = "Last-good shared settings cache is invalid; shared writes are blocked."; }
    }
  }
  isAdopted(): boolean { return this.adopted; }
  snapshot(): SharedSettings { return cloneSettings(this.baseline); }
  private apply(value: SharedSettings): void {
    Object.assign(this.settings, cloneSettings(value)); this.baseline = cloneSettings(value);
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action); this.queue = result.catch(() => undefined); return result;
  }
  private async read(): Promise<{ bytes: string; settings: SharedSettings } | null> {
    if (!(await this.host.adapter.exists(SHARED_SETTINGS_PATH))) {
      if (this.adopted) throw new Error("Shared settings file is missing; restore/sync it before editing shared settings.");
      return null;
    }
    const bytes = await this.host.adapter.read(SHARED_SETTINGS_PATH);
    const envelope: unknown = JSON.parse(bytes);
    assert(record(envelope) && envelope.schemaVersion === 1, "unsupported settings schema");
    only(envelope, ["schemaVersion", "settings"]);
    return { bytes, settings: validateSharedSettings(envelope.settings, this.defaults) };
  }
  private accept(value: { bytes: string; settings: SharedSettings }): boolean {
    if (this.adopted && this.bytes === value.bytes) { this.error = ""; return false; }
    if (!this.adopted && this.host.loadLocal("morning-os-settings-before-adoption-v1") == null) {
      this.host.saveLocal("morning-os-settings-before-adoption-v1", this.baseline);
    }
    const changed = !equal(this.baseline, value.settings);
    this.host.saveLocal(CACHE_KEY, value.settings);
    this.adopted = true; this.bytes = value.bytes; this.apply(value.settings); this.error = "";
    return changed;
  }
  reconcile(): Promise<boolean> {
    return this.serial(async () => {
      try { const current = await this.read(); return current ? this.accept(current) : false; }
      catch (error) { this.error = (error as Error).message; throw error; }
    });
  }
  initialize(): Promise<void> {
    return this.serial(async () => {
      assert(!this.adopted && !(await this.host.adapter.exists(SHARED_SETTINGS_PATH)), "already initialized; existing shared file will not be overwritten");
      const value = validateSharedSettings(sharedSettings(this.settings), this.defaults);
      for (const dir of ["_generated", "_generated/data", "_generated/recovery"]) {
        if (!(await this.host.adapter.exists(dir))) await this.host.adapter.mkdir(dir);
      }
      const id = Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
      const backup = `_generated/recovery/settings-before-sharing-${id}.json`;
      const bytes = JSON.stringify({ schemaVersion: 1, settings: value }, null, 2);
      await this.host.adapter.write(backup, bytes);
      assert(await this.host.adapter.read(backup) === bytes, "settings backup verification failed");
      assert(!(await this.host.adapter.exists(SHARED_SETTINGS_PATH)), "another settings file arrived during initialization; it was not overwritten");
      await this.host.adapter.write(SHARED_SETTINGS_PATH, bytes);
      assert(await this.host.adapter.read(SHARED_SETTINGS_PATH) === bytes, "settings initialization verification failed");
      this.accept({ bytes, settings: value });
    });
  }
  update(patch: Partial<MorningOSSettings>, base = this.snapshot()): Promise<void> {
    const intent = cloneSettings(patch);
    return this.serial(async () => {
      const keys = SHARED_SETTINGS_KEYS.filter(key => key in intent);
      if (!keys.length) return; // Local-only saves never export stale shared values.
      try {
        const current = await this.read();
        if (!current) {
          const next = validateSharedSettings({ ...this.baseline, ...Object.fromEntries(keys.map(key => [key, intent[key]])) }, this.defaults);
          this.apply(next); return; // Explicit initialization only; legacy configuration remains local.
        }
        for (const key of keys) {
          assert(equal(current.settings[key], base[key]) || equal(current.settings[key], intent[key]), `conflict in ${key}; reload settings and reapply your change`);
        }
        const next = validateSharedSettings({ ...current.settings, ...Object.fromEntries(keys.map(key => [key, intent[key]])) }, this.defaults);
        const bytes = JSON.stringify({ schemaVersion: 1, settings: next }, null, 2);
        if (!equal(next, current.settings)) {
          // Exact-byte fence is not an atomic CAS across devices or sync providers.
          assert(await this.host.adapter.read(SHARED_SETTINGS_PATH) === current.bytes, "file changed before save; retry after reloading");
          await this.host.adapter.write(SHARED_SETTINGS_PATH, bytes);
          assert(await this.host.adapter.read(SHARED_SETTINGS_PATH) === bytes, "file changed during save; reconcile before retrying");
        }
        this.accept({ bytes: equal(next, current.settings) ? current.bytes : bytes, settings: next });
      } catch (error) { this.error = (error as Error).message; throw error; }
    });
  }
}
