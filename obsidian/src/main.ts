import { Plugin, WorkspaceLeaf } from "obsidian";
import { MorningView, VIEW_TYPE_MORNING } from "./view";

export default class MorningOSPlugin extends Plugin {
  async onload() {
    this.registerView(VIEW_TYPE_MORNING, (leaf) => new MorningView(leaf));

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
