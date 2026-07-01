import { ItemView, WorkspaceLeaf, TFile, Modal, App, sanitizeHTMLToDom, MarkdownRenderer, Component, requestUrl } from "obsidian";
import changelogText from "../CHANGELOG.md";
import { parseChangelog } from "./agent/parse-changelog";

const FEEDBACK_PROXY_URL: string = process.env.FEEDBACK_PROXY_URL ?? "";
const FEEDBACK_SECRET: string    = process.env.FEEDBACK_SECRET ?? "";
import { DailyBrief, Task, TaskRegistry, FieldDef, TabConfig, PillarConfig } from "./types";
import { MorningOSSettings } from "./settings";
import type MorningOSPlugin from "./main";
import { renderOnboarding } from "./onboarding";
import { scaffoldDailyNote } from "./agent/scaffold-daily-note";
import { todayStr } from "./utils";
import { loadRegistry, saveRegistry, setTaskStatus, updateTask, createTask, moveTaskToToday, deleteTask, restoreTask, getActiveReminders, getChildren } from "./task-registry";
import { appendWinToLog, readTodayWinsFromLog } from "./agent/vault-reader";
import { parseIdentityAnchor } from "./agent/vault-reader";

export const VIEW_TYPE_PILLAR = "morning-os-pillar-view";
export const VIEW_TYPE_DUMP = "morning-os-inbox-view";
export const VIEW_TYPE_TRASH = "morning-os-trash-view";

function buildNavItems(pillars: PillarConfig[]) {
  return [
    { id: "home",  label: "🌅 Home",  type: VIEW_TYPE_MORNING },
    { id: "dump",  label: "📥 Inbox", type: VIEW_TYPE_DUMP },
    ...pillars.map(p => ({ id: p.key, label: `${p.icon} ${p.label}`, type: `${VIEW_TYPE_PILLAR}-${p.key}` })),
    { id: "trash", label: "🗑 Trash", type: VIEW_TYPE_TRASH },
  ];
}


export const VIEW_TYPE_MORNING = "morning-os-view";

