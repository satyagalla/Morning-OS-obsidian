import { Plugin, WorkspaceLeaf, Notice } from "obsidian";
import { MorningView, VIEW_TYPE_MORNING, PillarView, DumpView, TrashView, VIEW_TYPE_PILLAR, VIEW_TYPE_DUMP, VIEW_TYPE_TRASH, CaptureModal } from "./view";
import { MorningOSSettings, DEFAULT_SETTINGS, MorningOSSettingTab } from "./settings";
import { runAgent, refreshBrief, AgentResult } from "./agent/run";
import { scaffoldDailyNote } from "./agent/scaffold-daily-note";
import { loadRegistry, saveRegistry, createTask, setTaskStatus } from "./task-registry";
import { parseBulletFile, parseDailyNote } from "./agent/vault-reader";
import { todayStr } from "./utils";

export default class MorningOSPlugin extends Plugin {
  settings: MorningOSSettings;
  settingTab: MorningOSSettingTab;
  private agentRunning = false;

  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()) as MorningOSSettings;

    if (!this.settings.onboarded && this.settings.agentLastRunDate) {
      this.settings.onboarded = true;
      await this.saveData(this.settings);
    }

    this.registerView(VIEW_TYPE_MORNING, (leaf) => new MorningView(leaf, this.settings, this));
    this.registerView(VIEW_TYPE_DUMP, (leaf) => new DumpView(leaf, this.settings, this));
    this.registerView(VIEW_TYPE_TRASH, (leaf) => new TrashView(leaf, this.settings, this));
    for (const pillar of this.settings.pillars) {
      const key = pillar.key;
      this.registerView(`${VIEW_TYPE_PILLAR}-${key}`, (leaf) => new PillarView(leaf, this.settings, this, key));
    }

    this.addRibbonIcon("sun", "Morning OS", () => {
      void this.activateView();
    });

    this.addCommand({
      id: "run-agent",
      name: "Run briefing agent",
      callback: () => { void this.triggerAgent(); },
    });

    this.addCommand({
      id: "refresh-brief",
      name: "Refresh brief",
      callback: () => { void this.triggerRefresh(); },
    });

    this.addCommand({
      id: "capture-task",
      name: "Capture task to Dump",
      callback: () => {
        new CaptureModal(this.app, async (text) => {
          const task = createTask(text);
          const reg = await loadRegistry(this.app);
          reg.push(task);
          await saveRegistry(this.app, reg);
          this.refreshView();
          new Notice("Morning OS: task captured ✓");
        }).open();
      },
    });

    this.addCommand({
      id: "migrate-tasks",
      name: "Migrate tasks from daily note + pending files",
      callback: () => { void this.migrateExistingTasks(); },
    });

    this.settingTab = new MorningOSSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = null;
    const leaves = workspace.getLeavesOfType(VIEW_TYPE_MORNING);

    if (leaves.length > 0) {
      leaf = leaves[0];
    } else {
      leaf = workspace.getLeaf("tab");
      await leaf.setViewState({ type: VIEW_TYPE_MORNING, active: true });
    }

    await workspace.revealLeaf(leaf);
  }

  async triggerAgent(): Promise<void> {
    if (this.agentRunning) {
      new Notice("Morning OS: agent is already running.");
      return;
    }

    this.agentRunning = true;
    new Notice("Morning OS: running briefing agent…");

    try {
      const result: AgentResult = await runAgent(this.app, this.settings);
      this.settings.agentLastRunDate = todayStr();
      this.settings.settingsChangedSinceRun = false;
      await this.saveData(this.settings);
      if (result.mode === "direct-no-keys") {
        new Notice("Morning OS: brief ready (direct mode — no API key configured)");
      } else {
        new Notice("Morning OS: brief ready ✓");
      }
      this.settingTab.clearDirty();
      this.refreshView();
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.startsWith("LLM_FAILED:")) {
        const detail = msg.replace("LLM_FAILED: ", "");
        new Notice(`Morning OS: LLM error — ${detail}\n\nCheck your API key in settings, or disable AI modes to use direct mode.`, 10000);
      } else {
        new Notice(`Morning OS: agent failed — ${msg.slice(0, 120)}`);
      }
      console.error("Morning OS agent error:", err);
    } finally {
      this.agentRunning = false;
    }
  }

  async triggerRefresh(): Promise<void> {
    const today = todayStr();

    await scaffoldDailyNote(today, this.app, this.settings);

    const briefPath = `${this.settings.briefsDir}/${today}.json`;
    const briefExists = await this.app.vault.adapter.exists(briefPath);
    if (!briefExists) {
      await this.triggerAgent();
      return;
    }

    try {
      await refreshBrief(this.app, this.settings);
      new Notice("Morning OS: brief refreshed ✓");
      this.refreshView();
    } catch (err) {
      new Notice(`Morning OS: ${(err as Error).message}`);
    }
  }

  refreshView() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_MORNING)) {
      void (leaf.view as MorningView).refresh();
    }
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_DUMP)) {
      void (leaf.view as DumpView).refresh();
    }
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_TRASH)) {
      void (leaf.view as TrashView).refresh();
    }
    for (const pillar of this.settings.pillars) {
      for (const leaf of this.app.workspace.getLeavesOfType(`${VIEW_TYPE_PILLAR}-${pillar.key}`)) {
        void (leaf.view as PillarView).refresh();
      }
    }
  }

  async reregisterPillarViews() {
    for (const pillar of this.settings.pillars) {
      this.app.workspace.getLeavesOfType(`${VIEW_TYPE_PILLAR}-${pillar.key}`)
        .forEach(l => l.detach());
    }
    for (const pillar of this.settings.pillars) {
      const key = pillar.key;
      this.registerView(`${VIEW_TYPE_PILLAR}-${key}`, (leaf) => new PillarView(leaf, this.settings, this, key));
    }
    this.refreshView();
  }

  async activateDump() {
    const { workspace } = this.app;
    const leaves = workspace.getLeavesOfType(VIEW_TYPE_DUMP);
    const leaf = leaves.length > 0 ? leaves[0] : workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE_DUMP, active: true });
    await workspace.revealLeaf(leaf);
  }

  async activateTrash() {
    const { workspace } = this.app;
    const leaves = workspace.getLeavesOfType(VIEW_TYPE_TRASH);
    const leaf = leaves.length > 0 ? leaves[0] : workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE_TRASH, active: true });
    await workspace.revealLeaf(leaf);
  }

  async activatePillar(key: string) {
    const type = `${VIEW_TYPE_PILLAR}-${key}`;
    const { workspace } = this.app;
    const leaves = workspace.getLeavesOfType(type);
    const leaf = leaves.length > 0 ? leaves[0] : workspace.getLeaf("tab");
    await leaf.setViewState({ type, active: true });
    await workspace.revealLeaf(leaf);
  }

  async autoRefreshBrief(): Promise<void> {
    const briefPath = `${this.settings.briefsDir}/${todayStr()}.json`;
    if (!(await this.app.vault.adapter.exists(briefPath))) {
      void this.triggerAgent();
      return;
    }
    try { await refreshBrief(this.app, this.settings); } catch { /* non-critical */ }
  }

  async migrateExistingTasks(): Promise<void> {
    const today = todayStr();
    const registry = await loadRegistry(this.app);
    const existingTexts = new Set(registry.map(t => t.text.toLowerCase().trim()));
    let added = 0;

    const add = (text: string, opts: Parameters<typeof createTask>[1] = {}) => {
      const clean = text.trim();
      if (!clean || existingTexts.has(clean.toLowerCase())) return;
      existingTexts.add(clean.toLowerCase());
      registry.push(createTask(clean, opts));
      added++;
    };

    // Today's daily note — red alert and regular (undone only), land in dump
    const dailyData = await parseDailyNote(today, this.app, this.settings);
    if (dailyData) {
      for (const t of dailyData.red_alert.filter(t => !t.done))
        add(t.text, { status_priority: "red", is_today: false });
      for (const t of dailyData.regular.filter(t => !t.done))
        add(t.text, { status_priority: "regular", is_today: false });
    }

    // Technical tasks → dump
    const technical = await parseBulletFile(this.settings.sourceTechnicalTasks, this.app);
    for (const t of technical) add(t);

    // Hobby tasks → dump
    const hobby = await parseBulletFile(this.settings.sourceHobbyTasks, this.app);
    for (const t of hobby) add(t);

    await saveRegistry(this.app, registry);
    this.refreshView();
    new Notice(`Morning OS: migrated ${added} tasks ✓`);
  }

  onunload() { /* intentional — no teardown needed beyond Obsidian's built-in deregister */ }
}
