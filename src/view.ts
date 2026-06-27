import { ItemView, WorkspaceLeaf, TFile, Modal, App, requestUrl, sanitizeHTMLToDom } from "obsidian";
import changelogText from "../CHANGELOG.md";
import { parseChangelog } from "./agent/parse-changelog";

const WEBHOOK_BUGS     = "https://discord.com/api/webhooks/1514853476990062683/hNbPlOaE13qKD33xxzDUMmUMhtyUZDqKIIr703U9ri8ug4_ujRqhcp2ohDR18DEU-0x6";
const WEBHOOK_FEATURES = "https://discord.com/api/webhooks/1514853636856090737/zyUYjvGXZdBdrRkv7lBLe4Vaie0YLPENaZgy72xIYNiIWgLyb71ZT7qi7-axEz-Utd0d";
import { DailyBrief, BriefTask, Task, TaskRegistry } from "./types";
import { MorningOSSettings } from "./settings";
import type MorningOSPlugin from "./main";
import { renderOnboarding } from "./onboarding";
import { scaffoldDailyNote } from "./agent/scaffold-daily-note";
import { todayStr } from "./utils";
import { loadRegistry, saveRegistry, toggleTaskDone, updateTask, createTask, clearTaskFromView, moveTaskToToday, deleteTask, restoreTask } from "./task-registry";
import { parseIdentityAnchor } from "./agent/vault-reader";

export const VIEW_TYPE_PILLAR = "morning-os-pillar-view";
export const VIEW_TYPE_DUMP = "morning-os-inbox-view";
export const VIEW_TYPE_TRASH = "morning-os-trash-view";

const NAV_ITEMS = [
  { id: "home",         label: "🌅 Home",         type: "morning-os-view" },
  { id: "dump",         label: "📥 Inbox",         type: "morning-os-inbox-view" },
  { id: "health",       label: "❤️ Health",        type: "morning-os-pillar-view-health" },
  { id: "career",       label: "💼 Career",        type: "morning-os-pillar-view-career" },
  { id: "interests",    label: "✨ Interests",     type: "morning-os-pillar-view-interests" },
  { id: "family",       label: "👨‍👩‍👧 Family",      type: "morning-os-pillar-view-family" },
  { id: "relationship", label: "💞 Relationship",  type: "morning-os-pillar-view-relationship" },
  { id: "trash",        label: "🗑 Trash",          type: VIEW_TYPE_TRASH },
] as const;

function renderNavBar(container: HTMLElement, activeType: string, plugin: MorningOSPlugin) {
  const nav = container.createEl("div", { cls: "mos-nav-bar" });
  for (const item of NAV_ITEMS) {
    const btn = nav.createEl("button", {
      cls: "mos-nav-btn" + (activeType === item.type ? " is-active" : ""),
      text: item.label,
    });
    btn.addEventListener("click", () => {
      if (item.id === "home") void plugin.activateView();
      else if (item.id === "dump") void plugin.activateDump();
      else if (item.id === "trash") void plugin.activateTrash();
      else void plugin.activatePillar(item.id);
    });
  }
}

