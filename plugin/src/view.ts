import { ItemView, WorkspaceLeaf, TFile } from "obsidian";
import { DailyBrief, Task } from "./types";

export const VIEW_TYPE_MORNING = "morning-os-view";

export class MorningView extends ItemView {
  private brief: DailyBrief | null = null;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string { return VIEW_TYPE_MORNING; }
  getDisplayText(): string { return "Morning OS"; }
  getIcon(): string { return "sun"; }

  async onOpen() {
    await this.loadBrief();
    this.render();
  }

  async onClose() {}

  private async loadBrief() {
    const today = new Date().toISOString().split("T")[0];
    const file = this.app.vault.getAbstractFileByPath(`_generated/briefs/${today}.json`);
    if (file instanceof TFile) {
      this.brief = JSON.parse(await this.app.vault.read(file));
    } else {
      this.brief = null;
    }
  }

  private render() {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("morning-os");

    if (!this.brief) {
      container.createEl("div", {
        cls: "morning-os-empty",
        text: "No brief for today. Run the briefing agent or check _generated/briefs/",
      });
      return;
    }

    const wrapper = container.createEl("div", { cls: "morning-os-wrapper" });

    this.renderHeader(wrapper);
    this.renderIdentityStrip(wrapper);
    this.renderGoals(wrapper);

    const body = wrapper.createEl("div", { cls: "morning-os-body" });
    const left = body.createEl("div", { cls: "morning-os-left" });
    const right = body.createEl("div", { cls: "morning-os-right" });

    this.renderTasks(left);
    this.renderTacticalRules(right);
    this.renderSuggestion(right);

    this.renderHobbyTasks(wrapper);
    this.renderWins(wrapper);
  }

  private renderHeader(parent: HTMLElement) {
    const header = parent.createEl("div", { cls: "morning-os-header" });
    const dateObj = new Date(this.brief!.date + "T00:00:00");
    header.createEl("span", {
      cls: "morning-os-date",
      text: dateObj.toLocaleDateString("en-US", {
        weekday: "long", day: "numeric", month: "long", year: "numeric",
      }),
    });
  }

  private renderIdentityStrip(parent: HTMLElement) {
    const strip = parent.createEl("div", { cls: "morning-os-identity-strip" });
    strip.createEl("div", { cls: "morning-os-identity-label", text: "I am someone who" });
    const rules = strip.createEl("div", { cls: "morning-os-identity-rules" });
    for (const rule of this.brief!.identity.rules) {
      rules.createEl("span", { cls: "morning-os-identity-rule", text: rule });
    }
  }

  private renderGoals(parent: HTMLElement) {
    const wrap = parent.createEl("div", { cls: "morning-os-goals-wrap" });
    const toggle = wrap.createEl("div", { cls: "morning-os-goals-toggle" });
    toggle.createEl("span", { cls: "morning-os-goals-toggle-label", text: "Goals" });
    toggle.createEl("span", { cls: "morning-os-goals-toggle-hint", text: "hover to reveal" });

    const panel = wrap.createEl("div", { cls: "morning-os-goals-panel" });
    const grid = panel.createEl("div", { cls: "morning-os-goals-grid" });

    const short = grid.createEl("div", { cls: "morning-os-goals-col" });
    short.createEl("h2", { text: "Short-term" });
    const sl = short.createEl("div", { cls: "morning-os-card" }).createEl("ul");
    for (const item of this.brief!.goals.short_term) sl.createEl("li", { text: item });

    const long = grid.createEl("div", { cls: "morning-os-goals-col" });
    long.createEl("h2", { text: "Long-term" });
    const ll = long.createEl("div", { cls: "morning-os-card" }).createEl("ul");
    for (const item of this.brief!.goals.long_term) ll.createEl("li", { text: item });
  }

  private renderTasks(parent: HTMLElement) {
    if (this.brief!.tasks.red_alert.length > 0) {
      parent.createEl("h2", { cls: "morning-os-section-heading morning-os-red-heading", text: "Red alert" });
      this.renderTaskList(
        parent.createEl("div", { cls: "morning-os-card morning-os-card-red" }),
        this.brief!.tasks.red_alert
      );
    }
    if (this.brief!.tasks.regular.length > 0) {
      parent.createEl("h2", { cls: "morning-os-section-heading", text: "Regular" });
      this.renderTaskList(
        parent.createEl("div", { cls: "morning-os-card" }),
        this.brief!.tasks.regular
      );
    }
  }

  private renderTaskList(parent: HTMLElement, tasks: Task[]) {
    for (const task of tasks) {
      const row = parent.createEl("div", { cls: "morning-os-task-row" });
      const checkbox = row.createEl("input", { type: "checkbox" });
      checkbox.addEventListener("change", () => row.toggleClass("morning-os-task-done", checkbox.checked));
      row.createEl("span", { cls: "morning-os-task-text", text: task.text });
      if (task.carried_from) {
        const days = this.daysBetween(task.carried_from, this.brief!.date);
        row.createEl("span", { cls: "morning-os-carried-badge", text: `carried ${days}d` });
      }
    }
  }

  private renderTacticalRules(parent: HTMLElement) {
    parent.createEl("h2", { cls: "morning-os-section-heading", text: "Rules for today" });
    const card = parent.createEl("div", { cls: "morning-os-card" });
    const list = card.createEl("ul");
    for (const rule of this.brief!.tactical_rules) {
      list.createEl("li", { text: rule });
    }
  }

  private renderSuggestion(parent: HTMLElement) {
    if (!this.brief!.suggestion) return;
    parent.createEl("h2", { cls: "morning-os-section-heading", text: "Suggestion" });
    const card = parent.createEl("div", { cls: "morning-os-card morning-os-suggestion-card" });
    card.createEl("p", { cls: "morning-os-suggestion-text", text: this.brief!.suggestion.text });
    card.createEl("span", { cls: "morning-os-suggestion-source", text: this.brief!.suggestion.source });
  }

  private renderHobbyTasks(parent: HTMLElement) {
    if (!this.brief!.hobby_tasks?.length) return;
    const section = parent.createEl("div", { cls: "morning-os-hobby" });
    section.createEl("h2", { cls: "morning-os-section-heading", text: "Hobby tasks" });
    const card = section.createEl("div", { cls: "morning-os-card morning-os-hobby-card" });
    const list = card.createEl("ul", { cls: "morning-os-hobby-list" });
    for (const item of this.brief!.hobby_tasks) {
      list.createEl("li", { text: item });
    }
  }

  private renderWins(parent: HTMLElement) {
    const section = parent.createEl("div", { cls: "morning-os-wins" });
    section.createEl("h2", { cls: "morning-os-section-heading", text: "Wins today" });
    const card = section.createEl("div", { cls: "morning-os-card" });
    if (this.brief!.wins.length === 0) {
      card.createEl("p", { cls: "morning-os-empty-state", text: "Fill this before sleep." });
    } else {
      for (const win of this.brief!.wins) card.createEl("p", { text: win });
    }
  }

  private daysBetween(dateStr: string, todayStr: string): number {
    const d1 = new Date(dateStr + "T00:00:00");
    const d2 = new Date(todayStr + "T00:00:00");
    return Math.round((d2.getTime() - d1.getTime()) / (1000 * 60 * 60 * 24));
  }
}