export class MorningView extends ItemView {
  private brief: DailyBrief | null = null;
  private wins: string[] = [];
  private suggestionReactions: ("up" | "down" | null)[] = [];
  private settings: MorningOSSettings;
  private plugin: MorningOSPlugin;
  private floatingHandle: HTMLElement | null = null;
  private floatingActions: HTMLElement | null = null;
  private floatingCleanup: (() => void) | null = null;
  private registry: TaskRegistry = [];
  private identityLines: string[] = [];

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
      await this.loadRegistryAndIdentity();
      await this.loadWins();
      this.render();
      return;
    }

    const today = todayStr();
    await scaffoldDailyNote(today, this.app, this.settings);

    // Auto-promote tasks with due date_remind to today
    await this.promoteReminders();

    // Always load registry and render immediately — don't block on agent
    await this.loadRegistryAndIdentity();
    await this.loadBrief();
    await this.loadWins();
    await this.loadSuggestionReaction();
    this.render();

    // Trigger agent in background if brief doesn't exist for today
    const briefPath = `${this.settings.briefsDir}/${today}.json`;
    const briefExists = await this.app.vault.adapter.exists(briefPath);
    const alreadyRan = this.plugin.settings.agentLastRunDate === today && briefExists;
    if (!alreadyRan) {
      void this.plugin.triggerAgent();
    }
  }

  async onClose() {
    this.floatingCleanup?.();
    this.floatingCleanup = null;
    this.floatingHandle?.remove();
    this.floatingHandle = null;
    this.floatingActions?.remove();
    this.floatingActions = null;
  }

  async refresh() {
    await this.loadBrief();
    await this.loadWins();
    await this.loadSuggestionReaction();
    await this.loadRegistryAndIdentity();
    this.render();
  }

  private async promoteReminders() {
    const today = todayStr();
    const registry = await loadRegistry(this.app);
    const due = registry.filter(t =>
      !t.is_deleted && !t.is_today &&
      t.status_completion === "open" &&
      t.date_remind !== null && t.date_remind <= today
    );
    if (!due.length) return;
    for (const t of due) {
      t.is_today = true;
      t.date_modified = today;
    }
    await saveRegistry(this.app, registry);
  }

  private async loadRegistryAndIdentity() {
    this.registry = await loadRegistry(this.app);
    this.identityLines = await parseIdentityAnchor(this.app, this.settings);
  }

  private async loadBrief() {
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const file = this.app.vault.getAbstractFileByPath(`${this.settings.briefsDir}/${today}.json`);
    if (file instanceof TFile) {
      this.brief = JSON.parse(await this.app.vault.read(file)) as DailyBrief;
    } else {
      this.brief = null;
    }
  }

  private async loadWins() {
    const today = todayStr();
    const fromLog = await readTodayWinsFromLog(today, this.app, this.settings);
    if (fromLog.length > 0) {
      this.wins = fromLog;
    } else {
      this.wins = this.brief?.wins?.slice() ?? [];
    }
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
    const count = this.brief?.suggestions?.length ?? 0;
    this.suggestionReactions = Array<"up" | "down" | null>(count).fill(null);
    if (!count) return;
    const file = this.app.vault.getAbstractFileByPath(
      `${this.settings.feedbackDir}/reactions/${todayStr()}.json`
    );
    if (!(file instanceof TFile)) return;
    try {
      const data = JSON.parse(await this.app.vault.read(file)) as { suggestion_reactions?: ("up" | "down" | null)[] };
      const saved: ("up" | "down" | null)[] = data.suggestion_reactions ?? [];
      for (let i = 0; i < count; i++) {
        this.suggestionReactions[i] = saved[i] ?? null;
      }
    } catch { /* intentional — corrupt reactions file just resets to no reactions */ }
  }

  private render() {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("morning-os");

    if (!this.settings.onboarded) {
      renderOnboarding(container, this.plugin);
      return;
    }

    this.floatingHandle?.remove();
    this.floatingHandle = null;
    this.floatingActions?.remove();
    this.floatingActions = null;
    this.renderFloatingActions();

    const scroll = container.createEl("div", { cls: "morning-os-scroll" });
    const wrapper = scroll.createEl("div", { cls: "morning-os-wrapper" });

    this.renderWhatsNew(wrapper);

    if (!this.hasApiKey()) {
      this.renderApiKeyBanner(wrapper);
    }

    this.renderHeader(wrapper);
    this.renderIdentityStrip(wrapper);
    this.renderGoals(wrapper);

    const body = wrapper.createEl("div", { cls: "morning-os-body" });
    const left = body.createEl("div", { cls: "morning-os-left" });
    const right = body.createEl("div", { cls: "morning-os-right" });

    this.renderTasks(left);
    this.renderTacticalRules(right);

    this.renderWins(wrapper);
    this.renderFeedbackFooter(wrapper);
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
    const dateObj = new Date(todayStr() + "T00:00:00");
    header.createEl("div", {
      cls: "morning-os-date-weekday",
      text: dateObj.toLocaleDateString("en-US", { weekday: "long" }),
    });
    header.createEl("div", {
      cls: "morning-os-date-numeric",
      text: dateObj.toLocaleDateString("en-US", { day: "numeric", month: "long", year: "numeric" }),
    });
  }

  private renderFloatingActions() {
    const container = this.containerEl.children[1] as HTMLElement;
    const { handle, actions, cleanup } = mountFloatingPanel(container, this.plugin);
    this.floatingHandle = handle;
    this.floatingActions = actions;
    this.floatingCleanup = cleanup;
  }

  private renderIdentityStrip(parent: HTMLElement) {
    const lines = this.identityLines.length > 0 ? this.identityLines : (this.brief?.identity?.rules ?? []);
    if (!lines.length) return;
    const strip = parent.createEl("div", { cls: "morning-os-identity-strip" });
    strip.createEl("div", { cls: "morning-os-identity-label", text: "I am someone who" });
    const rules = strip.createEl("div", { cls: "morning-os-identity-rules" });
    for (const rule of lines) {
      rules.createEl("span", { cls: "morning-os-identity-rule", text: rule });
    }
  }

  private renderGoals(parent: HTMLElement) {
    const goals = this.brief?.goals;
    if (!goals?.short_term?.length && !goals?.long_term?.length) return;
    const { short_term, long_term } = goals;
    const { short_term_count = 2, long_term_count = 2 } = this.brief?.meta?.goals ?? {};

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
    const today = todayStr();
    const redOpen    = this.registry.filter(t => t.is_today && !t.is_deleted && t.status_priority === "red" && t.status_completion !== "done");
    const regOpen    = this.registry.filter(t => t.is_today && !t.is_deleted && t.status_priority === "regular" && t.status_completion !== "done");
    const redDone    = this.registry.filter(t => t.is_today && !t.is_deleted && t.status_priority === "red" && t.status_completion === "done" && t.date_completed === today);
    const regDone    = this.registry.filter(t => t.is_today && !t.is_deleted && t.status_priority === "regular" && t.status_completion === "done" && t.date_completed === today);

    if (!redOpen.length && !regOpen.length && !redDone.length && !regDone.length) {
      const empty = parent.createEl("div", { cls: "morning-os-card morning-os-card-empty" });
      empty.createEl("p", { cls: "morning-os-empty-state", text: "You're all caught up for today." });
      empty.createEl("p", { cls: "morning-os-empty-state", text: "Pick tasks from the Inbox or Pillar views to get started." });
      return;
    }

    if (redOpen.length > 0 || redDone.length > 0) {
      parent.createEl("h2", { cls: "morning-os-section-heading morning-os-red-heading", text: "Red alert" });
      const card = parent.createEl("div", { cls: "morning-os-card morning-os-card-red" });
      this.renderRegistryTaskList(card, redOpen);
      this.renderRegistryDoneList(card, redDone);
    }
    if (regOpen.length > 0 || regDone.length > 0) {
      parent.createEl("h2", { cls: "morning-os-section-heading", text: "Regular" });
      const card = parent.createEl("div", { cls: "morning-os-card" });
      this.renderRegistryTaskList(card, regOpen);
      this.renderRegistryDoneList(card, regDone);
    }
  }

  private renderRegistryTaskList(parent: HTMLElement, tasks: Task[]) {
    for (const task of tasks) {
      const row = parent.createEl("div", { cls: "morning-os-task-row" });
      const checkbox = row.createEl("input", { type: "checkbox" });
      row.createEl("span", { cls: "morning-os-task-text", text: task.text });
      if (task.date_remind) {
        row.createEl("span", { cls: "morning-os-reminder-badge", text: `⏰ ${task.date_remind}` });
      }

      const moreBtn = row.createEl("button", { cls: "mos-more-btn", text: "⋯" });
      moreBtn.addEventListener("click", () => {
        const flipPriority = task.status_priority === "red" ? "regular" : "red";
        const flipLabel = task.status_priority === "red" ? "→ Move to Regular" : "🔴 Move to Red alert";
        const menuItems: MenuAction[] = [
          {
            label: flipLabel,
            action: () => {
              void updateTask(this.app, task._id, { status_priority: flipPriority }).then(async () => {
                await this.plugin.autoRefreshBrief();
                this.plugin.refreshView();
              });
            },
          },
          {
            label: "✕ Remove from today",
            action: () => {
              void (async () => {
                await updateTask(this.app, task._id, { is_today: false });
                await this.plugin.autoRefreshBrief();
                this.plugin.refreshView();
              })();
            },
          },
          {
            label: "✎ Edit metadata",
            action: () => {
              new TaskEditModal(this.app, task, async (updated) => {
                const reg = await loadRegistry(this.app);
                const idx = reg.findIndex(t => t._id === updated._id);
                if (idx !== -1) reg[idx] = updated;
                await saveRegistry(this.app, reg);
                this.plugin.refreshView();
              }, false, this.plugin.settings.pillars).open();
            },
          },
          {
            label: "🗑 Delete",
            danger: true,
            action: () => void deleteTask(this.app, task._id).then(() => this.plugin.refreshView()),
          },
        ];
        openContextMenu(moreBtn, menuItems);
      });

      checkbox.addEventListener("change", () => {
        row.toggleClass("morning-os-task-done", checkbox.checked);
        void setTaskStatus(this.app, task._id, checkbox.checked ? "done" : "open")
          .then(() => this.plugin.refreshView());
      });
    }
  }

  private renderRegistryDoneList(parent: HTMLElement, tasks: Task[]) {
    for (const task of tasks) {
      const row = parent.createEl("div", { cls: "morning-os-task-row morning-os-task-done" });
      const checkbox = row.createEl("input", { type: "checkbox" });
      checkbox.checked = true;
      row.createEl("span", { cls: "morning-os-task-text", text: task.text });
      checkbox.addEventListener("change", () => {
        row.toggleClass("morning-os-task-done", checkbox.checked);
        void setTaskStatus(this.app, task._id, checkbox.checked ? "done" : "open")
          .then(() => this.plugin.refreshView());
      });
    }
  }

  private renderTacticalRules(parent: HTMLElement) {
    const hasTasks = this.registry.some(t => t.is_today && !t.is_deleted && t.status_completion !== "done");
    if (!hasTasks || !this.brief?.tactical_rules?.length) return;
    parent.createEl("h2", { cls: "morning-os-section-heading", text: "Rules for today" });
    const card = parent.createEl("div", { cls: "morning-os-card morning-os-card-rules" });
    const list = card.createEl("ul");
    for (const rule of this.brief.tactical_rules) {
      list.createEl("li", { text: rule });
    }
  }

  private renderSuggestion(parent: HTMLElement) {
    if (!this.brief?.suggestions?.length) return;
    parent.createEl("h2", { cls: "morning-os-section-heading", text: "Suggestions" });
    this.brief.suggestions.forEach((s, i) => {
      const card = parent.createEl("div", { cls: "morning-os-card morning-os-suggestion-card" });
      card.createEl("p", { cls: "morning-os-suggestion-text", text: s.text });

      const footer = card.createEl("div", { cls: "morning-os-suggestion-footer" });
      const sourceLabel: Record<string, string> = {
        tasks: "Today's Tasks",
        goals: "Goals",
        technical_backlog: "Technical Backlog",
        carried_tasks: "Carried Tasks",
        wins: "Yesterday's Wins",
      };
      footer.createEl("span", { cls: "morning-os-suggestion-source", text: sourceLabel[s.source] ?? s.source });

      const reactions = footer.createEl("div", { cls: "morning-os-suggestion-reactions" });
      const thumbUp = reactions.createEl("button", { cls: "morning-os-reaction-btn", text: "👍" });
      const thumbDown = reactions.createEl("button", { cls: "morning-os-reaction-btn", text: "👎" });

      if (this.suggestionReactions[i] === "up") thumbUp.addClass("morning-os-reaction-active");
      if (this.suggestionReactions[i] === "down") thumbDown.addClass("morning-os-reaction-active");

      thumbUp.addEventListener("click", () => {
        const next = this.suggestionReactions[i] === "up" ? null : "up";
        this.suggestionReactions[i] = next;
        thumbUp.toggleClass("morning-os-reaction-active", next === "up");
        thumbDown.removeClass("morning-os-reaction-active");
        void this.writeSuggestionReactions();
      });

      thumbDown.addEventListener("click", () => {
        const next = this.suggestionReactions[i] === "down" ? null : "down";
        this.suggestionReactions[i] = next;
        thumbDown.toggleClass("morning-os-reaction-active", next === "down");
        thumbUp.removeClass("morning-os-reaction-active");
        void this.writeSuggestionReactions();
      });
    });
  }

  private async writeSuggestionReactions() {
    const today = todayStr();
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
      try { await this.app.vault.createFolder(dir); } catch { /* intentional — dir may already exist */ }
      await this.app.vault.create(filePath, payload);
    }
  }

  private renderReminders(parent: HTMLElement) {
    const reminders = getActiveReminders(this.registry);
    if (!reminders.length) return;

    parent.createEl("h2", { cls: "morning-os-section-heading", text: "Reminders" });
    const card = parent.createEl("div", { cls: "morning-os-card" });

    for (const task of reminders) {
      const row = card.createEl("div", { cls: "morning-os-task-row" });
      const checkbox = row.createEl("input", { type: "checkbox" });
      row.createEl("span", { cls: "morning-os-task-text", text: task.text });
      row.createEl("span", { cls: "morning-os-reminder-badge", text: `⏰ ${task.date_remind}` });

      // Dismiss = clear remind date (task stays open)
      const dismissBtn = row.createEl("button", { cls: "mos-task-action-btn mos-task-action-delete", text: "🗑" });
      dismissBtn.setAttribute("aria-label", "Dismiss reminder");
      dismissBtn.addEventListener("click", () => {
        row.remove();
        void updateTask(this.app, task._id, { date_remind: null }).then(() => this.plugin.refreshView());
      });

      // Done = mark task done
      checkbox.addEventListener("change", () => {
        row.toggleClass("morning-os-task-done", checkbox.checked);
        if (checkbox.checked) {
          void setTaskStatus(this.app, task._id, "done").then(() => this.plugin.refreshView());
        }
      });
    }
  }

  private renderPendingTasks(parent: HTMLElement) {
    const tasks = this.brief?.technical_tasks ?? [];
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
    if (!this.brief?.hobby_tasks?.length) return;
    const section = parent.createEl("div", { cls: "morning-os-hobby" });
    section.createEl("h2", { cls: "morning-os-section-heading", text: "Hobby tasks" });
    const card = section.createEl("div", { cls: "morning-os-card morning-os-hobby-card" });
    const list = card.createEl("ul", { cls: "morning-os-hobby-list" });
    for (const item of this.brief!.hobby_tasks ?? []) {
      list.createEl("li", { text: item });
    }
  }

  private renderWins(parent: HTMLElement) {
    const section = parent.createEl("div", { cls: "morning-os-wins" });
    section.createEl("h2", { cls: "morning-os-section-heading morning-os-green-heading", text: "Wins today" });
    const card = section.createEl("div", { cls: "morning-os-card morning-os-card-wins" });

    const list = card.createEl("div", { cls: "morning-os-wins-list" });
    this.renderWinsList(list);

    const inputRow = card.createEl("div", { cls: "morning-os-wins-input-row" });
    const input = inputRow.createEl("input", {
      type: "text",
      cls: "morning-os-wins-input",
      placeholder: "Add a win...",
    });
    const addBtn = inputRow.createEl("button", { cls: "mos-btn mos-btn-primary", text: "Add" });

    const addWin = async () => {
      const text = input.value.trim();
      if (!text) return;
      await this.appendWinToNote(text);
      this.wins.push(text);
      input.value = "";
      list.empty();
      this.renderWinsList(list);
    };

    addBtn.addEventListener("click", () => { void addWin(); });
    input.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") void addWin();
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
    await appendWinToLog(winText, todayStr(), this.app, this.settings);
  }

  private renderWhatsNew(parent: HTMLElement) {
    const manifest = this.plugin.manifest;
    if (manifest.version === this.settings.lastSeenVersion) return;

    const entry = parseChangelog(changelogText, manifest.version);
    if (!entry) return;

    const banner = parent.createEl("div", { cls: "mos-whats-new-banner" });

    const top = banner.createEl("div", { cls: "mos-whats-new-top" });
    const label = top.createEl("span", { cls: "mos-whats-new-label" });
    label.createEl("span", { cls: "mos-whats-new-badge", text: `v${entry.version}` });
    label.createEl("span", { text: " What's new" });
    const dismissBtn = top.createEl("button", { cls: "mos-whats-new-dismiss", text: "Got it ✓" });

    for (const section of entry.sections) {
      banner.createEl("div", { cls: "mos-whats-new-section-heading", text: section.heading });
      if (section.heading.toLowerCase() === "personal") {
        // Personal note renders as paragraphs, not a list
        for (const item of section.items) {
          banner.createEl("p", { cls: "mos-whats-new-note", text: item });
        }
      } else {
        const list = banner.createEl("ul", { cls: "mos-whats-new-list" });
        for (const item of section.items) {
          list.createEl("li", { text: item });
        }
      }
    }

    dismissBtn.addEventListener("click", () => {
      void (async () => {
        this.settings.lastSeenVersion = manifest.version;
        await this.plugin.saveData(this.plugin.settings);
        banner.remove();
      })();
    });
  }

  private renderFeedbackFooter(parent: HTMLElement) {
    const card = parent.createEl("div", { cls: "mos-feedback-card" });

    const left = card.createEl("div", { cls: "mos-feedback-text" });
    left.createEl("div", { cls: "mos-feedback-title", text: "Share your thoughts" });
    left.createEl("div", { cls: "mos-feedback-sub", text: "What's working? What's missing?" });

    const btn = card.createEl("button", { cls: "mos-feedback-btn", text: "Give feedback →" });
    btn.addEventListener("click", () => new FeedbackModal(this.app).open());
  }

  private daysBetween(dateStr: string, todayStr: string): number {
    const d1 = new Date(dateStr + "T00:00:00");
    const d2 = new Date(todayStr + "T00:00:00");
    return Math.round((d2.getTime() - d1.getTime()) / (1000 * 60 * 60 * 24));
  }
}