export function renderNavPopover(anchor: HTMLElement, plugin: MorningOSPlugin) {
  document.querySelector(".mos-nav-popover")?.remove();

  // Walk up to the actual ribbon button element
  let btn: HTMLElement = anchor;
  while (btn.parentElement && !btn.classList.contains("side-dock-ribbon-action")) {
    btn = btn.parentElement;
  }

  const popover = document.body.createEl("div", { cls: "mos-nav-popover" });
  const rect = btn.getBoundingClientRect();
  popover.style.position = "fixed";
  popover.style.left = `${rect.right + 8}px`;
  popover.style.top = `${rect.top}px`;
  popover.style.zIndex = "9999";

  for (const item of NAV_ITEMS) {
    const btn = popover.createEl("button", { cls: "mos-nav-popover-item", text: item.label });
    btn.addEventListener("click", () => {
      popover.remove();
      if (item.id === "home") void plugin.activateView();
      else if (item.id === "dump") void plugin.activateDump();
      else if (item.id === "trash") void plugin.activateTrash();
      else void plugin.activatePillar(item.id);
    });
  }

  // Close on outside click
  const close = (e: MouseEvent) => {
    if (!popover.contains(e.target as Node) && e.target !== anchor) {
      popover.remove();
      document.removeEventListener("mousedown", close);
    }
  };
  document.addEventListener("mousedown", close);
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
      await this.loadBrief();
      await this.loadWins();
      await this.loadSuggestionReaction();
      this.render();
      return;
    }

    const today = todayStr();
    await scaffoldDailyNote(today, this.app, this.settings);

    const briefPath = `${this.settings.briefsDir}/${today}.json`;
    const briefExists = await this.app.vault.adapter.exists(briefPath);
    const alreadyRan = this.plugin.settings.agentLastRunDate === today && briefExists;
    if (!alreadyRan) {
      await this.plugin.triggerAgent();
      return;
    }

    await this.loadBrief();
    await this.loadWins();
    await this.loadSuggestionReaction();
    await this.loadRegistryAndIdentity();
    this.render();
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
    this.suggestionReactions = Array<"up" | "down" | null>(count).fill(null);
    const file = this.app.vault.getAbstractFileByPath(
      `${this.settings.feedbackDir}/reactions/${this.brief.date}.json`
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

    this.renderReminders(left);
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
    const dateObj = new Date(this.brief!.date + "T00:00:00");
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
    const hasAny = this.brief!.tasks.red_alert.length > 0 || this.brief!.tasks.regular.length > 0 || completedRed.length > 0 || completedRegular.length > 0;

    if (!hasAny) {
      const empty = parent.createEl("div", { cls: "morning-os-card morning-os-card-empty" });
      empty.createEl("p", { cls: "morning-os-empty-state", text: "You're all caught up for today." });
      empty.createEl("p", { cls: "morning-os-empty-state", text: "Pick tasks from the Inbox or Pillar views to get started." });
      return;
    }

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
      checkbox.addEventListener("change", () => {
        row.toggleClass("morning-os-task-done", checkbox.checked);
        void this.toggleTaskInNote(text, checkbox.checked);
      });
    }
  }

  private renderTaskList(parent: HTMLElement, tasks: BriefTask[]) {
    for (const task of tasks) {
      const row = parent.createEl("div", { cls: "morning-os-task-row" });
      const checkbox = row.createEl("input", { type: "checkbox" });
      row.createEl("span", { cls: "morning-os-task-text", text: task.text });
      if (task.carried_from) {
        const days = this.daysBetween(task.carried_from, this.brief!.date);
        row.createEl("span", { cls: "morning-os-carried-badge", text: `carried ${days}d` });
      }

      const moreBtn = row.createEl("button", { cls: "mos-more-btn", text: "⋯" });
      moreBtn.addEventListener("click", () => {
        const menuItems: MenuAction[] = [];
        if (task.id) {
          menuItems.push({
            label: "✕ Remove from today",
            action: () => {
              void (async () => {
                await updateTask(this.app, task.id!, { in_today: false });
                await this.plugin.autoRefreshBrief();
                this.plugin.refreshView();
              })();
            },
          });
          menuItems.push({
            label: "✎ Edit metadata",
            action: () => {
              const fullTask = this.registry.find(t => t.id === task.id);
              if (!fullTask) return;
              new TaskEditModal(this.app, fullTask, async (updated) => {
                const reg = await loadRegistry(this.app);
                const idx = reg.findIndex(t => t.id === updated.id);
                if (idx !== -1) reg[idx] = updated;
                await saveRegistry(this.app, reg);
                this.plugin.refreshView();
              }).open();
            },
          });
          menuItems.push({
            label: "🗑 Delete",
            danger: true,
            action: () => {
              void deleteTask(this.app, task.id!).then(() => this.plugin.refreshView());
            },
          });
        }
        openContextMenu(moreBtn, menuItems);
      });

      checkbox.addEventListener("change", () => {
        row.toggleClass("morning-os-task-done", checkbox.checked);
        if (task.id) {
          void toggleTaskDone(this.app, task.id, checkbox.checked).then(() => this.plugin.refreshView());
        } else {
          void this.toggleTaskInNote(task.text, checkbox.checked);
        }
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
    const hasTasks = this.brief!.tasks.red_alert.length > 0 || this.brief!.tasks.regular.length > 0;
    if (!hasTasks || !this.brief!.tactical_rules?.length) return;
    parent.createEl("h2", { cls: "morning-os-section-heading", text: "Rules for today" });
    const card = parent.createEl("div", { cls: "morning-os-card morning-os-card-rules" });
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
      try { await this.app.vault.createFolder(dir); } catch { /* intentional — dir may already exist */ }
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
        cls: "morning-os-reminder-badge",
        text: `noted ${reminder.source_date}`,
      });
      checkbox.addEventListener("change", () => {
        row.toggleClass("morning-os-task-done", checkbox.checked);
        if (checkbox.checked) {
          void this.dismissReminder(reminder.text, reminder.source_date, reminder.remind_date);
        }
      });

      const dismissBtn = row.createEl("button", { cls: "mos-task-action-btn mos-task-action-delete", text: "🗑" });
      dismissBtn.setAttribute("aria-label", "Dismiss reminder");
      dismissBtn.addEventListener("click", () => {
        row.remove();
        void this.dismissReminder(reminder.text, reminder.source_date, reminder.remind_date);
      });
    }
  }

  private async dismissReminder(text: string, sourceDate: string, remindDate: string) {
    const remindersPath = `${this.settings.briefsDir}/reminders.json`;
    const exists = await this.app.vault.adapter.exists(remindersPath);
    if (!exists) return;

    try {
      // Update reminders.json — mark dismissed
      const data = JSON.parse(await this.app.vault.adapter.read(remindersPath)) as { text: string; source_date: string; remind_date: string; dismissed: boolean }[];
      for (const r of data) {
        if (r.text === text && r.source_date === sourceDate && r.remind_date === remindDate) {
          r.dismissed = true;
        }
      }
      await this.app.vault.adapter.write(remindersPath, JSON.stringify(data, null, 2));

      // Also remove from today's brief.json so reload doesn't restore it
      if (this.brief) {
        this.brief.reminders = (this.brief.reminders ?? []).filter(
          r => !(r.text === text && r.source_date === sourceDate && r.remind_date === remindDate)
        );
        const briefPath = `${this.settings.briefsDir}/${this.brief.date}.json`;
        await this.app.vault.adapter.write(briefPath, JSON.stringify(this.brief, null, 2));
      }
    } catch { /* intentional — failure to dismiss reminder is non-critical */ }
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
  const viewItems: { label: string; action: () => void }[] = [
    { label: "🌅 Home",          action: () => void plugin.activateView() },
    { label: "📥 Inbox",         action: () => void plugin.activateDump() },
    { label: "❤️ Health",        action: () => void plugin.activatePillar("health") },
    { label: "💼 Career",        action: () => void plugin.activatePillar("career") },
    { label: "✨ Interests",     action: () => void plugin.activatePillar("interests") },
    { label: "👨‍👩‍👧 Family",      action: () => void plugin.activatePillar("family") },
    { label: "💞 Relationship",  action: () => void plugin.activatePillar("relationship") },
    { label: "🗑 Trash",         action: () => void plugin.activateTrash() },
  ];
  for (const item of viewItems) {
    const btn = actions.createEl("button", { cls: "morning-os-fab morning-os-fab-view", text: item.label });
    btn.addEventListener("click", () => { hide(); item.action(); });
  }

  return { handle, actions, cleanup };
}

