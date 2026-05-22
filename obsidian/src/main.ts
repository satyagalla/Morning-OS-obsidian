import { Plugin, WorkspaceLeaf } from "obsidian";
import { MorningView, VIEW_TYPE_MORNING } from "./view";
import { MorningOSSettings, DEFAULT_SETTINGS, MorningOSSettingTab } from "./settings";

export default class MorningOSPlugin extends Plugin {
  settings: MorningOSSettings;

  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

    this.registerView(VIEW_TYPE_MORNING, (leaf) => new MorningView(leaf, this.settings));

    this.addRibbonIcon("sun", "Morning OS", () => {
      this.activateView();
    });

    this.addCommand({
      id: "open-morning-view",
      name: "Open Morning Dashboard",
      callback: () => {
        this.activateView();
      },
    });

    this.addSettingTab(new MorningOSSettingTab(this.app, this));
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

  onunload() {}
}