function mountFloatingPanel(container: HTMLElement, plugin: MorningOSPlugin): { handle: HTMLElement; actions: HTMLElement; cleanup: () => void } {
  const handle = container.createEl("div", { cls: "morning-os-floating-handle" });
  const actions = container.createEl("div", { cls: "morning-os-floating-actions" });

  const show = () => actions.addClass("is-visible");
  const hide = () => actions.removeClass("is-visible");

  handle.addEventListener("mouseenter", show);
  actions.addEventListener("mouseleave", hide);
  handle.addEventListener("touchstart", (e: TouchEvent) => { e.preventDefault(); show(); }, { passive: false });
  const touchHandler = (e: TouchEvent) => {
    if (!handle.contains(e.target as Node) && !actions.contains(e.target as Node)) hide();
  };
  activeDocument.addEventListener("touchstart", touchHandler);
  const cleanup = () => activeDocument.removeEventListener("touchstart", touchHandler);

  actions.createEl("div", { cls: "morning-os-fab-label", text: "Agent" });
  const refreshBtn = actions.createEl("button", { cls: "morning-os-fab" });
  refreshBtn.appendChild(sanitizeHTMLToDom(`<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>`));
  refreshBtn.appendText(" Refresh brief");
  refreshBtn.addEventListener("click", () => { void plugin.triggerRefresh(); });

  const runBtn = actions.createEl("button", { cls: "morning-os-fab" });
  runBtn.appendChild(sanitizeHTMLToDom(`<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polygon points="10 8 16 12 10 16 10 8"></polygon></svg>`));
  runBtn.appendText(" Run agent");
  runBtn.addEventListener("click", () => { void plugin.triggerAgent(); });

  actions.createEl("div", { cls: "morning-os-fab-label", text: "Views" });
  for (const item of buildNavItems(plugin.settings.pillars)) {
    const btn = actions.createEl("button", { cls: "morning-os-fab morning-os-fab-view", text: item.label });
    btn.addEventListener("click", () => {
      hide();
      if (item.id === "home")  void plugin.activateView();
      else if (item.id === "dump")  void plugin.activateDump();
      else if (item.id === "trash") void plugin.activateTrash();
      else void plugin.activatePillar(item.id);
    });
  }

  return { handle, actions, cleanup };
}

type FilterState = {
  priority?: "red" | "regular";
  urgency?: "none" | "low" | "med" | "high";
  remind?: "has" | "due";
  status?: "open" | "done" | "dismissed";
  custom?: Record<string, string>;
};

function applyFilters(tasks: Task[], filters: FilterState): Task[] {
  const today = todayStr();
  return tasks.filter(t => {
    if (filters.priority && t.status_priority !== filters.priority) return false;
    if (filters.urgency && t.status_urgency !== filters.urgency) return false;
    if (filters.remind === "has" && !t.date_remind) return false;
    if (filters.remind === "due" && !(t.date_remind && t.date_remind <= today)) return false;
    if (filters.status && t.status_completion !== filters.status) return false;
    if (filters.custom) {
      for (const [key, val] of Object.entries(filters.custom)) {
        if (val && t.tags[key] !== val) return false;
      }
    }
    return true;
  });
}

function renderFilterSelects(
  parent: HTMLElement,
  filters: FilterState,
  onChange: (f: FilterState) => void,
  showUrgency = false,
  tabFields?: FieldDef[]
) {
  const mkSelect = (
    opts: { value: string; label: string }[],
    current: string | undefined,
    onchange: (v: string) => void
  ) => {
    const sel = parent.createEl("select", { cls: "mos-btn mos-btn-select mos-filter-select" });
    for (const o of opts) {
      const opt = sel.createEl("option", { value: o.value, text: o.label });
      if ((current ?? "") === o.value) opt.selected = true;
    }
    sel.addEventListener("change", () => onchange(sel.value));
  };

  mkSelect(
    [{ value: "", label: "Priority: All" }, { value: "red", label: "🔴 Red" }, { value: "regular", label: "Regular" }],
    filters.priority,
    v => onChange({ ...filters, priority: v as FilterState["priority"] || undefined })
  );

  mkSelect(
    [{ value: "", label: "Status: All" }, { value: "open", label: "Open" }, { value: "done", label: "Done" }, { value: "dismissed", label: "Dismissed" }],
    filters.status,
    v => onChange({ ...filters, status: v as FilterState["status"] || undefined })
  );

  if (showUrgency) {
    mkSelect(
      [{ value: "", label: "Urgency: All" }, { value: "none", label: "—" }, { value: "low", label: "Low" }, { value: "med", label: "Med" }, { value: "high", label: "High" }],
      filters.urgency,
      v => onChange({ ...filters, urgency: v as FilterState["urgency"] || undefined })
    );
  }

  mkSelect(
    [{ value: "", label: "Remind: All" }, { value: "has", label: "Has reminder" }, { value: "due", label: "Due today" }],
    filters.remind,
    v => onChange({ ...filters, remind: v as FilterState["remind"] || undefined })
  );

  // Custom field filters (dropdown fields only)
  if (tabFields?.length) {
    for (const field of tabFields) {
      if (field.type === "dropdown" && field.options?.length) {
        const opts = [{ value: "", label: `${field.label}: All` }, ...field.options.map(o => ({ value: o, label: o }))];
        const currentCustom = filters.custom?.[field.key];
        mkSelect(opts, currentCustom, v => {
          const custom = { ...(filters.custom ?? {}) };
          if (v) custom[field.key] = v;
          else delete custom[field.key];
          onChange({ ...filters, custom: Object.keys(custom).length > 0 ? custom : undefined });
        });
      }
    }
  }
}


