import { Plugin, WorkspaceLeaf, Notice } from "obsidian";
import { MorningView, VIEW_TYPE_MORNING } from "./view";
import { MorningOSSettings, DEFAULT_SETTINGS, MorningOSSettingTab } from "./settings";
import { spawnAgent, parseRunTime } from "./agent-runner";

export default class MorningOSPlugin extends Plugin {
  settings: MorningOSSettings;
  settingTab: MorningOSSettingTab;
  private agentRunning = false;

  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

    this.registerView(VIEW_TYPE_MORNING, (leaf) => new MorningView(leaf, this.settings));

    this.addRibbonIcon("sun", "Morning OS", () => {
      this.activateView();
    });

    this.addCommand({
      id: "open-morning-view",
      name: "Open Morning Dashboard",
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: "run-agent",
      name: "Run briefing agent",
      callback: () => this.triggerAgent(),
    });

    this.settingTab = new MorningOSSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);

    // Check every minute whether it's time for the daily auto-run
    this.registerInterval(window.setInterval(() => this.maybeAutoRun(), 60_000));
    // Also check immediately on load (handles case where Obsidian opens after scheduled time)
    this.maybeAutoRun();
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

    workspace.revealLeaf(leaf);
  }

  async triggerAgent(): Promise<void> {
    if (this.agentRunning) {
      new Notice("Morning OS: agent is already running.");
      return;
    }
    if (!this.settings.agentRepoPath) {
      new Notice("Morning OS: set the repo path in Settings first.");
      return;
    }

    this.agentRunning = true;
    new Notice("Morning OS: running briefing agent…");

    try {
      await spawnAgent(this.settings.agentRepoPath);
      const today = this.todayStr();
      this.settings.agentLastRunDate = today;
      await this.saveData(this.settings);
      this.settings.settingsChangedSinceRun = false;
      await this.saveData(this.settings);
      new Notice("Morning OS: brief ready ✓");
      this.settingTab.clearDirty();
      this.refreshView();
    } catch (err) {
      console.error("Morning OS agent error:", err);
      new Notice(`Morning OS: agent failed — ${(err as Error).message.slice(0, 120)}`);
    } finally {
      this.agentRunning = false;
    }
  }

  private async maybeAutoRun() {
    if (!this.settings.agentRepoPath) return;
    if (!this.settings.agentRunTime) return;

    const parsed = parseRunTime(this.settings.agentRunTime);
    if (!parsed) return;

    const now = new Date();
    const today = this.todayStr();

    const alreadyRan = this.settings.agentLastRunDate === today;
    const pastRunTime = now.getHours() > parsed.hour ||
      (now.getHours() === parsed.hour && now.getMinutes() >= parsed.minute);

    if (!alreadyRan && pastRunTime) {
      await this.triggerAgent();
    }
  }

  private refreshView() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_MORNING);
    for (const leaf of leaves) {
      (leaf.view as MorningView).refresh();
    }
  }

  private todayStr(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  onunload() {}
}
