import { ItemView, WorkspaceLeaf, TFile } from "obsidian";
import { DailyBrief, Task, Reminder } from "./types";
import { MorningOSSettings } from "./settings";
import type MorningOSPlugin from "./main";
import { renderOnboarding } from "./onboarding";
import { scaffoldDailyNote } from "./agent/scaffold-daily-note";
import { todayStr } from "./utils";

export const VIEW_TYPE_MORNING = "morning-os-view";

export class MorningView extends ItemView {
  private brief: DailyBrief | null = null;
  private wins: string[] = [];
  private suggestionReactions: ("up" | "down" | null)[] = [];
  private settings: MorningOSSettings;
  private plugin: MorningOSPlugin;
  private floatingHandle: HTMLElement | null = null;
  private floatingActions: HTMLElement | null = null;

  constructor(leaf: WorkspaceLeaf, settings: MorningOSSettings, plugin: MorningOSPlugin) {
    super(leaf);
    this.settings = settings;
    this.plugin = plugin;
  }

  getViewType(): string { return VIEW_TYPE_MORNING; }
  getDisplayText(): string { return "Morning OS"; }
  getIcon(): string { return "sun"; }

  async onOpen() {
    if (!this.settings.onboarded) {
      await this.loadBrief();
      await this.loadWins();
      await this.loadSuggestionReaction();
      this.render();
      return;
    }

    const today = todayStr();
    await scaffoldDailyNote(today, this.app, this.settings);

    const alreadyRan = this.plugin.settings.agentLastRunDate === today;
    if (!alreadyRan) {
      await this.plugin.triggerAgent();
      return;
    }

    await this.loadBrief();
    await this.loadWins();
    await this.loadSuggestionReaction();
    this.render();
  }

  async onClose() {
    this.floatingHandle?.remove();
    this.floatingHandle = null;
    this.floatingActions?.remove();
    this.floatingActions = null;
  }

  async refresh() {
    await this.loadBrief();
    await this.loadWins();
    await this.loadSuggestionReaction();
    this.render();
  }

  private async loadBrief() {
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const file = this.app.vault.getAbstractFileByPath(`${this.settings.briefsDir}/${today}.json`);
    if (file instanceof TFile) {
      this.brief = JSON.parse(await this.app.vault.read(file));
    } else {
      this.brief = null;
    }
  }

  private async loadWins() {
    if (!this.brief) return;
    const notePath = `${this.settings.dailyNoteDir}/${this.brief.date}.md`;
    const file = this.app.vault.getAbstractFileByPath(notePath);
    if (!(file instanceof TFile)) {
      this.wins = this.brief.wins.slice();
      return;
    }
    this.wins = this.parseWinsFromNote(await this.app.vault.read(file));
  }