type SortField = "date_created" | "date_modified" | "date_completed" | "name";
type SortDir = "asc" | "desc";

function sortTasks(tasks: Task[], field: SortField, dir: SortDir): Task[] {
  return [...tasks].sort((a, b) => {
    const va = field === "name" ? a.text : (a[field] ?? "");
    const vb = field === "name" ? b.text : (b[field] ?? "");
    if (va < vb) return dir === "asc" ? -1 : 1;
    if (va > vb) return dir === "asc" ? 1 : -1;
    return 0;
  });
}

const URGENCY_DOT: Record<string, string> = { low: "#3fb950", med: "#c9a84c", high: "#e5534b", none: "transparent" };
const URGENCY_LABEL: Record<string, string> = { low: "L", med: "M", high: "H", none: "" };

type MenuAction = { label: string; danger?: boolean; action: () => void };

function openContextMenu(anchor: HTMLElement, items: MenuAction[]) {
  document.querySelector(".mos-ctx-menu")?.remove();
  const menu = document.body.createEl("div", { cls: "mos-ctx-menu" });
  const rect = anchor.getBoundingClientRect();
  menu.style.position = "fixed";
  menu.style.top = `${rect.bottom + 4}px`;
  menu.style.left = `${rect.left}px`;
  menu.style.zIndex = "9999";

  for (const item of items) {
    const btn = menu.createEl("button", {
      cls: "mos-ctx-item" + (item.danger ? " mos-ctx-item-danger" : ""),
      text: item.label,
    });
    btn.addEventListener("click", () => { menu.remove(); item.action(); });
  }

  const close = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) { menu.remove(); document.removeEventListener("mousedown", close); }
  };
  document.addEventListener("mousedown", close);
}

function renderTaskRowShared(
  parent: HTMLElement,
  task: Task,
  app: App,
  onRefresh: () => void,
  plugin?: MorningOSPlugin,
  showUrgency = false,
  tabFields?: FieldDef[]
) {
  const isDone = task.status_completion === "done";
  const row = parent.createEl("div", { cls: "morning-os-task-row" + (isDone ? " morning-os-task-done" : "") });
  const checkbox = row.createEl("input", { type: "checkbox" });
  checkbox.checked = isDone;

  // Urgency dot
  const dot = row.createEl("span", { cls: "mos-urgency-dot", attr: { title: `Urgency: ${task.status_urgency}` } });
  dot.style.background = URGENCY_DOT[task.status_urgency] ?? URGENCY_DOT.none;
  dot.textContent = URGENCY_LABEL[task.status_urgency] ?? "";

  // Inline text — double-click to edit
  const textSpan = row.createEl("span", { cls: "morning-os-task-text", text: task.text });
  textSpan.addEventListener("dblclick", () => {
    const input = document.createElement("input");
    input.type = "text";
    input.value = task.text;
    input.className = "morning-os-wins-input mos-inline-edit";
    textSpan.replaceWith(input);
    input.focus();
    let saving = false;
    const save = async () => {
      if (saving) return;
      saving = true;
      const newText = input.value.trim();
      if (newText && newText !== task.text) {
        const reg = await loadRegistry(app);
        const idx = reg.findIndex(t => t._id === task._id);
        if (idx !== -1) { reg[idx].text = newText; reg[idx].date_modified = todayStr(); }
        await saveRegistry(app, reg);
        onRefresh();
      } else {
        input.replaceWith(textSpan);
      }
    };
    input.addEventListener("blur", () => { void save(); });
    input.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") void save();
      if (e.key === "Escape") input.replaceWith(textSpan);
    });
  });

  if (task.date_remind) {
    row.createEl("span", { cls: "morning-os-reminder-badge", text: `⏰ ${task.date_remind}` });
  }

  // Meta field chips (pillar tab context only)
  if (tabFields?.length) {
    const chipRow = row.createEl("span", { cls: "mos-task-meta-chips" });
    for (const field of tabFields) {
      const val = task.tags[field.key];
      if (val) chipRow.createEl("span", { cls: "mos-meta-chip", text: `${field.label}: ${val}` });
    }
  }

  // Action buttons — today regular, today red alert, ⋯ menu
  const actions = row.createEl("div", { cls: "mos-task-action-bar" });

  actions.createEl("button", { cls: "mos-action-btn", attr: { title: "→ Today (Regular)" }, text: "›" })
    .addEventListener("click", () => {
      void moveTaskToToday(app, task._id, "regular").then(async () => {
        if (plugin) { await plugin.autoRefreshBrief(); plugin.refreshView(); }
        onRefresh();
      });
    });

  actions.createEl("button", { cls: "mos-action-btn mos-action-btn-red", attr: { title: "→ Today (Red alert)" }, text: "»" })
    .addEventListener("click", () => {
      void moveTaskToToday(app, task._id, "red").then(async () => {
        if (plugin) { await plugin.autoRefreshBrief(); plugin.refreshView(); }
        onRefresh();
      });
    });

  const moreBtn = actions.createEl("button", { cls: "mos-action-btn", attr: { title: "More actions" }, text: "⋯" });
  moreBtn.addEventListener("click", () => {
    const menuItems: MenuAction[] = [
      {
        label: "✎ Edit metadata",
        action: () => {
          new TaskEditModal(app, task, async (updated) => {
            const reg = await loadRegistry(app);
            const idx = reg.findIndex(t => t._id === updated._id);
            if (idx !== -1) reg[idx] = updated;
            await saveRegistry(app, reg);
            if (plugin) plugin.refreshView();
            onRefresh();
          }, showUrgency, plugin?.settings.pillars ?? []).open();
        },
      },
      {
        label: "🗑 Delete",
        danger: true,
        action: () => {
          void deleteTask(app, task._id).then(() => {
            if (plugin) plugin.refreshView();
            onRefresh();
          });
        },
      },
    ];
    openContextMenu(moreBtn, menuItems);
  });

  checkbox.addEventListener("change", () => {
    row.toggleClass("morning-os-task-done", checkbox.checked);
    void setTaskStatus(app, task._id, checkbox.checked ? "done" : "open").then(() => {
      if (plugin) plugin.refreshView();
    });
  });

  return row;
}

function renderAddTaskInput(parent: HTMLElement, placeholder: string, onAdd: (text: string) => Promise<void>) {
  const row = parent.createEl("div", { cls: "morning-os-wins-input-row" });
  const input = row.createEl("input", { type: "text", cls: "morning-os-wins-input", placeholder });
  const btn = row.createEl("button", { cls: "mos-btn mos-btn-primary", text: "Add" });
  const add = async () => {
    const text = input.value.trim();
    if (!text) return;
    await onAdd(text);
    input.value = "";
  };
  btn.addEventListener("click", () => { void add(); });
  input.addEventListener("keydown", (e: KeyboardEvent) => { if (e.key === "Enter") void add(); });
}

export class PillarView extends ItemView {
  private settings: MorningOSSettings;
  private plugin: MorningOSPlugin;
  private registry: TaskRegistry = [];
  private activeTab: string | null = null;
  private pillarKey: string;
  private sortField: SortField = "date_created";
  private sortDir: SortDir = "asc";
  private floatingCleanup: (() => void) | null = null;
  private filters: FilterState = {};

  constructor(leaf: WorkspaceLeaf, settings: MorningOSSettings, plugin: MorningOSPlugin, pillarKey: string) {
    super(leaf);
    this.settings = settings;
    this.plugin = plugin;
    this.pillarKey = pillarKey;
  }

  getViewType(): string { return `${VIEW_TYPE_PILLAR}-${this.pillarKey}`; }
  getDisplayText(): string { return this.plugin.settings.pillars.find(p => p.key === this.pillarKey)?.label ?? this.pillarKey; }
  getIcon(): string { return "layers"; }

  async onOpen() { this.registry = await loadRegistry(this.app); this.render(); }
  async refresh() { this.registry = await loadRegistry(this.app); this.render(); }
  async onClose() { this.floatingCleanup?.(); this.floatingCleanup = null; }

