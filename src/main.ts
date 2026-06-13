import { Plugin, WorkspaceLeaf, Notice } from "obsidian";
import { MorningView, VIEW_TYPE_MORNING } from "./view";
import { MorningOSSettings, DEFAULT_SETTINGS, MorningOSSettingTab } from "./settings";
import { runAgent, refreshBrief, AgentResult } from "./agent/run";
import { scaffoldDailyNote } from "./agent/scaffold-daily-note";
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

    this.addRibbonIcon("sun", "Morning OS", () => {
      void this.activateView();
    });

    this.addCommand({
      id: "open-morning-view",
      name: "Open Morning Dashboard",
      callback: () => { void this.activateView(); },
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
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_MORNING);
    for (const leaf of leaves) {
      void (leaf.view as MorningView).refresh();
    }
  }

  onunload() { /* intentional — no teardown needed beyond Obsidian's built-in deregister */ }
}