  private parseWinsFromNote(content: string): string[] {
    const lines = content.split("\n");
    const wins: string[] = [];
    let inWins = false;
    for (const line of lines) {
      const stripped = line.trim();
      const winsRe = new RegExp(`^#{1,3} (?:${this.settings.sectionWins}|I feel good about these after today)\\s*$`, "i");
      if (winsRe.test(stripped)) {
        inWins = true;
        continue;
      }
      if (inWins) {
        if (/^#{1,3} /.test(stripped)) break;
        const match = stripped.match(/^-\s*(?:\[.\]\s+)?(.*)/);
        if (match && match[1].trim()) wins.push(match[1].trim());
      }
    }
    return wins;
  }

  private async loadSuggestionReaction() {
    if (!this.brief) return;
    const count = this.brief.suggestions.length;
    this.suggestionReactions = Array(count).fill(null);
    const file = this.app.vault.getAbstractFileByPath(
      `${this.settings.feedbackDir}/reactions/${this.brief.date}.json`
    );
    if (!(file instanceof TFile)) return;
    try {
      const data = JSON.parse(await this.app.vault.read(file));
      const saved: ("up" | "down" | null)[] = data.suggestion_reactions ?? [];
      for (let i = 0; i < count; i++) {
        this.suggestionReactions[i] = saved[i] ?? null;
      }
    } catch {}
  }

  private render() {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("morning-os");

    if (!this.settings.onboarded) {
      renderOnboarding(container, this.plugin);
      return;
    }

    if (!this.brief) {
      container.createEl("div", {
        cls: "morning-os-empty",
        text: "No brief for today. Run the briefing agent or check _generated/briefs/",
      });
      return;
    }

    this.floatingHandle?.remove();
    this.floatingHandle = null;
    this.floatingActions?.remove();
    this.floatingActions = null;
    this.renderFloatingActions();

    const scroll = container.createEl("div", { cls: "morning-os-scroll" });
    const wrapper = scroll.createEl("div", { cls: "morning-os-wrapper" });

    if (!this.hasApiKey()) {
      this.renderApiKeyBanner(wrapper);
    }

    this.renderHeader(wrapper);
    this.renderIdentityStrip(wrapper);
    this.renderGoals(wrapper);

    const body = wrapper.createEl("div", { cls: "morning-os-body" });
    const left = body.createEl("div", { cls: "morning-os-left" });
    const right = body.createEl("div", { cls: "morning-os-right" });

    this.renderReminders(left);
    this.renderTasks(left);
    this.renderTacticalRules(right);
    this.renderSuggestion(right);

    this.renderPendingTasks(wrapper);
    this.renderHobbyTasks(wrapper);
    this.renderWins(wrapper);
  }

  private hasApiKey(): boolean {
    const s = this.settings;
    const provider = s.intelligenceProvider;
    if (provider === "bedrock") return !!(s.awsAccessKeyId && s.awsSecretAccessKey);
    if (provider === "openai") return !!s.openaiApiKey;
    if (provider === "gemini") return !!s.geminiApiKey;
    if (provider === "groq") return !!s.groqApiKey;
    return false;
  }

  private renderApiKeyBanner(parent: HTMLElement) {
    const banner = parent.createEl("div", { cls: "mos-onboard-banner" });
    banner.createEl("span", {
      text: "Add your API key in Settings → Morning OS to generate personalized briefs.",
    });
    const dismiss = banner.createEl("button", { cls: "mos-onboard-banner-dismiss", text: "✕" });
    dismiss.addEventListener("click", () => banner.remove());
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

  private renderFloatingActions() {
    const container = this.containerEl.children[1] as HTMLElement;
    const handle = container.createEl("div", { cls: "morning-os-floating-handle" });
    const actions = container.createEl("div", { cls: "morning-os-floating-actions" });
    this.floatingHandle = handle;
    this.floatingActions = actions;

    const showActions = () => {
      actions.style.opacity = "1";
      actions.style.pointerEvents = "auto";
    };
    const hideActions = () => {
      actions.style.opacity = "0";
      actions.style.pointerEvents = "none";
    };

    handle.addEventListener("mouseenter", showActions);
    actions.addEventListener("mouseleave", hideActions);

    handle.addEventListener("touchstart", (e: TouchEvent) => {
      e.preventDefault();
      showActions();
    }, { passive: false });

    document.addEventListener("touchstart", (e: TouchEvent) => {
      if (!handle.contains(e.target as Node) && !actions.contains(e.target as Node)) {
        hideActions();
      }
    });

    const refreshBtn = actions.createEl("button", { cls: "morning-os-fab", attr: { "aria-label": "Refresh brief" } });
    refreshBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>`;
    refreshBtn.addEventListener("click", () => this.plugin.triggerRefresh());

    const runBtn = actions.createEl("button", { cls: "morning-os-fab", attr: { "aria-label": "Run agent" } });
    runBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polygon points="10 8 16 12 10 16 10 8"></polygon></svg>`;
    runBtn.addEventListener("click", () => this.plugin.triggerAgent());
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
    const { short_term, long_term } = this.brief!.goals;
    const { short_term_count = 2, long_term_count = 2 } = this.brief!.meta?.goals ?? {};

    const stVisible = short_term.slice(0, short_term_count);
    const stHidden  = short_term.slice(short_term_count);
    const ltVisible = long_term.slice(0, long_term_count);
    const ltHidden  = long_term.slice(long_term_count);

    const wrap = parent.createEl("div", { cls: "morning-os-goals-wrap" });

    const toggle = wrap.createEl("div", { cls: "morning-os-goals-toggle" });
    toggle.createEl("span", { cls: "morning-os-goals-toggle-label", text: "Goals" });
    toggle.addEventListener("click", () => wrap.toggleClass("is-open", !wrap.hasClass("is-open")));

    const preview = toggle.createEl("div", { cls: "morning-os-goals-preview" });
    for (const item of stVisible)
      preview.createEl("span", { cls: "morning-os-goals-preview-pill morning-os-goals-pill-short", text: item });
    for (const item of ltVisible)
      preview.createEl("span", { cls: "morning-os-goals-preview-pill morning-os-goals-pill-long", text: item });

    const hasHidden = stHidden.length > 0 || ltHidden.length > 0;
    if (hasHidden)
      toggle.createEl("span", { cls: "morning-os-goals-toggle-hint", text: `+${stHidden.length + ltHidden.length} more` });

    const panel = wrap.createEl("div", { cls: "morning-os-goals-panel" });
    const grid = panel.createEl("div", { cls: "morning-os-goals-grid" });

    const short = grid.createEl("div", { cls: "morning-os-goals-col" });
    short.createEl("h2", { text: "Short-term" });
    const sl = short.createEl("div", { cls: "morning-os-card" }).createEl("ul");
    for (const item of short_term) sl.createEl("li", { text: item });

    const long = grid.createEl("div", { cls: "morning-os-goals-col" });
    long.createEl("h2", { text: "Long-term" });
    const ll = long.createEl("div", { cls: "morning-os-card" }).createEl("ul");
    for (const item of long_term) ll.createEl("li", { text: item });
  }

  private renderTasks(parent: HTMLElement) {
    const completedRed = this.brief!.tasks.completed_red_alert ?? [];
    const completedRegular = this.brief!.tasks.completed_regular ?? [];

    if (this.brief!.tasks.red_alert.length > 0 || completedRed.length > 0) {
      parent.createEl("h2", { cls: "morning-os-section-heading morning-os-red-heading", text: "Red alert" });
      const card = parent.createEl("div", { cls: "morning-os-card morning-os-card-red" });
      this.renderTaskList(card, this.brief!.tasks.red_alert);
      this.renderCompletedList(card, completedRed);
    }
    if (this.brief!.tasks.regular.length > 0 || completedRegular.length > 0) {
      parent.createEl("h2", { cls: "morning-os-section-heading", text: "Regular" });
      const card = parent.createEl("div", { cls: "morning-os-card" });
      this.renderTaskList(card, this.brief!.tasks.regular);
      this.renderCompletedList(card, completedRegular);
    }
  }

  private renderCompletedList(parent: HTMLElement, tasks: string[]) {
    for (const text of tasks) {
      const row = parent.createEl("div", { cls: "morning-os-task-row morning-os-task-done" });
      const checkbox = row.createEl("input", { type: "checkbox" });
      checkbox.checked = true;
      row.createEl("span", { cls: "morning-os-task-text", text });
      checkbox.addEventListener("change", async () => {
        row.toggleClass("morning-os-task-done", checkbox.checked);
        await this.toggleTaskInNote(text, checkbox.checked);
      });
    }
  }

  private renderTaskList(parent: HTMLElement, tasks: Task[]) {
    for (const task of tasks) {
      const row = parent.createEl("div", { cls: "morning-os-task-row" });
      const checkbox = row.createEl("input", { type: "checkbox" });
      row.createEl("span", { cls: "morning-os-task-text", text: task.text });
      if (task.carried_from) {
        const days = this.daysBetween(task.carried_from, this.brief!.date);
        row.createEl("span", { cls: "morning-os-carried-badge", text: `carried ${days}d` });
      }
      checkbox.addEventListener("change", async () => {
        row.toggleClass("morning-os-task-done", checkbox.checked);
        await this.toggleTaskInNote(task.text, checkbox.checked);
      });
    }
  }

  private async toggleTaskInNote(taskText: string, checked: boolean) {
    const notePath = `${this.settings.dailyNoteDir}/${this.brief!.date}.md`;
    const file = this.app.vault.getAbstractFileByPath(notePath);
    if (!(file instanceof TFile)) return;
    const content = await this.app.vault.read(file);
    const escaped = taskText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // matches both "- [ ] task", "- [x] task", and plain "- task"
    const regex = new RegExp(`^- (?:\\[[xX ]\\] )?${escaped}$`, "m");
    const newContent = content.replace(regex, `- [${checked ? "x" : " "}] ${taskText}`);
    if (newContent !== content) await this.app.vault.modify(file, newContent);
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
    if (!this.brief!.suggestions?.length) return;
    parent.createEl("h2", { cls: "morning-os-section-heading", text: "Suggestions" });
    this.brief!.suggestions.forEach((s, i) => {
      const card = parent.createEl("div", { cls: "morning-os-card morning-os-suggestion-card" });
      card.createEl("p", { cls: "morning-os-suggestion-text", text: s.text });

      const footer = card.createEl("div", { cls: "morning-os-suggestion-footer" });
      footer.createEl("span", { cls: "morning-os-suggestion-source", text: s.source });

      const reactions = footer.createEl("div", { cls: "morning-os-suggestion-reactions" });
      const thumbUp = reactions.createEl("button", { cls: "morning-os-reaction-btn", text: "👍" });
      const thumbDown = reactions.createEl("button", { cls: "morning-os-reaction-btn", text: "👎" });

      if (this.suggestionReactions[i] === "up") thumbUp.addClass("morning-os-reaction-active");
      if (this.suggestionReactions[i] === "down") thumbDown.addClass("morning-os-reaction-active");

      thumbUp.addEventListener("click", async () => {
        const next = this.suggestionReactions[i] === "up" ? null : "up";
        this.suggestionReactions[i] = next;
        thumbUp.toggleClass("morning-os-reaction-active", next === "up");
        thumbDown.removeClass("morning-os-reaction-active");
        await this.writeSuggestionReactions();
      });

      thumbDown.addEventListener("click", async () => {
        const next = this.suggestionReactions[i] === "down" ? null : "down";
        this.suggestionReactions[i] = next;
        thumbDown.toggleClass("morning-os-reaction-active", next === "down");
        thumbUp.removeClass("morning-os-reaction-active");
        await this.writeSuggestionReactions();
      });
    });
  }

  private async writeSuggestionReactions() {
    const today = this.brief!.date;
    const dir = `${this.settings.feedbackDir}/reactions`;
    const filePath = `${dir}/${today}.json`;
    const payload = JSON.stringify(
      { date: today, suggestion_reactions: this.suggestionReactions },
      null, 2
    );
    const existing = this.app.vault.getAbstractFileByPath(filePath);
    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, payload);
    } else {
      try { await this.app.vault.createFolder(dir); } catch {}
      await this.app.vault.create(filePath, payload);
    }
  }