  private render() {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("morning-os");
    this.floatingCleanup?.();
    this.floatingCleanup = mountFloatingPanel(container, this.plugin).cleanup;

    const pillar = this.plugin.settings.pillars.find(p => p.key === this.pillarKey);
    if (!pillar) return;

    const wrapper = container.createEl("div", { cls: "morning-os-scroll" });
    const inner = wrapper.createEl("div", { cls: "morning-os-wrapper" });

    const titleRow = inner.createEl("div", { cls: "mos-view-title-row" });
    titleRow.createEl("h1", { cls: "morning-os-section-heading", text: `${pillar.icon} ${pillar.label}` });
    this.renderSortControls(titleRow);

    // Pillar markdown notes section
    void this.renderPillarNotes(inner, pillar);

    if (pillar.tabs.length > 0) {
      const tabBar = inner.createEl("div", { cls: "mos-pillar-tabs" });
      const allTab = tabBar.createEl("button", { cls: "mos-btn mos-btn-tab" + (!this.activeTab ? " is-active" : ""), text: "All" });
      allTab.addEventListener("click", () => { this.activeTab = null; this.render(); });
      for (const tab of pillar.tabs) {
        const btn = tabBar.createEl("button", { cls: "mos-btn mos-btn-tab" + (this.activeTab === tab?.key ? " is-active" : ""), text: tab.label });
        btn.addEventListener("click", () => { this.activeTab = tab.key; this.render(); });
      }
    }

    // Active tab config (for field rendering)
    const activeTabConfig = pillar.tabs.find(t => t.key === this.activeTab) ?? null;

    renderFilterSelects(titleRow, this.filters, (f) => { this.filters = f; this.render(); }, false, activeTabConfig?.fields);

    // View mode: table vs cards
    if (activeTabConfig?.view_mode === "table") {
      this.renderTableView(inner, activeTabConfig, pillar);
    } else {
      // Records section (card view)
      const records = this.registry.filter(t =>
        t.is_entity && !t.is_deleted && t.pillars.includes(this.pillarKey) &&
        (this.activeTab === null || t.tags[this.pillarKey] === this.activeTab)
      );
      if (records.length > 0) {
        inner.createEl("h2", { cls: "morning-os-section-heading", text: "Records" });
        const recordsCard = inner.createEl("div", { cls: "morning-os-card" });
        for (const record of records) {
          this.renderRecordCard(recordsCard, record, activeTabConfig);
        }
      }

      // "Add record" button
      const addRecordBtn = inner.createEl("button", { cls: "mos-btn mos-btn-inline", text: "+ Add record" });
      addRecordBtn.addEventListener("click", async () => {
        const name = prompt("Record name:");
        if (!name?.trim()) return;
        const tag = this.activeTab ? { [pillar.key]: this.activeTab } : {};
        const task = createTask(name.trim(), { is_entity: true, pillars: [pillar.key], tags: tag });
        const reg = await loadRegistry(this.app);
        reg.push(task);
        await saveRegistry(this.app, reg);
        await this.refresh();
      });

      // Flat tasks section
      let tasks = this.registry.filter(t =>
        !t.is_deleted && !t.is_entity && t.parent_id === null &&
        t.pillars.includes(this.pillarKey) &&
        (this.activeTab === null || t.tags[this.pillarKey] === this.activeTab)
      );
      tasks = applyFilters(tasks, this.filters);
      tasks = sortTasks(tasks, this.sortField, this.sortDir);

      if (tasks.length === 0 && records.length === 0) {
        inner.createEl("p", { cls: "morning-os-empty-state", text: "No tasks here yet." });
      } else if (tasks.length > 0) {
        const card = inner.createEl("div", { cls: "morning-os-card" });
        const fields = activeTabConfig?.fields ?? [];
        for (const t of tasks) renderTaskRowShared(card, t, this.app, () => void this.refresh(), this.plugin, false, fields);
      }

      renderAddTaskInput(inner, "Add task… (#p/pillar, #t/tab, @remind(YYYY-MM-DD))", async (text) => {
        const activeTab = this.activeTab;
        const tag = activeTab ? { [pillar.key]: activeTab } : {};
        const task = createTask(text, { pillars: [pillar.key], tags: tag });
        const reg = await loadRegistry(this.app);
        reg.push(task);
        await saveRegistry(this.app, reg);
        await this.refresh();
      });
    }
  }

  private renderTableView(parent: HTMLElement, tabConfig: TabConfig, pillar: PillarConfig) {
    const fields = tabConfig.fields;
    const allItems = this.registry.filter(t =>
      !t.is_deleted && t.pillars.includes(this.pillarKey) &&
      t.tags[this.pillarKey] === tabConfig.key
    );
    const items = sortTasks(applyFilters(allItems, this.filters), this.sortField, this.sortDir);

    const table = parent.createEl("table", { cls: "mos-table" });
    const thead = table.createEl("thead");
    const headRow = thead.createEl("tr");
    headRow.createEl("th", { cls: "mos-table-th mos-table-check", text: "✓" });
    headRow.createEl("th", { cls: "mos-table-th", text: "Name" });
    for (const f of fields) headRow.createEl("th", { cls: "mos-table-th", text: f.label });
    headRow.createEl("th", { cls: "mos-table-th mos-table-actions", text: "" });

    const tbody = table.createEl("tbody");
    for (const task of items) {
      const tr = tbody.createEl("tr", { cls: "mos-table-row" + (task.status_completion === "done" ? " mos-table-row-done" : "") });

      // Checkbox cell
      const checkTd = tr.createEl("td", { cls: "mos-table-td mos-table-check" });
      const cb = checkTd.createEl("input", { type: "checkbox" });
      cb.checked = task.status_completion === "done";
      cb.addEventListener("change", () => {
        const newStatus = cb.checked ? "done" : "open";
        void setTaskStatus(this.app, task._id, newStatus).then(async () => {
          if (this.plugin) { await this.plugin.autoRefreshBrief(); this.plugin.refreshView(); }
          await this.refresh();
        });
      });

      // Name cell (editable on click)
      const nameTd = tr.createEl("td", { cls: "mos-table-td mos-table-name" });
      const nameSpan = nameTd.createEl("span", { text: task.text });
      nameSpan.addEventListener("dblclick", () => {
        const input = document.createElement("input");
        input.type = "text";
        input.value = task.text;
        input.className = "mos-table-inline-edit";
        nameSpan.replaceWith(input);
        input.focus();
        const save = async () => {
          const newText = input.value.trim();
          if (newText && newText !== task.text) {
            await updateTask(this.app, task._id, { text: newText });
            await this.refresh();
          } else {
            input.replaceWith(nameSpan);
          }
        };
        input.addEventListener("blur", () => { void save(); });
        input.addEventListener("keydown", (e: KeyboardEvent) => {
          if (e.key === "Enter") void save();
          if (e.key === "Escape") input.replaceWith(nameSpan);
        });
      });

      // Field cells
      for (const f of fields) {
        const td = tr.createEl("td", { cls: "mos-table-td" });
        const val = task.tags[f.key] ?? "";
        if (f.type === "dropdown" && f.options?.length) {
          const sel = td.createEl("select", { cls: "mos-table-select" });
          sel.createEl("option", { value: "", text: "—" });
          for (const opt of f.options) {
            const optEl = sel.createEl("option", { value: opt, text: opt });
            if (val === opt) optEl.selected = true;
          }
          sel.addEventListener("change", () => {
            const newTags = { ...task.tags };
            if (sel.value) newTags[f.key] = sel.value;
            else delete newTags[f.key];
            void updateTask(this.app, task._id, { tags: newTags }).then(() => this.refresh());
          });
        } else if (f.type === "date") {
          const dateIn = td.createEl("input", { type: "date", cls: "mos-table-date-input" });
          dateIn.value = val;
          dateIn.addEventListener("change", () => {
            const newTags = { ...task.tags };
            if (dateIn.value) newTags[f.key] = dateIn.value;
            else delete newTags[f.key];
            void updateTask(this.app, task._id, { tags: newTags }).then(() => this.refresh());
          });
        } else {
          const cellSpan = td.createEl("span", { text: val || "—", cls: val ? "" : "mos-table-empty" });
          cellSpan.addEventListener("dblclick", () => {
            const input = document.createElement("input");
            input.type = f.type === "url" ? "url" : "text";
            input.value = val;
            input.className = "mos-table-inline-edit";
            cellSpan.replaceWith(input);
            input.focus();
            const save = async () => {
              const newTags = { ...task.tags };
              if (input.value.trim()) newTags[f.key] = input.value.trim();
              else delete newTags[f.key];
              await updateTask(this.app, task._id, { tags: newTags });
              await this.refresh();
            };
            input.addEventListener("blur", () => { void save(); });
            input.addEventListener("keydown", (e: KeyboardEvent) => {
              if (e.key === "Enter") void save();
              if (e.key === "Escape") input.replaceWith(cellSpan);
            });
          });
        }
      }

      // Actions cell
      const actTd = tr.createEl("td", { cls: "mos-table-td mos-table-actions" });
      const actBar = actTd.createEl("div", { cls: "mos-task-action-bar" });

      actBar.createEl("button", { cls: "mos-action-btn", attr: { title: "→ Today (Regular)" }, text: "›" })
        .addEventListener("click", () => {
          void moveTaskToToday(this.app, task._id, "regular").then(async () => {
            if (this.plugin) { await this.plugin.autoRefreshBrief(); this.plugin.refreshView(); }
          });
        });

      actBar.createEl("button", { cls: "mos-action-btn mos-action-btn-red", attr: { title: "→ Today (Red alert)" }, text: "»" })
        .addEventListener("click", () => {
          void moveTaskToToday(this.app, task._id, "red").then(async () => {
            if (this.plugin) { await this.plugin.autoRefreshBrief(); this.plugin.refreshView(); }
          });
        });

      const tableMoreBtn = actBar.createEl("button", { cls: "mos-action-btn", attr: { title: "More actions" }, text: "⋯" });
      tableMoreBtn.addEventListener("click", () => {
        openContextMenu(tableMoreBtn, [
          {
            label: "✎ Edit metadata",
            action: () => {
              new TaskEditModal(this.app, task, async (updated) => {
                const reg = await loadRegistry(this.app);
                const idx = reg.findIndex(t => t._id === updated._id);
                if (idx !== -1) reg[idx] = updated;
                await saveRegistry(this.app, reg);
                if (this.plugin) this.plugin.refreshView();
                void this.refresh();
              }, false, this.plugin?.settings.pillars ?? []).open();
            },
          },
          {
            label: "🗑 Delete",
            danger: true,
            action: () => { void deleteTask(this.app, task._id).then(() => { if (this.plugin) this.plugin.refreshView(); }); },
          },
        ]);
      });
    }

    // Add row
    const addRow = parent.createEl("div", { cls: "mos-table-add-row" });
    renderAddTaskInput(addRow, "+ Add row…", async (text) => {
      const tag = { [pillar.key]: tabConfig.key };
      const task = createTask(text, { pillars: [pillar.key], tags: tag });
      const reg = await loadRegistry(this.app);
      reg.push(task);
      await saveRegistry(this.app, reg);
      await this.refresh();
    });
  }