export const PILLARS = [
  { key: "health",       label: "Health",       tabs: ["Physical", "Mental/ADHD"] },
  { key: "career",       label: "Career",       tabs: ["Applications", "Leads", "Follow-ups"] },
  { key: "interests",    label: "Interests",    tabs: [] },
  { key: "family",       label: "Family",       tabs: [] },
  { key: "relationship", label: "Relationship", tabs: [] },
] as const;

type SortField = "created" | "modified" | "completed" | "name";
type SortDir = "asc" | "desc";

function sortTasks(tasks: Task[], field: SortField, dir: SortDir): Task[] {
  return [...tasks].sort((a, b) => {
    let va = field === "name" ? a.text : (a[field] ?? "");
    let vb = field === "name" ? b.text : (b[field] ?? "");
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
  clearView: string,
  isInbox = false,
  plugin?: MorningOSPlugin
) {
  const row = parent.createEl("div", { cls: "morning-os-task-row" + (task.done ? " morning-os-task-done" : "") });
  const checkbox = row.createEl("input", { type: "checkbox" });
  checkbox.checked = task.done;

  // Urgency dot
  const dot = row.createEl("span", { cls: "mos-urgency-dot", attr: { title: `Urgency: ${task.urgency}` } });
  dot.style.background = URGENCY_DOT[task.urgency] ?? URGENCY_DOT.med;
  dot.textContent = URGENCY_LABEL[task.urgency] ?? "M";

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
        const idx = reg.findIndex(t => t.id === task.id);
        if (idx !== -1) { reg[idx].text = newText; reg[idx].modified = todayStr(); }
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

  if (task.remind_date) {
    row.createEl("span", { cls: "morning-os-reminder-badge", text: `⏰ ${task.remind_date}` });
  }

  // Inline today buttons (all views) — icon only, shown on hover
  const regBtn = row.createEl("button", { cls: "mos-today-btn", attr: { title: "Move to Today (Regular)" } });
  regBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`;
  regBtn.addEventListener("click", () => {
    void moveTaskToToday(app, task.id, "regular").then(async () => {
      if (plugin) { await plugin.autoRefreshBrief(); plugin.refreshView(); }
      onRefresh();
    });
  });

  const redBtn2 = row.createEl("button", { cls: "mos-today-btn mos-today-btn-red", attr: { title: "Move to Today (Red alert)" } });
  redBtn2.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/><polyline points="15 18 21 12 15 6"/></svg>`;
  redBtn2.addEventListener("click", () => {
    void moveTaskToToday(app, task.id, "red").then(async () => {
      if (plugin) { await plugin.autoRefreshBrief(); plugin.refreshView(); }
      onRefresh();
    });
  });

  // ⋯ context menu
  const moreBtn = row.createEl("button", { cls: "mos-more-btn", text: "⋯" });
  moreBtn.addEventListener("click", () => {
    const menuItems: MenuAction[] = [];

    menuItems.push({
      label: "✎ Edit metadata",
      action: () => {
        new TaskEditModal(app, task, async (updated) => {
          const reg = await loadRegistry(app);
          const idx = reg.findIndex(t => t.id === updated.id);
          if (idx !== -1) reg[idx] = updated;
          await saveRegistry(app, reg);
          if (plugin) plugin.refreshView();
          onRefresh();
        }).open();
      },
    });

    if (!isInbox) {
      menuItems.push({
        label: "✕ Remove from this view",
        action: () => {
          void clearTaskFromView(app, task.id, clearView).then(() => {
            if (plugin) plugin.refreshView();
            onRefresh();
          });
        },
      });
    }

    menuItems.push({
      label: "🗑 Delete",
      danger: true,
      action: () => {
        void deleteTask(app, task.id).then(() => {
          if (plugin) plugin.refreshView();
          onRefresh();
        });
      },
    });

    openContextMenu(moreBtn, menuItems);
  });

  checkbox.addEventListener("change", () => {
    row.toggleClass("morning-os-task-done", checkbox.checked);
    void toggleTaskDone(app, task.id, checkbox.checked).then(() => {
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
  private sortField: SortField = "created";
  private sortDir: SortDir = "asc";
  private floatingCleanup: (() => void) | null = null;

  constructor(leaf: WorkspaceLeaf, settings: MorningOSSettings, plugin: MorningOSPlugin, pillarKey: string) {
    super(leaf);
    this.settings = settings;
    this.plugin = plugin;
    this.pillarKey = pillarKey;
  }

  getViewType(): string { return `${VIEW_TYPE_PILLAR}-${this.pillarKey}`; }
  getDisplayText(): string { return PILLARS.find(p => p.key === this.pillarKey)?.label ?? this.pillarKey; }
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

    const pillar = PILLARS.find(p => p.key === this.pillarKey);
    if (!pillar) return;

    const wrapper = container.createEl("div", { cls: "morning-os-scroll" });
    const inner = wrapper.createEl("div", { cls: "morning-os-wrapper" });

    const titleRow = inner.createEl("div", { cls: "mos-view-title-row" });
    titleRow.createEl("h1", { cls: "morning-os-section-heading", text: pillar.label });
    this.renderSortControls(titleRow);

    if (pillar.tabs.length > 0) {
      const tabBar = inner.createEl("div", { cls: "mos-pillar-tabs" });
      const allTab = tabBar.createEl("button", { cls: "mos-btn mos-btn-tab" + (!this.activeTab ? " is-active" : ""), text: "All" });
      allTab.addEventListener("click", () => { this.activeTab = null; this.render(); });
      for (const tab of pillar.tabs) {
        const btn = tabBar.createEl("button", { cls: "mos-btn mos-btn-tab" + (this.activeTab === tab ? " is-active" : ""), text: tab });
        btn.addEventListener("click", () => { this.activeTab = tab; this.render(); });
      }
    }

    let tasks = this.registry.filter(t =>
      t.pillars.includes(this.pillarKey) &&
      !t.deleted_from.includes(this.pillarKey) &&
      (this.activeTab === null || t.tags[this.pillarKey] === this.activeTab)
    );
    tasks = sortTasks(tasks, this.sortField, this.sortDir);

    // Remind today
    const remindToday = tasks.filter(t => t.remind_date && t.remind_date <= todayStr() && !t.done);
    if (remindToday.length > 0) {
      inner.createEl("h2", { cls: "morning-os-section-heading", text: "Due reminders" });
      const rc = inner.createEl("div", { cls: "morning-os-card" });
      for (const t of remindToday) renderTaskRowShared(rc, t, this.app, () => void this.refresh(), this.pillarKey, false, this.plugin);
    }

    if (tasks.length === 0) {
      inner.createEl("p", { cls: "morning-os-empty-state", text: "No tasks here yet." });
    } else {
      const card = inner.createEl("div", { cls: "morning-os-card" });
      for (const t of tasks) renderTaskRowShared(card, t, this.app, () => void this.refresh(), this.pillarKey, false, this.plugin);
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

  private renderSortControls(parent: HTMLElement) {
    const wrap = parent.createEl("div", { cls: "mos-sort-controls" });
    const fields: SortField[] = ["created", "modified", "completed", "name"];
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
  private sortField: SortField = "created";
  private sortDir: SortDir = "desc";
  private floatingCleanup: (() => void) | null = null;

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

    let tasks = this.registry.filter(t => !t.deleted_from.includes("dump") && !t.deleted);
    tasks = sortTasks(tasks, this.sortField, this.sortDir);

    if (tasks.length === 0) {
      inner.createEl("p", { cls: "morning-os-empty-state", text: "All clear. Capture fast, organize later." });
    } else {
      const card = inner.createEl("div", { cls: "morning-os-card" });
      for (const t of tasks) renderTaskRowShared(card, t, this.app, () => void this.refresh(), "inbox", true, this.plugin);
    }
  }

  private renderSortControls(parent: HTMLElement) {
    const wrap = parent.createEl("div", { cls: "mos-sort-controls" });
    const fields: SortField[] = ["created", "modified", "completed", "name"];
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

  constructor(app: App, task: Task, onSave: (task: Task) => Promise<void>) {
    super(app);
    this.task = { ...task, pillars: [...task.pillars], tags: { ...task.tags } };
    this.onSave = onSave;
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

    // Urgency
    const urgWrap = this.field(contentEl, "Urgency");
    const urgGroup = urgWrap.createEl("div", { cls: "mos-edit-btn-group" });
    for (const u of ["none", "low", "med", "high"] as const) {
      const btn = urgGroup.createEl("button", {
        cls: "mos-btn mos-btn-seg" + (this.task.urgency === u ? " is-active" : ""),
        text: u === "none" ? "—" : u,
      });
      btn.addEventListener("click", () => {
        this.task.urgency = u;
        urgGroup.querySelectorAll(".mos-edit-seg-btn").forEach(b => b.removeClass("is-active"));
        btn.addClass("is-active");
      });
    }

    // Pillars
    const pillarsWrap = this.field(contentEl, "Pillars");
    const pillarsGrid = pillarsWrap.createEl("div", { cls: "mos-edit-pillars-grid" });
    for (const pillar of PILLARS) {
      const cell = pillarsGrid.createEl("div", { cls: "mos-edit-pillar-cell" });
      const cb = cell.createEl("input", { type: "checkbox" });
      cb.checked = this.task.pillars.includes(pillar.key);
      cell.createEl("span", { cls: "mos-edit-pillar-label", text: pillar.label });

      if (pillar.tabs.length > 0) {
        const tabSel = cell.createEl("select", { cls: "mos-edit-select" });
        tabSel.createEl("option", { value: "", text: "— tab —" });
        for (const tab of pillar.tabs) {
          const opt = tabSel.createEl("option", { value: tab, text: tab });
          if (this.task.tags[pillar.key] === tab) opt.selected = true;
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

    // Remind date
    const remindWrap = this.field(contentEl, "Remind date");
    const remindInput = remindWrap.createEl("input", { type: "date", cls: "mos-edit-input" });
    remindInput.value = this.task.remind_date ?? "";
    remindInput.addEventListener("change", () => { this.task.remind_date = remindInput.value || null; });

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
  private renderGen = 0;

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

    // Deleted tasks
    const deletedTasks = this.registry.filter(t => t.deleted);
    inner.createEl("h2", { cls: "morning-os-section-heading", text: `Tasks (${deletedTasks.length})` });
    if (deletedTasks.length === 0) {
      inner.createEl("p", { cls: "morning-os-empty-state", text: "No deleted tasks." });
    } else {
      const card = inner.createEl("div", { cls: "morning-os-card" });
      for (const task of deletedTasks) {
        const row = card.createEl("div", { cls: "morning-os-task-row morning-os-task-done" });
        row.createEl("span", { cls: "morning-os-task-text", text: task.text });
        row.createEl("span", { cls: "morning-os-reminder-badge", text: task.modified });
        const restoreBtn = row.createEl("button", { cls: "mos-task-action-btn", text: "Restore" });
        restoreBtn.addEventListener("click", () => {
          void restoreTask(this.app, task.id).then(() => {
            this.plugin.refreshView();
            void this.refresh();
          });
        });
      }
    }

    // Dismissed reminders
    this.renderDismissedReminders(inner);
  }

  private renderDismissedReminders(parent: HTMLElement) {
    parent.createEl("h2", { cls: "morning-os-section-heading", text: "Dismissed reminders" });

    const remindersPath = `${this.settings.briefsDir}/reminders.json`;
    const gen = ++this.renderGen;
    void (async () => {
      const exists = await this.app.vault.adapter.exists(remindersPath);
      if (gen !== this.renderGen) return;
      if (!exists) {
        parent.createEl("p", { cls: "morning-os-empty-state", text: "No dismissed reminders." });
        return;
      }
      type ReminderEntry = { text: string; source_date: string; remind_date: string; dismissed: boolean };
      let reminders: ReminderEntry[] = [];
      try {
        reminders = JSON.parse(await this.app.vault.adapter.read(remindersPath)) as ReminderEntry[];
      } catch { return; }
      if (gen !== this.renderGen) return;

      const dismissed = reminders.filter(r => r.dismissed);
      if (dismissed.length === 0) {
        parent.createEl("p", { cls: "morning-os-empty-state", text: "No dismissed reminders." });
        return;
      }

      const card = parent.createEl("div", { cls: "morning-os-card" });
      for (const r of dismissed) {
        const row = card.createEl("div", { cls: "morning-os-task-row morning-os-task-done" });
        row.createEl("span", { cls: "morning-os-task-text", text: r.text });
        row.createEl("span", { cls: "morning-os-reminder-badge", text: `noted ${r.source_date}` });
        const restoreBtn = row.createEl("button", { cls: "mos-task-action-btn", text: "Restore" });
        restoreBtn.addEventListener("click", () => {
          void (async () => {
            const raw = await this.app.vault.adapter.read(remindersPath);
            const all = JSON.parse(raw) as ReminderEntry[];
            const idx = all.findIndex(e => e.text === r.text && e.source_date === r.source_date && e.remind_date === r.remind_date);
            if (idx !== -1) all[idx].dismissed = false;
            await this.app.vault.adapter.write(remindersPath, JSON.stringify(all, null, 2));
            this.plugin.refreshView();
            void this.refresh();
          })();
        });
      }
    })();
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
        if (!this.type) {
          status.setText("Please select bug or feature request.");
          return;
        }
        if (!this.description) {
          status.setText("Please add a short description.");
          return;
        }

        submitBtn.disabled = true;
        submitBtn.setText("Sending…");
        status.setText("");

        const webhook = this.type === "bug" ? WEBHOOK_BUGS : WEBHOOK_FEATURES;
        const label = this.type === "bug" ? "🐛 Bug report" : "✨ Feature request";

        try {
          await requestUrl({
            url: webhook,
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              embeds: [{
                title: label,
                description: this.description,
                color: this.type === "bug" ? 0xe5534b : 0xc9a84c,
                footer: { text: "Morning OS feedback" },
              }],
            }),
          });

          contentEl.empty();
          contentEl.addClass("mos-feedback-modal");
          contentEl.createEl("div", { cls: "mos-feedback-success", text: "✓ Thanks! Feedback received." });
          const closeBtn = contentEl.createEl("button", { cls: "mos-feedback-submit-btn mos-feedback-close-btn", text: "Close" });
          closeBtn.addEventListener("click", () => this.close());
        } catch {
          submitBtn.disabled = false;
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