  private renderReminders(parent: HTMLElement) {
    if (!this.brief?.reminders?.length) return;

    parent.createEl("h2", { cls: "morning-os-section-heading", text: "Reminders" });
    const card = parent.createEl("div", { cls: "morning-os-card" });

    for (const reminder of this.brief.reminders) {
      const row = card.createEl("div", { cls: "morning-os-task-row" });
      const checkbox = row.createEl("input", { type: "checkbox" });
      row.createEl("span", { cls: "morning-os-task-text", text: reminder.text });
      row.createEl("span", {
        cls: "morning-os-carried-badge",
        text: `noted ${reminder.source_date}`,
      });
      checkbox.addEventListener("change", async () => {
        row.toggleClass("morning-os-task-done", checkbox.checked);
        if (checkbox.checked) {
          await this.dismissReminder(reminder.text, reminder.source_date, reminder.remind_date);
        }
      });
    }
  }

  private async dismissReminder(text: string, sourceDate: string, remindDate: string) {
    const remindersPath = `${this.settings.briefsDir}/reminders.json`;
    const exists = await this.app.vault.adapter.exists(remindersPath);
    if (!exists) return;

    try {
      const data = JSON.parse(await this.app.vault.adapter.read(remindersPath));
      for (const r of data) {
        if (r.text === text && r.source_date === sourceDate && r.remind_date === remindDate) {
          r.dismissed = true;
        }
      }
      await this.app.vault.adapter.write(remindersPath, JSON.stringify(data, null, 2));
    } catch {}
  }