  private renderRecordCard(parent: HTMLElement, record: Task, tabConfig: { key: string; label: string; fields: { key: string; label: string }[] } | null) {
    const card = parent.createEl("div", { cls: "mos-record-card" });
    const header = card.createEl("div", { cls: "mos-record-header" });

    let expanded = false;
    const toggle = header.createEl("span", { cls: "mos-record-toggle", text: "▶" });
    header.createEl("span", { cls: "mos-record-name", text: record.text });

    // Meta chips
    if (tabConfig?.fields.length) {
      const meta = header.createEl("div", { cls: "mos-record-meta" });
      for (const field of tabConfig.fields) {
        const val = record.tags[field.key];
        if (val) meta.createEl("span", { cls: "mos-meta-chip", text: `${field.label}: ${val}` });
      }
    }

    // ⋯ menu
    const moreBtn = header.createEl("button", { cls: "mos-more-btn", text: "⋯" });
    moreBtn.addEventListener("click", () => {
      const menuItems: MenuAction[] = [
        {
          label: "✎ Edit record",
          action: () => new TaskEditModal(this.app, record, async (updated) => {
            const reg = await loadRegistry(this.app);
            const idx = reg.findIndex(t => t._id === updated._id);
            if (idx !== -1) reg[idx] = updated;
            await saveRegistry(this.app, reg);
            this.plugin.refreshView();
          }, false, this.plugin.settings.pillars).open(),
        },
        {
          label: "🗑 Delete record",
          danger: true,
          action: async () => {
            const reg = await loadRegistry(this.app);
            for (const t of reg) {
              if (t._id === record._id || t.parent_id === record._id) {
                t.is_deleted = true;
              }
            }
            await saveRegistry(this.app, reg);
            this.plugin.refreshView();
          },
        },
      ];
      openContextMenu(moreBtn, menuItems);
    });

    // Expandable body
    const body = card.createEl("div", { cls: "mos-record-body" });
    body.style.display = "none";

    toggle.addEventListener("click", () => {
      expanded = !expanded;
      toggle.textContent = expanded ? "▼" : "▶";
      body.style.display = expanded ? "block" : "none";
    });

    // Description
    if (record.description) {
      const desc = body.createEl("div", { cls: "mos-record-description", text: record.description });
      desc.addEventListener("click", () => {
        const ta = document.createElement("textarea");
        ta.className = "mos-record-description-edit morning-os-wins-input";
        ta.value = record.description;
        desc.replaceWith(ta);
        ta.focus();
        const save = async () => {
          const reg = await loadRegistry(this.app);
          const idx = reg.findIndex(t => t._id === record._id);
          if (idx !== -1) { reg[idx].description = ta.value; reg[idx].date_modified = todayStr(); }
          await saveRegistry(this.app, reg);
          await this.refresh();
        };
        ta.addEventListener("blur", () => void save());
      });
    }

    // Children
    const children = getChildren(this.registry, record._id);
    const childrenEl = body.createEl("div", { cls: "mos-record-children" });
    if (children.length > 0) {
      body.createEl("div", { cls: "morning-os-section-heading", text: "Tasks" });
      for (const child of children) {
        renderTaskRowShared(childrenEl, child, this.app, () => void this.refresh(), this.plugin);
      }
    }

    renderAddTaskInput(body, "Add task to this record…", async (text) => {
      const task = createTask(text, { pillars: record.pillars, tags: { ...record.tags }, parent_id: record._id });
      const reg = await loadRegistry(this.app);
      reg.push(task);
      await saveRegistry(this.app, reg);
      await this.refresh();
    });
  }

  private async renderPillarNotes(parent: HTMLElement, pillar: PillarConfig) {
    const userFolder = this.settings.dailyNoteDir.split("/")[0] || "Essential";
    const notesPath = `${userFolder}/Pillars/${pillar.label}.md`;

    const exists = await this.app.vault.adapter.exists(notesPath);
    if (!exists) {
      // Create parent dirs and empty file on first access
      const dir = `${userFolder}/Pillars`;
      if (!(await this.app.vault.adapter.exists(dir))) {
        await this.app.vault.adapter.mkdir(dir);
      }
      await this.app.vault.adapter.write(notesPath, "");
    }

    const content = await this.app.vault.adapter.read(notesPath);

    // Only render section if file has content
    if (!content.trim()) return;

    const section = parent.createEl("div", { cls: "mos-pillar-notes" });
    const header = section.createEl("div", { cls: "mos-pillar-notes-header" });
    header.createEl("span", { cls: "mos-pillar-notes-title", text: "Notes" });
    const editBtn = header.createEl("button", { cls: "mos-btn mos-btn-icon", attr: { title: "Edit notes" }, text: "✎" });
    editBtn.addEventListener("click", async () => {
      const file = this.app.vault.getAbstractFileByPath(notesPath);
      if (file instanceof TFile) {
        const leaf = this.app.workspace.getLeaf("split");
        await leaf.openFile(file);
      }
    });

    const body = section.createEl("div", { cls: "mos-pillar-notes-body" });
    const component = new Component();
    component.load();
    await MarkdownRenderer.render(this.app, content, body, notesPath, component);
  }

  private renderSortControls(parent: HTMLElement) {
    const wrap = parent.createEl("div", { cls: "mos-sort-controls" });
    const fields: SortField[] = ["date_created", "date_modified", "date_completed", "name"];
    const select = wrap.createEl("select", { cls: "mos-btn mos-btn-select" });
    for (const f of fields) {
      const opt = select.createEl("option", { value: f, text: f });
      if (f === this.sortField) opt.selected = true;
    }
    select.addEventListener("change", () => { this.sortField = select.value as SortField; this.render(); });

    const dirBtn = wrap.createEl("button", { cls: "mos-btn mos-btn-icon", text: this.sortDir === "asc" ? "↑" : "↓" });
    dirBtn.addEventListener("click", () => { this.sortDir = this.sortDir === "asc" ? "desc" : "asc"; this.render(); });
  }
}

export class DumpView extends ItemView {
  private settings: MorningOSSettings;
  private plugin: MorningOSPlugin;
  private registry: TaskRegistry = [];
  private sortField: SortField = "date_created";
  private sortDir: SortDir = "desc" as SortDir;
  private floatingCleanup: (() => void) | null = null;
  private filters: FilterState = {};

  constructor(leaf: WorkspaceLeaf, settings: MorningOSSettings, plugin: MorningOSPlugin) {
    super(leaf);
    this.settings = settings;
    this.plugin = plugin;
  }

  getViewType(): string { return VIEW_TYPE_DUMP; }
  getDisplayText(): string { return "Inbox"; }
  getIcon(): string { return "inbox"; }

  async onOpen() { this.registry = await loadRegistry(this.app); this.render(); }
  async refresh() { this.registry = await loadRegistry(this.app); this.render(); }
  async onClose() { this.floatingCleanup?.(); this.floatingCleanup = null; }

  private render() {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("morning-os");
    this.floatingCleanup?.();
    this.floatingCleanup = mountFloatingPanel(container, this.plugin).cleanup;

    const wrapper = container.createEl("div", { cls: "morning-os-scroll" });
    const inner = wrapper.createEl("div", { cls: "morning-os-wrapper" });

    const titleRow = inner.createEl("div", { cls: "mos-view-title-row" });
    titleRow.createEl("h1", { cls: "morning-os-section-heading", text: "Inbox" });
    this.renderSortControls(titleRow);

    renderAddTaskInput(inner, "Capture a task… (#p/pillar, #t/tab, @remind(YYYY-MM-DD))", async (text) => {
      const task = createTask(text);
      const reg = await loadRegistry(this.app);
      reg.push(task);
      await saveRegistry(this.app, reg);
      await this.refresh();
    });

    renderFilterSelects(titleRow, this.filters, (f) => { this.filters = f; this.render(); }, true);

    let tasks = this.registry.filter(t => !t.is_deleted);
    tasks = applyFilters(tasks, this.filters);
    tasks = sortTasks(tasks, this.sortField, this.sortDir);

    if (tasks.length === 0) {
      inner.createEl("p", { cls: "morning-os-empty-state", text: "All clear. Capture fast, organize later." });
    } else {
      const card = inner.createEl("div", { cls: "morning-os-card" });
      for (const t of tasks) renderTaskRowShared(card, t, this.app, () => void this.refresh(), this.plugin, true);
    }
  }

  private renderSortControls(parent: HTMLElement) {
    const wrap = parent.createEl("div", { cls: "mos-sort-controls" });
    const fields: SortField[] = ["date_created", "date_modified", "date_completed", "name"];
    const select = wrap.createEl("select", { cls: "mos-btn mos-btn-select" });
    for (const f of fields) {
      const opt = select.createEl("option", { value: f, text: f });
      if (f === this.sortField) opt.selected = true;
    }
    select.addEventListener("change", () => { this.sortField = select.value as SortField; this.render(); });
    const dirBtn = wrap.createEl("button", { cls: "mos-btn mos-btn-icon", text: this.sortDir === "asc" ? "↑" : "↓" });
    dirBtn.addEventListener("click", () => { this.sortDir = this.sortDir === "asc" ? "desc" : "asc"; this.render(); });
  }
}

import { Modal as ObsidianModal } from "obsidian";

class PriorityPickerModal extends ObsidianModal {
  private onPick: (p: "red" | "regular") => Promise<void>;

  constructor(app: App, onPick: (p: "red" | "regular") => Promise<void>) {
    super(app);
    this.onPick = onPick;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("mos-feedback-modal");
    contentEl.createEl("h2", { text: "Move to Today" });
    contentEl.createEl("p", { text: "Choose priority:" });
    const row = contentEl.createEl("div", { cls: "mos-feedback-type-row" });
    const redBtn = row.createEl("button", { cls: "mos-btn mos-btn-seg", text: "🔴 Red alert" });
    const regBtn = row.createEl("button", { cls: "mos-btn mos-btn-seg", text: "Regular" });
    redBtn.addEventListener("click", () => { void this.onPick("red").then(() => this.close()); });
    regBtn.addEventListener("click", () => { void this.onPick("regular").then(() => this.close()); });
  }

  onClose() { this.contentEl.empty(); }
}

class TaskEditModal extends ObsidianModal {
  private task: Task;
  private onSave: (task: Task) => Promise<void>;
  private showUrgency: boolean;
  private pillarConfigs: PillarConfig[];

  constructor(app: App, task: Task, onSave: (task: Task) => Promise<void>, showUrgency = false, pillarConfigs: PillarConfig[] = []) {
    super(app);
    this.task = { ...task, pillars: [...task.pillars], tags: { ...task.tags } };
    this.onSave = onSave;
    this.showUrgency = showUrgency;
    this.pillarConfigs = pillarConfigs;
  }

  private field(parent: HTMLElement, label: string): HTMLElement {
    const wrap = parent.createEl("div", { cls: "mos-edit-field" });
    wrap.createEl("label", { cls: "mos-edit-label", text: label });
    return wrap;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("mos-edit-modal");
    contentEl.createEl("h2", { cls: "mos-edit-title", text: "Edit task" });

    // Text
    const textWrap = this.field(contentEl, "Text");
    const textInput = textWrap.createEl("input", { type: "text", cls: "mos-edit-input" });
    textInput.value = this.task.text;
    textInput.addEventListener("input", () => { this.task.text = textInput.value.trim(); });

    // Status
    const statusWrap = this.field(contentEl, "Status");
    const statusGroup = statusWrap.createEl("div", { cls: "mos-edit-btn-group" });
    for (const s of ["open", "done", "dismissed"] as const) {
      const btn = statusGroup.createEl("button", {
        cls: "mos-btn mos-btn-seg" + (this.task.status_completion === s ? " is-active" : ""),
        text: s,
      });
      btn.addEventListener("click", () => {
        this.task.status_completion = s;
        statusGroup.querySelectorAll(".mos-btn").forEach(b => b.removeClass("is-active"));
        btn.addClass("is-active");
      });
    }

    // Urgency — inbox only
    if (this.showUrgency) {
      const urgWrap = this.field(contentEl, "Urgency");
      const urgGroup = urgWrap.createEl("div", { cls: "mos-edit-btn-group" });
      for (const u of ["none", "low", "med", "high"] as const) {
        const btn = urgGroup.createEl("button", {
          cls: "mos-btn mos-btn-seg" + (this.task.status_urgency === u ? " is-active" : ""),
          text: u === "none" ? "—" : u,
        });
        btn.addEventListener("click", () => {
          this.task.status_urgency = u;
          urgGroup.querySelectorAll(".mos-btn").forEach(b => b.removeClass("is-active"));
          btn.addClass("is-active");
        });
      }
    }

    // Description (entity/record only)
    if (this.task.is_entity) {
      const descWrap = this.field(contentEl, "Description");
      const descArea = descWrap.createEl("textarea", { cls: "mos-edit-input" });
      (descArea as HTMLTextAreaElement).rows = 3;
      descArea.value = this.task.description ?? "";
      descArea.addEventListener("input", () => { this.task.description = (descArea as HTMLTextAreaElement).value; });
    }

    // Pillars
    if (this.pillarConfigs.length > 0) {
      const pillarsWrap = this.field(contentEl, "Pillars");
      const pillarsGrid = pillarsWrap.createEl("div", { cls: "mos-edit-pillars-grid" });
      for (const pillar of this.pillarConfigs) {
        const cell = pillarsGrid.createEl("div", { cls: "mos-edit-pillar-cell" });
        const cb = cell.createEl("input", { type: "checkbox" });
        cb.checked = this.task.pillars.includes(pillar.key);
        cell.createEl("span", { cls: "mos-edit-pillar-label", text: pillar.label });

        if (pillar.tabs.length > 0) {
          const tabSel = cell.createEl("select", { cls: "mos-edit-select" });
          tabSel.createEl("option", { value: "", text: "— tab —" });
          for (const tab of pillar.tabs) {
            const opt = tabSel.createEl("option", { value: tab.key, text: tab.label });
            if (this.task.tags[pillar.key] === tab.key) opt.selected = true;
          }
          tabSel.style.display = cb.checked ? "block" : "none";
          cb.addEventListener("change", () => { tabSel.style.display = cb.checked ? "block" : "none"; });
          tabSel.addEventListener("change", () => { this.task.tags[pillar.key] = tabSel.value; });
        }

        cb.addEventListener("change", () => {
          if (cb.checked) { if (!this.task.pillars.includes(pillar.key)) this.task.pillars.push(pillar.key); }
          else { this.task.pillars = this.task.pillars.filter(p => p !== pillar.key); delete this.task.tags[pillar.key]; }
        });
      }
    }

    // Custom fields — render based on pillar/tab context
    const taskPillar = this.task.pillars[0];
    const pillarConfig = taskPillar ? this.pillarConfigs.find(p => p.key === taskPillar) : undefined;
    const taskTabKey = taskPillar ? this.task.tags[taskPillar] : undefined;
    const tabConfig = taskTabKey ? pillarConfig?.tabs.find(t => t.key === taskTabKey) : undefined;
    if (tabConfig?.fields.length) {
      const fieldsWrap = this.field(contentEl, "Fields");
      for (const fieldDef of tabConfig.fields) {
        const fRow = fieldsWrap.createEl("div", { cls: "mos-edit-field-row" });
        fRow.createEl("label", { cls: "mos-edit-label", text: fieldDef.label });
        const currentVal = this.task.tags[fieldDef.key] ?? "";
        if (fieldDef.type === "dropdown" && fieldDef.options?.length) {
          const sel = fRow.createEl("select", { cls: "mos-edit-input" });
          sel.createEl("option", { value: "", text: `— ${fieldDef.label} —` });
          for (const opt of fieldDef.options) {
            const optEl = sel.createEl("option", { value: opt, text: opt });
            if (currentVal === opt) optEl.selected = true;
          }
          sel.addEventListener("change", () => {
            if (sel.value) this.task.tags[fieldDef.key] = sel.value;
            else delete this.task.tags[fieldDef.key];
          });
        } else if (fieldDef.type === "date") {
          const dateIn = fRow.createEl("input", { type: "date", cls: "mos-edit-input" });
          dateIn.value = currentVal;
          dateIn.addEventListener("change", () => {
            if (dateIn.value) this.task.tags[fieldDef.key] = dateIn.value;
            else delete this.task.tags[fieldDef.key];
          });
        } else {
          const textIn = fRow.createEl("input", { type: fieldDef.type === "url" ? "url" : "text", cls: "mos-edit-input" });
          textIn.value = currentVal;
          textIn.placeholder = fieldDef.type === "url" ? "https://..." : "";
          textIn.addEventListener("input", () => {
            if (textIn.value.trim()) this.task.tags[fieldDef.key] = textIn.value.trim();
            else delete this.task.tags[fieldDef.key];
          });
        }
      }
    }

    // Remind date
    const remindWrap = this.field(contentEl, "Remind date");
    const remindInput = remindWrap.createEl("input", { type: "date", cls: "mos-edit-input" });
    remindInput.value = this.task.date_remind ?? "";
    remindInput.addEventListener("change", () => { this.task.date_remind = remindInput.value || null; });

    const footer = contentEl.createEl("div", { cls: "mos-edit-footer" });
    const saveBtn = footer.createEl("button", { cls: "mos-btn mos-btn-primary", text: "Save" });
    const cancelBtn = footer.createEl("button", { cls: "mos-btn", text: "Cancel" });
    saveBtn.addEventListener("click", () => { void this.onSave(this.task).then(() => this.close()); });
    cancelBtn.addEventListener("click", () => this.close());
  }