  private renderPendingTasks(parent: HTMLElement) {
    const tasks = this.brief!.technical_tasks ?? [];
    const count = tasks.length;
    const wrap = parent.createEl("div", { cls: "morning-os-pending-wrap" });
    const toggle = wrap.createEl("div", { cls: "morning-os-pending-toggle" });
    toggle.createEl("span", { cls: "morning-os-pending-label", text: "Pending tasks" });
    toggle.createEl("span", { cls: "morning-os-pending-count", text: `${count}` });

    const panel = wrap.createEl("div", { cls: "morning-os-pending-panel" });
    if (count === 0) {
      panel.createEl("p", { cls: "morning-os-empty-state", text: "No pending technical tasks." });
    } else {
      const list = panel.createEl("ul", { cls: "morning-os-pending-list" });
      for (const item of tasks) list.createEl("li", { text: item });
    }
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

    const list = card.createEl("div", { cls: "morning-os-wins-list" });
    this.renderWinsList(list);

    const inputRow = card.createEl("div", { cls: "morning-os-wins-input-row" });
    const input = inputRow.createEl("input", {
      type: "text",
      cls: "morning-os-wins-input",
      placeholder: "Add a win...",
    });
    const addBtn = inputRow.createEl("button", { cls: "morning-os-wins-add-btn", text: "Add" });

    const addWin = async () => {
      const text = input.value.trim();
      if (!text) return;
      await this.appendWinToNote(text);
      this.wins.push(text);
      input.value = "";
      list.empty();
      this.renderWinsList(list);
    };

    addBtn.addEventListener("click", addWin);
    input.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") addWin();
    });
  }

  private renderWinsList(parent: HTMLElement) {
    if (this.wins.length === 0) {
      parent.createEl("p", { cls: "morning-os-empty-state", text: "Fill this before sleep." });
    } else {
      for (const win of this.wins) {
        parent.createEl("p", { cls: "morning-os-wins-item", text: win });
      }
    }
  }

  private async appendWinToNote(winText: string) {
    const notePath = `${this.settings.dailyNoteDir}/${this.brief!.date}.md`;
    const file = this.app.vault.getAbstractFileByPath(notePath);
    if (!(file instanceof TFile)) return;
    let content = await this.app.vault.read(file);
    const winsHeaderRe = new RegExp(`^#{1,3} (?:${this.settings.sectionWins}|I feel good about these after today)\\s*$`, "im");
    const winsMatch = content.match(winsHeaderRe);
    if (!winsMatch) {
      content = content.trimEnd() + `\n\n## ${this.settings.sectionWins}\n- ${winText}\n`;
    } else {
      const headerEnd = winsMatch.index! + winsMatch[0].length;
      const afterHeader = content.slice(headerEnd);
      const nextSection = afterHeader.search(/\n#{1,3} /);
      if (nextSection === -1) {
        content = content.trimEnd() + `\n- ${winText}`;
      } else {
        const insertPos = headerEnd + nextSection;
        content = content.slice(0, insertPos).trimEnd() + `\n- ${winText}` + content.slice(insertPos);
      }
    }
    await this.app.vault.modify(file, content);
  }

  private daysBetween(dateStr: string, todayStr: string): number {
    const d1 = new Date(dateStr + "T00:00:00");
    const d2 = new Date(todayStr + "T00:00:00");
    return Math.round((d2.getTime() - d1.getTime()) / (1000 * 60 * 60 * 24));
  }
}