  onClose() { this.contentEl.empty(); }
}

export class TrashView extends ItemView {
  private settings: MorningOSSettings;
  private plugin: MorningOSPlugin;
  private registry: TaskRegistry = [];
  private floatingCleanup: (() => void) | null = null;

  constructor(leaf: WorkspaceLeaf, settings: MorningOSSettings, plugin: MorningOSPlugin) {
    super(leaf);
    this.settings = settings;
    this.plugin = plugin;
  }

  getViewType(): string { return VIEW_TYPE_TRASH; }
  getDisplayText(): string { return "Trash"; }
  getIcon(): string { return "trash"; }

  async onOpen() { this.registry = await loadRegistry(this.app); this.render(); }
  async refresh() { this.registry = await loadRegistry(this.app); this.render(); }
  async onClose() { this.floatingCleanup?.(); this.floatingCleanup = null; }

  private render() {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("morning-os");
    this.floatingCleanup?.();
    this.floatingCleanup = mountFloatingPanel(container, this.plugin).cleanup;

    const wrapper = container.createEl("div", { cls: "morning-os-scroll" });
    const inner = wrapper.createEl("div", { cls: "morning-os-wrapper" });
    inner.createEl("h1", { cls: "morning-os-section-heading", text: "Trash" });

    this.renderTrashSection(inner, this.registry.filter(t => t.is_deleted), "Deleted");
  }

  private renderTrashSection(parent: HTMLElement, tasks: Task[], label: string) {
    parent.createEl("h2", { cls: "morning-os-section-heading", text: `${label} (${tasks.length})` });
    if (tasks.length === 0) {
      parent.createEl("p", { cls: "morning-os-empty-state", text: `No ${label.toLowerCase()} tasks.` });
      return;
    }
    const card = parent.createEl("div", { cls: "morning-os-card" });
    for (const task of tasks) {
      const row = card.createEl("div", { cls: "morning-os-task-row morning-os-task-done" });
      row.createEl("span", { cls: "morning-os-task-text", text: task.text });
      row.createEl("span", { cls: "morning-os-reminder-badge", text: task.date_modified });

      const restoreBtn = row.createEl("button", { cls: "mos-task-action-btn", text: "Restore" });
      restoreBtn.addEventListener("click", () => {
        void (async () => {
          const reg = await loadRegistry(this.app);
          const idx = reg.findIndex(t => t._id === task._id);
          if (idx !== -1) {
            reg[idx].is_deleted = false;
            reg[idx].status_completion = "open";
            reg[idx].date_modified = todayStr();
          }
          await saveRegistry(this.app, reg);
          this.plugin.refreshView();
          void this.refresh();
        })();
      });

      const permDeleteBtn = row.createEl("button", { cls: "mos-task-action-btn mos-task-action-delete", text: "Delete permanently" });
      permDeleteBtn.addEventListener("click", () => {
        void (async () => {
          const reg = await loadRegistry(this.app);
          await saveRegistry(this.app, reg.filter(t => t._id !== task._id));
          this.plugin.refreshView();
          void this.refresh();
        })();
      });
    }
  }
}

export class CaptureModal extends ObsidianModal {
  private onCapture: (text: string) => Promise<void>;

  constructor(app: App, onCapture: (text: string) => Promise<void>) {
    super(app);
    this.onCapture = onCapture;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("mos-feedback-modal");
    contentEl.createEl("h2", { text: "Capture task" });

    const input = contentEl.createEl("input", {
      type: "text",
      cls: "morning-os-wins-input",
    });
    input.placeholder = "Task text… (#p/career, #t/applications, @remind(YYYY-MM-DD))";
    input.style.width = "100%";

    const footer = contentEl.createEl("div", { cls: "mos-feedback-modal-footer" });
    const hint = footer.createEl("span", { cls: "mos-feedback-status", text: "Enter to save" });
    void hint;

    const save = async () => {
      const text = input.value.trim();
      if (!text) return;
      await this.onCapture(text);
      this.close();
    };

    input.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") void save();
      if (e.key === "Escape") this.close();
    });

    // Focus immediately so user can type without clicking
    window.setTimeout(() => input.focus(), 50);
  }

  onClose() { this.contentEl.empty(); }
}

class FeedbackModal extends Modal {
  private type: "bug" | "feature" | null = null;
  private description = "";

  constructor(app: App) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("mos-feedback-modal");

    contentEl.createEl("h2", { cls: "mos-feedback-modal-title", text: "Share feedback" });
    contentEl.createEl("p", { cls: "mos-feedback-modal-sub", text: "Your feedback shapes what gets built next." });

    const typeRow = contentEl.createEl("div", { cls: "mos-feedback-type-row" });
    const bugBtn = typeRow.createEl("button", { cls: "mos-btn mos-btn-seg", text: "🐛 Report a bug" });
    const featBtn = typeRow.createEl("button", { cls: "mos-btn mos-btn-seg", text: "✨ Request a feature" });

    const select = (selected: "bug" | "feature") => {
      this.type = selected;
      bugBtn.toggleClass("is-active", selected === "bug");
      featBtn.toggleClass("is-active", selected === "feature");
    };

    bugBtn.addEventListener("click", () => select("bug"));
    featBtn.addEventListener("click", () => select("feature"));

    const textarea = contentEl.createEl("textarea", { cls: "mos-feedback-textarea" });
    textarea.placeholder = "Describe briefly…";
    textarea.rows = 4;
    textarea.addEventListener("input", () => { this.description = textarea.value.trim(); });

    const footer = contentEl.createEl("div", { cls: "mos-feedback-modal-footer" });
    const status = footer.createEl("span", { cls: "mos-feedback-status" });
    const submitBtn = footer.createEl("button", { cls: "mos-btn mos-btn-primary", text: "Submit →" });

    submitBtn.addEventListener("click", () => {
      void (async () => {
        if (!this.type) { status.setText("Please select bug or feature request."); return; }
        if (!this.description) { status.setText("Please add a short description."); return; }
        if (!FEEDBACK_PROXY_URL) { status.setText("Feedback not configured."); return; }

        submitBtn.setAttr("disabled", "true");
        submitBtn.setText("Sending…");
        status.setText("");

        try {
          const res = await requestUrl({
            url: FEEDBACK_PROXY_URL,
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${FEEDBACK_SECRET}`,
            },
            body: JSON.stringify({ type: this.type, description: this.description }),
            throw: false,
          });

          if (res.status === 429) {
            status.setText("Slow down — try again in a few minutes.");
            submitBtn.removeAttribute("disabled");
            submitBtn.setText("Submit →");
            return;
          }
          if (res.status < 200 || res.status >= 300) throw new Error(`${res.status}`);

          contentEl.empty();
          contentEl.addClass("mos-feedback-modal");
          contentEl.createEl("div", { cls: "mos-feedback-success", text: "✓ Thanks! Feedback received." });
          const closeBtn = contentEl.createEl("button", { cls: "mos-btn mos-btn-primary", text: "Close" });
          closeBtn.addEventListener("click", () => this.close());
        } catch {
          submitBtn.removeAttribute("disabled");
          submitBtn.setText("Submit →");
          status.setText("Failed to send. Check your connection.");
        }
      })();
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}
