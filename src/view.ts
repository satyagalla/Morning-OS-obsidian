import { ItemView, WorkspaceLeaf, TFile, Modal, App, sanitizeHTMLToDom, MarkdownRenderer, Component, requestUrl, Notice } from "obsidian";
import changelogText from "../CHANGELOG.md";
import { parseChangelog } from "./agent/parse-changelog";

declare const __FEEDBACK_PROXY_URL__: string;
declare const __FEEDBACK_SECRET__: string;
const FEEDBACK_PROXY_URL: string = __FEEDBACK_PROXY_URL__;
const FEEDBACK_SECRET: string    = __FEEDBACK_SECRET__;
import { DailyBrief, Task, TaskRegistry, FieldDef, TabConfig, AreaConfig } from "./types";
import { MorningOSSettings } from "./settings";
import type MorningOSPlugin from "./main";
import { renderOnboarding } from "./onboarding";
import { scaffoldDailyNote } from "./agent/scaffold-daily-note";
import { todayStr } from "./utils";
import { loadRegistry, saveRegistry, setTaskStatus, updateTask, createTask, moveTaskToToday, deleteTask, getActiveReminders, getChildren, hasOpenChildren } from "./task-registry";
import { appendWinToLog, readTodayWinsFromLog } from "./agent/vault-reader";
import { parseIdentityAnchor } from "./agent/vault-reader";
import { attachTaskTextSuggest } from "./task-text-suggest";

export const VIEW_TYPE_AREA = "morning-os-area-view";
export const VIEW_TYPE_DUMP = "morning-os-inbox-view";
export const VIEW_TYPE_TRASH = "morning-os-trash-view";

function buildNavItems(areas: AreaConfig[]) {
  return [
    { id: "home",  label: "🌅 Home",  type: VIEW_TYPE_MORNING },
    { id: "dump",  label: "📥 Inbox", type: VIEW_TYPE_DUMP },
    ...areas.map(p => ({ id: p.key, label: `${p.icon} ${p.label}`, type: `${VIEW_TYPE_AREA}-${p.key}` })),
    { id: "trash", label: "🗑 Trash", type: VIEW_TYPE_TRASH },
  ];
}

// Renders vault/LLM-authored text as markdown so Obsidian features (wikilinks, bold, tags, …)
// work inside task titles and metadata — plain createEl({text}) only ever sets textContent.
function renderMdContent(
  app: App,
  component: Component,
  parent: HTMLElement,
  tag: keyof HTMLElementTagNameMap,
  cls: string,
  text: string
): HTMLElement {
  const el = parent.createEl(tag, cls ? { cls } : undefined);
  void MarkdownRenderer.render(app, text, el, "", component).then(() => {
    // Unwrap the single <p> block so inline layouts (flex rows, list items) aren't affected
    const inner = el.querySelector(":scope > p");
    if (inner && el.childNodes.length === 1) {
      while (inner.firstChild) el.insertBefore(inner.firstChild, inner);
      inner.remove();
    }
  });
  return el;
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

    const scroll = container.createDiv({ cls: "morning-os-scroll" });
    const wrapper = scroll.createDiv({ cls: "morning-os-wrapper" });

    this.renderWhatsNew(wrapper);

    if (this.wantsAI() && !this.hasApiKey()) {
      this.renderApiKeyBanner(wrapper);
    }

    this.renderHeader(wrapper);
    this.renderIdentityStrip(wrapper);
    this.renderGoals(wrapper);

    const body = wrapper.createDiv({ cls: "morning-os-body" });
    const left = body.createDiv({ cls: "morning-os-left" });
    const right = body.createDiv({ cls: "morning-os-right" });

    this.renderTasks(left);
    this.renderTacticalRules(right);
    this.renderSuggestion(right);

    this.renderHobbyTasks(wrapper);
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

  private wantsAI(): boolean {
    const s = this.settings;
    return s.aiEnabled && (
      s.modeTacticalRules || s.modeIdentityRules || s.modeGoals ||
      s.modeHobbyTasks || s.modeSuggestion ||
      s.modeWins
    );
  }

  private renderApiKeyBanner(parent: HTMLElement) {
    const banner = parent.createDiv({ cls: "mos-onboard-banner" });
    banner.createSpan({
      text: "Add your API key in Morning OS settings to generate personalized briefings, or turn off Use AI for briefings.",
    });
    const dismiss = banner.createEl("button", { cls: "mos-onboard-banner-dismiss", text: "✕" });
    dismiss.addEventListener("click", () => banner.remove());
  }

  private renderHeader(parent: HTMLElement) {
    const header = parent.createDiv({ cls: "morning-os-header" });
    const dateObj = new Date(todayStr() + "T00:00:00");
    header.createDiv({
      cls: "morning-os-date-weekday",
      text: dateObj.toLocaleDateString("en-US", { weekday: "long" }),
    });
    header.createDiv({
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
    if (!this.settings.showIdentity) return;
    const lines = this.identityLines.length > 0 ? this.identityLines : (this.brief?.identity?.rules ?? []);
    if (!lines.length) return;
    const strip = parent.createDiv({ cls: "morning-os-identity-strip" });
    strip.createDiv({ cls: "morning-os-identity-label", text: "I am someone who" });
    const rules = strip.createDiv({ cls: "morning-os-identity-rules" });
    for (const rule of lines) {
      renderMdContent(this.app, this, rules, "span", "morning-os-identity-rule", rule);
    }
  }

  private renderGoals(parent: HTMLElement) {
    if (!this.settings.showGoals) return;
    const goals = this.brief?.goals;
    if (!goals?.short_term?.length && !goals?.long_term?.length) return;
    const { short_term, long_term } = goals;
    const { short_term_count = 2, long_term_count = 2 } = this.brief?.meta?.goals ?? {};

    const stVisible = short_term.slice(0, short_term_count);
    const stHidden  = short_term.slice(short_term_count);
    const ltVisible = long_term.slice(0, long_term_count);
    const ltHidden  = long_term.slice(long_term_count);

    const wrap = parent.createDiv({ cls: "morning-os-goals-wrap" });

    const toggle = wrap.createDiv({ cls: "morning-os-goals-toggle" });
    toggle.createSpan({ cls: "morning-os-goals-toggle-label", text: "Goals" });
    toggle.addEventListener("click", () => wrap.toggleClass("is-open", !wrap.hasClass("is-open")));

    const preview = toggle.createDiv({ cls: "morning-os-goals-preview" });
    for (const item of stVisible)
      renderMdContent(this.app, this, preview, "span", "morning-os-goals-preview-pill morning-os-goals-pill-short", item);
    for (const item of ltVisible)
      renderMdContent(this.app, this, preview, "span", "morning-os-goals-preview-pill morning-os-goals-pill-long", item);

    const hasHidden = stHidden.length > 0 || ltHidden.length > 0;
    if (hasHidden)
      toggle.createSpan({ cls: "morning-os-goals-toggle-hint", text: `+${stHidden.length + ltHidden.length} more` });

    const panel = wrap.createDiv({ cls: "morning-os-goals-panel" });
    const grid = panel.createDiv({ cls: "morning-os-goals-grid" });

    const short = grid.createDiv({ cls: "morning-os-goals-col" });
    short.createEl("h2", { text: "Short-term" });
    const sl = short.createDiv({ cls: "morning-os-card" }).createEl("ul");
    for (const item of short_term) renderMdContent(this.app, this, sl, "li", "", item);

    const long = grid.createDiv({ cls: "morning-os-goals-col" });
    long.createEl("h2", { text: "Long-term" });
    const ll = long.createDiv({ cls: "morning-os-card" }).createEl("ul");
    for (const item of long_term) renderMdContent(this.app, this, ll, "li", "", item);
  }

  private renderTasks(parent: HTMLElement) {
    const today = todayStr();
    // A subtask nests under its parent's row only when the parent is also in Today —
    // otherwise it would never render at all, since it's excluded from top-level lists.
    const nestsUnderParent = (t: Task): boolean => {
      if (t.parent_id === null) return false;
      const p = this.registry.find(x => x._id === t.parent_id);
      return !!p && !p.is_deleted && p.is_today;
    };
    const redOpen    = this.registry.filter(t => t.is_today && !t.is_deleted && !nestsUnderParent(t) && t.status_priority === "red" && t.status_completion !== "done");
    const regOpen    = this.registry.filter(t => t.is_today && !t.is_deleted && !nestsUnderParent(t) && t.status_priority === "regular" && t.status_completion !== "done");
    const redDone    = this.registry.filter(t => t.is_today && !t.is_deleted && !nestsUnderParent(t) && t.status_priority === "red" && t.status_completion === "done" && t.date_completed === today);
    const regDone    = this.registry.filter(t => t.is_today && !t.is_deleted && !nestsUnderParent(t) && t.status_priority === "regular" && t.status_completion === "done" && t.date_completed === today);

    if (!redOpen.length && !regOpen.length && !redDone.length && !regDone.length) {
      const empty = parent.createDiv({ cls: "morning-os-card morning-os-card-empty" });
      empty.createEl("p", { cls: "morning-os-empty-state", text: "You're all caught up for today." });
      empty.createEl("p", { cls: "morning-os-empty-state", text: "Add a task here or pick from the Inbox to get started." });
    } else {
      if (redOpen.length > 0 || redDone.length > 0) {
        parent.createEl("h2", { cls: "morning-os-section-heading morning-os-red-heading", text: "Red alert" });
        const card = parent.createDiv({ cls: "morning-os-card morning-os-card-red" });
        this.renderRegistryTaskList(card, redOpen);
        this.renderRegistryDoneList(card, redDone);
      }
      if (regOpen.length > 0 || regDone.length > 0) {
        parent.createEl("h2", { cls: "morning-os-section-heading", text: "Regular" });
        const card = parent.createDiv({ cls: "morning-os-card" });
        this.renderRegistryTaskList(card, regOpen);
        this.renderRegistryDoneList(card, regDone);
      }
    }

    renderAddTaskInput(parent, this.app, "Capture a task…", async (text) => {
      const task = createTask(text, { is_today: true, status_priority: "regular" });
      const reg = await loadRegistry(this.app);
      reg.push(task);
      await saveRegistry(this.app, reg);
      await this.plugin.autoRefreshBrief();
      this.plugin.refreshView();
    });
  }

  private renderRegistryTaskList(parent: HTMLElement, tasks: Task[]) {
    for (const task of tasks) {
      const children = getChildren(this.registry, task._id);
      const row = parent.createDiv({ cls: "morning-os-task-row" });

      let childListEl: HTMLElement | null = null;
      const ensureChildList = (): HTMLElement => {
        if (!childListEl) {
          childListEl = parent.createDiv({ cls: "mos-subtask-list" });
          if (collapsedTasks.has(task._id)) childListEl.addClass("is-collapsed");
        }
        return childListEl;
      };

      if (children.length > 0) {
        const toggleBtn = row.createEl("button", {
          cls: "mos-subtask-toggle",
          text: collapsedTasks.has(task._id) ? "▸" : "▾",
        });
        toggleBtn.addEventListener("click", () => {
          const collapsed = collapsedTasks.has(task._id);
          if (collapsed) collapsedTasks.delete(task._id); else collapsedTasks.add(task._id);
          toggleBtn.setText(collapsed ? "▾" : "▸");
          ensureChildList().toggleClass("is-collapsed", !collapsed);
        });
      }

      const checkbox = row.createEl("input", { type: "checkbox" });
      const textSpan = renderMdContent(this.app, this, row, "span", "morning-os-task-text", task.text);
      attachInlineTextEdit(this.app, textSpan, task, () => this.plugin.refreshView());
      if (task.date_remind) {
        row.createSpan({ cls: "morning-os-reminder-badge", text: `⏰ ${task.date_remind}` });
      }
      if (task.notes?.trim() && this.plugin.settings.showNotesIndicator) {
        row.createSpan({ cls: "mos-notes-badge", attr: { title: "Has notes" }, text: "📝" });
      }

      const moreBtn = row.createEl("button", { cls: "mos-more-btn", text: "⋯" });
      moreBtn.addEventListener("click", () => {
        const flipPriority = task.status_priority === "red" ? "regular" : "red";
        const flipLabel = task.status_priority === "red" ? "→ Move to Regular" : "🔴 Move to Red alert";
        const menuItems: MenuAction[] = [];
        if (task.parent_id === null) {
          menuItems.push({
            label: "＋ Add subtask",
            action: () => {
              const list = ensureChildList();
              renderAddTaskInput(list, this.app, "Add subtask…", async (text) => {
                const child = createTask(text, { parent_id: task._id, areas: [...task.areas], tags: { ...task.tags } });
                const reg = await loadRegistry(this.app);
                reg.push(child);
                await saveRegistry(this.app, reg);
                this.plugin.refreshView();
              });
              list.querySelector<HTMLInputElement>(".morning-os-wins-input-row:last-child input")?.focus();
            },
          });
        }
        menuItems.push(
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
              }, false, this.plugin.settings.areas, this.plugin.settings.advancedAreaFeatures).open();
            },
          },
          {
            label: "🗑 Delete",
            danger: true,
            action: () => void deleteTask(this.app, task._id).then(() => this.plugin.refreshView()),
          },
        );
        openContextMenu(moreBtn, menuItems);
      });

      checkbox.addEventListener("change", () => {
        if (checkbox.checked && this.plugin.settings.requireSubtasksComplete && hasOpenChildren(this.registry, task._id)) {
          checkbox.checked = false;
          new Notice("Morning OS: Complete all subtasks first");
          return;
        }
        row.toggleClass("morning-os-task-done", checkbox.checked);
        void setTaskStatus(this.app, task._id, checkbox.checked ? "done" : "open")
          .then(() => this.plugin.refreshView());
      });

      if (children.length > 0) {
        const list = ensureChildList();
        for (const child of children) {
          renderTaskRowShared(list, child, this.app, this, () => this.plugin.refreshView(), this.plugin, false, undefined, this.registry, true);
        }
      }
    }
  }

  private renderRegistryDoneList(parent: HTMLElement, tasks: Task[]) {
    for (const task of tasks) {
      const children = getChildren(this.registry, task._id);
      const row = parent.createDiv({ cls: "morning-os-task-row morning-os-task-done" });

      let childListEl: HTMLElement | null = null;
      const ensureChildList = (): HTMLElement => {
        if (!childListEl) {
          childListEl = parent.createDiv({ cls: "mos-subtask-list" });
          if (collapsedTasks.has(task._id)) childListEl.addClass("is-collapsed");
        }
        return childListEl;
      };

      if (children.length > 0) {
        const toggleBtn = row.createEl("button", {
          cls: "mos-subtask-toggle",
          text: collapsedTasks.has(task._id) ? "▸" : "▾",
        });
        toggleBtn.addEventListener("click", () => {
          const collapsed = collapsedTasks.has(task._id);
          if (collapsed) collapsedTasks.delete(task._id); else collapsedTasks.add(task._id);
          toggleBtn.setText(collapsed ? "▾" : "▸");
          ensureChildList().toggleClass("is-collapsed", !collapsed);
        });
      }

      const checkbox = row.createEl("input", { type: "checkbox" });
      checkbox.checked = true;
      const textSpan = renderMdContent(this.app, this, row, "span", "morning-os-task-text", task.text);
      attachInlineTextEdit(this.app, textSpan, task, () => this.plugin.refreshView());
      if (task.notes?.trim() && this.plugin.settings.showNotesIndicator) {
        row.createSpan({ cls: "mos-notes-badge", attr: { title: "Has notes" }, text: "📝" });
      }
      checkbox.addEventListener("change", () => {
        if (checkbox.checked && this.plugin.settings.requireSubtasksComplete && hasOpenChildren(this.registry, task._id)) {
          checkbox.checked = false;
          new Notice("Morning OS: Complete all subtasks first");
          return;
        }
        row.toggleClass("morning-os-task-done", checkbox.checked);
        void setTaskStatus(this.app, task._id, checkbox.checked ? "done" : "open")
          .then(() => this.plugin.refreshView());
      });

      if (children.length > 0) {
        const list = ensureChildList();
        for (const child of children) {
          renderTaskRowShared(list, child, this.app, this, () => this.plugin.refreshView(), this.plugin, false, undefined, this.registry, true);
        }
      }
    }
  }

  private renderTacticalRules(parent: HTMLElement) {
    if (!this.settings.showRulesForToday) return;
    const hasTasks = this.registry.some(t => t.is_today && !t.is_deleted && t.status_completion !== "done");
    if (!hasTasks || !this.brief?.tactical_rules?.length) return;
    parent.createEl("h2", { cls: "morning-os-section-heading", text: "Rules for today" });
    const card = parent.createDiv({ cls: "morning-os-card morning-os-card-rules" });
    const list = card.createEl("ul");
    for (const rule of this.brief.tactical_rules) {
      renderMdContent(this.app, this, list, "li", "", rule);
    }
  }

  private renderSuggestion(parent: HTMLElement) {
    if (!this.brief?.suggestions?.length) return;
    parent.createEl("h2", { cls: "morning-os-section-heading", text: "Suggestions" });
    this.brief.suggestions.forEach((s, i) => {
      const card = parent.createDiv({ cls: "morning-os-card morning-os-suggestion-card" });
      renderMdContent(this.app, this, card, "p", "morning-os-suggestion-text", s.text);

      const footer = card.createDiv({ cls: "morning-os-suggestion-footer" });
      const sourceLabel: Record<string, string> = {
        tasks: "Today's Tasks",
        goals: "Goals",
        technical_backlog: "Technical Backlog",
        carried_tasks: "Carried Tasks",
        wins: "Yesterday's Wins",
      };
      footer.createSpan({ cls: "morning-os-suggestion-source", text: sourceLabel[s.source] ?? s.source });

      const reactions = footer.createDiv({ cls: "morning-os-suggestion-reactions" });
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
    const card = parent.createDiv({ cls: "morning-os-card" });

    for (const task of reminders) {
      const row = card.createDiv({ cls: "morning-os-task-row" });
      const checkbox = row.createEl("input", { type: "checkbox" });
      const textSpan = renderMdContent(this.app, this, row, "span", "morning-os-task-text", task.text);
      textSpan.addEventListener("dblclick", () => {
        const input = createEl("input");
        input.type = "text";
        input.value = task.text;
        input.className = "morning-os-wins-input mos-inline-edit";
        textSpan.replaceWith(input);
        attachTaskTextSuggest(this.app, input);
        input.focus();
        let saving = false;
        const save = async () => {
          if (saving) return;
          saving = true;
          const newText = input.value.trim();
          if (newText && newText !== task.text) {
            const reg = await loadRegistry(this.app);
            const idx = reg.findIndex(t => t._id === task._id);
            if (idx !== -1) { reg[idx].text = newText; reg[idx].date_modified = todayStr(); }
            await saveRegistry(this.app, reg);
            this.plugin.refreshView();
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
      row.createSpan({ cls: "morning-os-reminder-badge", text: `⏰ ${task.date_remind}` });

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

  private renderHobbyTasks(parent: HTMLElement) {
    if (!this.brief?.hobby_tasks?.length) return;
    const section = parent.createDiv({ cls: "morning-os-hobby" });
    section.createEl("h2", { cls: "morning-os-section-heading", text: "Hobby tasks" });
    const card = section.createDiv({ cls: "morning-os-card morning-os-hobby-card" });
    const list = card.createEl("ul", { cls: "morning-os-hobby-list" });
    for (const item of this.brief.hobby_tasks ?? []) {
      renderMdContent(this.app, this, list, "li", "", item);
    }
  }

  private renderWins(parent: HTMLElement) {
    const section = parent.createDiv({ cls: "morning-os-wins" });
    section.createEl("h2", { cls: "morning-os-section-heading morning-os-green-heading", text: "Wins today" });
    const card = section.createDiv({ cls: "morning-os-card morning-os-card-wins" });

    const list = card.createDiv({ cls: "morning-os-wins-list" });
    this.renderWinsList(list);

    const inputRow = card.createDiv({ cls: "morning-os-wins-input-row" });
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
        renderMdContent(this.app, this, parent, "p", "morning-os-wins-item", win);
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

    const banner = parent.createDiv({ cls: "mos-whats-new-banner" });

    const top = banner.createDiv({ cls: "mos-whats-new-top" });
    const label = top.createSpan({ cls: "mos-whats-new-label" });
    label.createSpan({ cls: "mos-whats-new-badge", text: `v${entry.version}` });
    label.createSpan({ text: " What's new" });
    const dismissBtn = top.createEl("button", { cls: "mos-whats-new-dismiss", text: "Got it ✓" });

    for (const section of entry.sections) {
      banner.createDiv({ cls: "mos-whats-new-section-heading", text: section.heading });
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
    const card = parent.createDiv({ cls: "mos-feedback-card" });

    const left = card.createDiv({ cls: "mos-feedback-text" });
    left.createDiv({ cls: "mos-feedback-title", text: "Share your thoughts" });
    left.createDiv({ cls: "mos-feedback-sub", text: "What's working? What's missing?" });

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
  const handle = container.createDiv({ cls: "morning-os-floating-handle" });
  const actions = container.createDiv({ cls: "morning-os-floating-actions" });

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

  actions.createDiv({ cls: "morning-os-fab-label", text: "Agent" });
  const refreshBtn = actions.createEl("button", { cls: "morning-os-fab" });
  refreshBtn.appendChild(sanitizeHTMLToDom(`<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>`));
  refreshBtn.appendText(" Refresh brief");
  refreshBtn.addEventListener("click", () => { void plugin.triggerRefresh(); });

  const runBtn = actions.createEl("button", { cls: "morning-os-fab" });
  runBtn.appendChild(sanitizeHTMLToDom(`<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polygon points="10 8 16 12 10 16 10 8"></polygon></svg>`));
  runBtn.appendText(" Run agent");
  runBtn.addEventListener("click", () => { void plugin.triggerAgent(); });

  actions.createDiv({ cls: "morning-os-fab-label", text: "Views" });
  for (const item of buildNavItems(plugin.settings.areas)) {
    const btn = actions.createEl("button", { cls: "morning-os-fab morning-os-fab-view", text: item.label });
    btn.addEventListener("click", () => {
      hide();
      if (item.id === "home")  void plugin.activateView();
      else if (item.id === "dump")  void plugin.activateDump();
      else if (item.id === "trash") void plugin.activateTrash();
      else void plugin.activateArea(item.id);
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
  const menu = document.body.createDiv({ cls: "mos-ctx-menu" });
  const rect = anchor.getBoundingClientRect();
  menu.setCssStyles({
    position: "fixed",
    top: `${rect.bottom + 4}px`,
    left: `${rect.left}px`,
    zIndex: "9999",
  });

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

function attachInlineTextEdit(app: App, textSpan: HTMLElement, task: Task, onSaved: () => void) {
  textSpan.addEventListener("dblclick", () => {
    const input = createEl("input");
    input.type = "text";
    input.value = task.text;
    input.className = "morning-os-wins-input mos-inline-edit";
    textSpan.replaceWith(input);
    attachTaskTextSuggest(app, input);
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
        onSaved();
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
}

// Tracks which parent tasks have their subtask list collapsed. Module-level so the
// collapsed/expanded state survives the full re-render every refresh triggers.
const collapsedTasks = new Set<string>();

function renderTaskRowShared(
  parent: HTMLElement,
  task: Task,
  app: App,
  component: Component,
  onRefresh: () => void,
  plugin?: MorningOSPlugin,
  showUrgency = false,
  tabFields?: FieldDef[],
  registry: TaskRegistry = [],
  isChild = false
) {
  const isDone = task.status_completion === "done";
  const hasChildren = !isChild && getChildren(registry, task._id).length > 0;
  const row = parent.createDiv({ cls: "morning-os-task-row" + (isDone ? " morning-os-task-done" : "") + (isChild ? " mos-task-row-child" : "") });

  if (hasChildren) {
    const toggleBtn = row.createEl("button", {
      cls: "mos-subtask-toggle",
      text: collapsedTasks.has(task._id) ? "▸" : "▾",
    });
    toggleBtn.addEventListener("click", () => {
      const collapsed = collapsedTasks.has(task._id);
      if (collapsed) collapsedTasks.delete(task._id); else collapsedTasks.add(task._id);
      toggleBtn.setText(collapsed ? "▾" : "▸");
      ensureChildList().toggleClass("is-collapsed", !collapsed);
    });
  }

  const checkbox = row.createEl("input", { type: "checkbox" });
  checkbox.checked = isDone;

  // Urgency dot
  const dot = row.createSpan({ cls: "mos-urgency-dot", attr: { title: `Urgency: ${task.status_urgency}` } });
  dot.style.background = URGENCY_DOT[task.status_urgency] ?? URGENCY_DOT.none;
  dot.textContent = URGENCY_LABEL[task.status_urgency] ?? "";

  // Inline text — double-click to edit
  const textSpan = renderMdContent(app, component, row, "span", "morning-os-task-text", task.text);
  attachInlineTextEdit(app, textSpan, task, onRefresh);

  if (task.date_remind) {
    row.createSpan({ cls: "morning-os-reminder-badge", text: `⏰ ${task.date_remind}` });
  }

  if (task.notes?.trim() && (plugin?.settings.showNotesIndicator ?? true)) {
    row.createSpan({ cls: "mos-notes-badge", attr: { title: "Has notes" }, text: "📝" });
  }

  // Meta field chips (area tab context only)
  if (tabFields?.length) {
    const chipRow = row.createSpan({ cls: "mos-task-meta-chips" });
    for (const field of tabFields) {
      const val = task.tags[field.key];
      if (val) {
        const chip = chipRow.createSpan({ cls: "mos-meta-chip" });
        chip.createSpan({ text: `${field.label}: ` });
        renderMdContent(app, component, chip, "span", "", val);
      }
    }
  }

  // Action buttons — today regular, today red alert, ⋯ menu
  const actions = row.createDiv({ cls: "mos-task-action-bar" });

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

  let childListEl: HTMLElement | null = null;
  const ensureChildList = (): HTMLElement => {
    if (!childListEl) {
      childListEl = parent.createDiv({ cls: "mos-subtask-list" });
      if (collapsedTasks.has(task._id)) childListEl.addClass("is-collapsed");
    }
    return childListEl;
  };

  const moreBtn = actions.createEl("button", { cls: "mos-action-btn", attr: { title: "More actions" }, text: "⋯" });
  moreBtn.addEventListener("click", () => {
    const menuItems: MenuAction[] = [];
    if (!isChild) {
      menuItems.push({
        label: "＋ Add subtask",
        action: () => {
          const list = ensureChildList();
          renderAddTaskInput(list, app, "Add subtask…", async (text) => {
            const child = createTask(text, { parent_id: task._id, areas: [...task.areas], tags: { ...task.tags } });
            const reg = await loadRegistry(app);
            reg.push(child);
            await saveRegistry(app, reg);
            if (plugin) plugin.refreshView();
            onRefresh();
          });
          list.querySelector<HTMLInputElement>(".morning-os-wins-input-row:last-child input")?.focus();
        },
      });
    }
    menuItems.push(
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
          }, showUrgency, plugin?.settings.areas ?? [], plugin?.settings.advancedAreaFeatures ?? false).open();
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
    );
    openContextMenu(moreBtn, menuItems);
  });

  checkbox.addEventListener("change", () => {
    if (checkbox.checked && plugin?.settings.requireSubtasksComplete && hasOpenChildren(registry, task._id)) {
      checkbox.checked = false;
      new Notice("Morning OS: Complete all subtasks first");
      return;
    }
    row.toggleClass("morning-os-task-done", checkbox.checked);
    void setTaskStatus(app, task._id, checkbox.checked ? "done" : "open").then(() => {
      if (plugin) plugin.refreshView();
    });
  });

  if (!isChild) {
    const children = getChildren(registry, task._id);
    if (children.length > 0) {
      const list = ensureChildList();
      for (const child of children) {
        renderTaskRowShared(list, child, app, component, onRefresh, plugin, showUrgency, tabFields, registry, true);
      }
    }
  }

  return row;
}

function renderAddTaskInput(parent: HTMLElement, app: App, placeholder: string, onAdd: (text: string) => Promise<void>) {
  const row = parent.createDiv({ cls: "morning-os-wins-input-row" });
  const input = row.createEl("input", { type: "text", cls: "morning-os-wins-input", placeholder });
  attachTaskTextSuggest(app, input);
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

export class AreaView extends ItemView {
  private settings: MorningOSSettings;
  private plugin: MorningOSPlugin;
  private registry: TaskRegistry = [];
  private activeTab: string | null = null;
  private areaKey: string;
  private sortField: SortField = "date_created";
  private sortDir: SortDir = "asc";
  private floatingCleanup: (() => void) | null = null;
  private filters: FilterState = {};

  constructor(leaf: WorkspaceLeaf, settings: MorningOSSettings, plugin: MorningOSPlugin, areaKey: string) {
    super(leaf);
    this.settings = settings;
    this.plugin = plugin;
    this.areaKey = areaKey;
  }

  getViewType(): string { return `${VIEW_TYPE_AREA}-${this.areaKey}`; }
  getDisplayText(): string { return this.plugin.settings.areas.find(p => p.key === this.areaKey)?.label ?? this.areaKey; }
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

    const area = this.plugin.settings.areas.find(p => p.key === this.areaKey);
    if (!area) return;

    const wrapper = container.createDiv({ cls: "morning-os-scroll" });
    const inner = wrapper.createDiv({ cls: "morning-os-wrapper" });

    // Title
    inner.createEl("h1", { cls: "mos-area-title", text: `${area.icon} ${area.label}` });

    // Area markdown notes section — placeholder created synchronously so order is correct
    const notesSlot = inner.createDiv({ cls: "mos-area-notes-slot" });
    void this.renderAreaNotes(notesSlot, area);

    // Active tab config (for field rendering)
    const activeTabConfig = area.tabs.find(t => t.key === this.activeTab) ?? null;

    // Tabs + sort/filter row together
    const controlRow = inner.createDiv({ cls: "mos-area-control-row" });

    if (area.tabs.length > 0) {
      const tabBar = controlRow.createDiv({ cls: "mos-area-tabs" });
      const allTab = tabBar.createEl("button", { cls: "mos-btn mos-btn-tab" + (!this.activeTab ? " is-active" : ""), text: "All" });
      allTab.addEventListener("click", () => { this.activeTab = null; this.render(); });
      for (const tab of area.tabs) {
        const btn = tabBar.createEl("button", { cls: "mos-btn mos-btn-tab" + (this.activeTab === tab?.key ? " is-active" : ""), text: tab.label });
        btn.addEventListener("click", () => { this.activeTab = tab.key; this.render(); });
      }
    }

    const sortFilterRow = controlRow.createDiv({ cls: "mos-sort-filter-row" });
    this.renderSortControls(sortFilterRow);
    const advancedAreaFeatures = this.plugin.settings.advancedAreaFeatures;
    if (!advancedAreaFeatures) delete this.filters.custom;
    const activeFields = advancedAreaFeatures ? activeTabConfig?.fields : undefined;
    renderFilterSelects(sortFilterRow, this.filters, (f) => { this.filters = f; this.render(); }, false, activeFields);

    // View mode: table vs cards
    if (advancedAreaFeatures && activeTabConfig?.view_mode === "table") {
      this.renderTableView(inner, activeTabConfig, area);
    } else {
      let tasks = this.registry.filter(t =>
        !t.is_deleted &&
        t.parent_id === null &&
        t.areas.includes(this.areaKey) &&
        (this.activeTab === null || t.tags[this.areaKey] === this.activeTab)
      );
      tasks = applyFilters(tasks, this.filters);
      tasks = sortTasks(tasks, this.sortField, this.sortDir);

      if (tasks.length === 0) {
        inner.createEl("p", { cls: "morning-os-empty-state", text: "No tasks here yet." });
      } else {
        const card = inner.createDiv({ cls: "morning-os-card" });
        const fields = activeFields ?? [];
        for (const t of tasks) renderTaskRowShared(card, t, this.app, this, () => void this.refresh(), this.plugin, false, fields, this.registry);
      }

      renderAddTaskInput(inner, this.app, "Capture a task…", async (text) => {
        const activeTab = this.activeTab;
        const tag = activeTab ? { [area.key]: activeTab } : {};
        const task = createTask(text, { areas: [area.key], tags: tag });
        const reg = await loadRegistry(this.app);
        reg.push(task);
        await saveRegistry(this.app, reg);
        await this.refresh();
      });
    }
  }

  private renderTableView(parent: HTMLElement, tabConfig: TabConfig, area: AreaConfig) {
    const fields = tabConfig.fields;
    const allItems = this.registry.filter(t =>
      !t.is_deleted && t.parent_id === null && t.areas.includes(this.areaKey) &&
      t.tags[this.areaKey] === tabConfig.key
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
        if (cb.checked && this.plugin?.settings.requireSubtasksComplete && hasOpenChildren(this.registry, task._id)) {
          cb.checked = false;
          new Notice("Morning OS: Complete all subtasks first");
          return;
        }
        const newStatus = cb.checked ? "done" : "open";
        void setTaskStatus(this.app, task._id, newStatus).then(async () => {
          if (this.plugin) { await this.plugin.autoRefreshBrief(); this.plugin.refreshView(); }
          await this.refresh();
        });
      });

      // Name cell (editable on click)
      const nameTd = tr.createEl("td", { cls: "mos-table-td mos-table-name" });
      const nameSpan = renderMdContent(this.app, this, nameTd, "span", "", task.text);
      if (task.notes?.trim() && this.plugin.settings.showNotesIndicator) {
        nameTd.createSpan({ cls: "mos-notes-badge", attr: { title: "Has notes" }, text: "📝" });
      }
      nameSpan.addEventListener("dblclick", () => {
        const input = createEl("input");
        input.type = "text";
        input.value = task.text;
        input.className = "mos-table-inline-edit";
        nameSpan.replaceWith(input);
        attachTaskTextSuggest(this.app, input);
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
          const cellSpan = val
            ? renderMdContent(this.app, this, td, "span", "", val)
            : td.createSpan({ text: "—", cls: "mos-table-empty" });
          cellSpan.addEventListener("dblclick", () => {
            const input = createEl("input");
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
      const actBar = actTd.createDiv({ cls: "mos-task-action-bar" });

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
              }, false, this.plugin?.settings.areas ?? [], this.plugin?.settings.advancedAreaFeatures ?? false).open();
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
    const addRow = parent.createDiv({ cls: "mos-table-add-row" });
    renderAddTaskInput(addRow, this.app, "+ Add row…", async (text) => {
      const tag = { [area.key]: tabConfig.key };
      const task = createTask(text, { areas: [area.key], tags: tag });
      const reg = await loadRegistry(this.app);
      reg.push(task);
      await saveRegistry(this.app, reg);
      await this.refresh();
    });
  }

  private async renderAreaNotes(parent: HTMLElement, area: AreaConfig) {
    const userFolder = this.settings.dailyNoteDir.split("/")[0] || "Essential";
    const notesPath = `${userFolder}/Areas/${area.label}.md`;

    const exists = await this.app.vault.adapter.exists(notesPath);
    if (!exists) {
      // Create parent dirs and empty file on first access
      const dir = `${userFolder}/Areas`;
      if (!(await this.app.vault.adapter.exists(dir))) {
        await this.app.vault.adapter.mkdir(dir);
      }
      await this.app.vault.adapter.write(notesPath, "");
    }

    let content = await this.app.vault.adapter.read(notesPath);

    // Strip leading h1 that matches the area label (added by migration, view already shows it)
    content = content.replace(new RegExp(`^#\\s+${area.label}\\s*\\n?`, "i"), "").trimStart();

    // Only render section if file has content
    if (!content.trim()) return;

    const storageKey = `mos-notes-collapsed-${area.key}`;
    let collapsed = this.app.loadLocalStorage(storageKey) === true;

    const section = parent.createDiv({ cls: "mos-area-notes" });
    const header = section.createDiv({ cls: "mos-area-notes-header" });
    const toggle = header.createSpan({ cls: "mos-area-notes-toggle", text: collapsed ? "▶" : "▼" });
    header.createSpan({ cls: "mos-area-notes-title", text: "Notes" });

    const editBtn = header.createEl("button", { cls: "mos-btn mos-btn-icon", attr: { title: "Edit notes" }, text: "✎" });
    editBtn.addEventListener("click", (e) => {
      void (async () => {
        e.stopPropagation();
        const file = this.app.vault.getAbstractFileByPath(notesPath);
        if (file instanceof TFile) {
          const leaf = this.app.workspace.getLeaf("split");
          await leaf.openFile(file);
        }
      })();
    });

    const body = section.createDiv({ cls: "mos-area-notes-body" });
    body.toggleClass("mos-area-notes-body-collapsed", collapsed);

    header.addEventListener("click", () => {
      collapsed = !collapsed;
      this.app.saveLocalStorage(storageKey, collapsed);
      toggle.textContent = collapsed ? "▶" : "▼";
      body.toggleClass("mos-area-notes-body-collapsed", collapsed);
    });

    const component = new Component();
    component.load();
    await MarkdownRenderer.render(this.app, content, body, notesPath, component);
  }

  private renderSortControls(parent: HTMLElement) {
    const wrap = parent.createDiv({ cls: "mos-sort-controls" });
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
  private sortDir: SortDir = "desc";
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

    const wrapper = container.createDiv({ cls: "morning-os-scroll" });
    const inner = wrapper.createDiv({ cls: "morning-os-wrapper" });

    const titleRow = inner.createDiv({ cls: "mos-view-title-row" });
    titleRow.createEl("h1", { cls: "morning-os-section-heading", text: "Inbox" });
    this.renderSortControls(titleRow);

    renderAddTaskInput(inner, this.app, "Capture a task…", async (text) => {
      const task = createTask(text);
      const reg = await loadRegistry(this.app);
      reg.push(task);
      await saveRegistry(this.app, reg);
      await this.refresh();
    });

    renderFilterSelects(titleRow, this.filters, (f) => { this.filters = f; this.render(); }, true);

    let tasks = this.registry.filter(t => !t.is_deleted && t.parent_id === null);
    tasks = applyFilters(tasks, this.filters);
    tasks = sortTasks(tasks, this.sortField, this.sortDir);

    if (tasks.length === 0) {
      inner.createEl("p", { cls: "morning-os-empty-state", text: "All clear. Capture fast, organize later." });
    } else {
      const card = inner.createDiv({ cls: "morning-os-card" });
      for (const t of tasks) renderTaskRowShared(card, t, this.app, this, () => void this.refresh(), this.plugin, true, undefined, this.registry);
    }
  }

  private renderSortControls(parent: HTMLElement) {
    const wrap = parent.createDiv({ cls: "mos-sort-controls" });
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

class TaskEditModal extends ObsidianModal {
  private task: Task;
  private onSave: (task: Task) => Promise<void>;
  private showUrgency: boolean;
  private areaConfigs: AreaConfig[];
  private showAdvancedAreaFeatures: boolean;

  constructor(
    app: App,
    task: Task,
    onSave: (task: Task) => Promise<void>,
    showUrgency = false,
    areaConfigs: AreaConfig[] = [],
    showAdvancedAreaFeatures = false
  ) {
    super(app);
    this.task = { ...task, areas: [...task.areas], tags: { ...task.tags } };
    this.onSave = onSave;
    this.showUrgency = showUrgency;
    this.areaConfigs = areaConfigs;
    this.showAdvancedAreaFeatures = showAdvancedAreaFeatures;
  }

  private field(parent: HTMLElement, label: string): HTMLElement {
    const wrap = parent.createDiv({ cls: "mos-edit-field" });
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
    attachTaskTextSuggest(this.app, textInput);

    // Status
    const statusWrap = this.field(contentEl, "Status");
    const statusGroup = statusWrap.createDiv({ cls: "mos-edit-btn-group" });
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
      const urgGroup = urgWrap.createDiv({ cls: "mos-edit-btn-group" });
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

    // Areas
    if (this.areaConfigs.length > 0) {
      const areasWrap = this.field(contentEl, "Areas");
      const areasGrid = areasWrap.createDiv({ cls: "mos-edit-areas-grid" });
      for (const area of this.areaConfigs) {
        const cell = areasGrid.createDiv({ cls: "mos-edit-area-cell" });
        const cb = cell.createEl("input", { type: "checkbox" });
        cb.checked = this.task.areas.includes(area.key);
        cell.createSpan({ cls: "mos-edit-area-label", text: area.label });

        if (area.tabs.length > 0) {
          const tabSel = cell.createEl("select", { cls: "mos-edit-select" });
          tabSel.createEl("option", { value: "", text: "— tab —" });
          for (const tab of area.tabs) {
            const opt = tabSel.createEl("option", { value: tab.key, text: tab.label });
            if (this.task.tags[area.key] === tab.key) opt.selected = true;
          }
          tabSel.style.display = cb.checked ? "block" : "none";
          cb.addEventListener("change", () => { tabSel.style.display = cb.checked ? "block" : "none"; });
          tabSel.addEventListener("change", () => { this.task.tags[area.key] = tabSel.value; });
        }

        cb.addEventListener("change", () => {
          if (cb.checked) { if (!this.task.areas.includes(area.key)) this.task.areas.push(area.key); }
          else { this.task.areas = this.task.areas.filter(p => p !== area.key); delete this.task.tags[area.key]; }
        });
      }
    }

    // Custom fields — render based on area/tab context
    const taskArea = this.task.areas[0];
    const areaConfig = taskArea ? this.areaConfigs.find(p => p.key === taskArea) : undefined;
    const taskTabKey = taskArea ? this.task.tags[taskArea] : undefined;
    const tabConfig = taskTabKey ? areaConfig?.tabs.find(t => t.key === taskTabKey) : undefined;
    if (this.showAdvancedAreaFeatures && tabConfig?.fields.length) {
      const fieldsWrap = this.field(contentEl, "Fields");
      for (const fieldDef of tabConfig.fields) {
        const fRow = fieldsWrap.createDiv({ cls: "mos-edit-field-row" });
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

    // Notes
    const notesWrap = this.field(contentEl, "Notes");
    const notesInput = notesWrap.createEl("textarea", { cls: "mos-edit-input mos-edit-textarea" });
    notesInput.value = this.task.notes ?? "";
    notesInput.addEventListener("input", () => { this.task.notes = notesInput.value; });

    const footer = contentEl.createDiv({ cls: "mos-edit-footer" });
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

    const wrapper = container.createDiv({ cls: "morning-os-scroll" });
    const inner = wrapper.createDiv({ cls: "morning-os-wrapper" });
    inner.createEl("h1", { cls: "morning-os-section-heading", text: "Trash" });

    this.renderTrashSection(inner, this.registry.filter(t => t.is_deleted), "Deleted");
  }

  private renderTrashSection(parent: HTMLElement, tasks: Task[], label: string) {
    parent.createEl("h2", { cls: "morning-os-section-heading", text: `${label} (${tasks.length})` });
    if (tasks.length === 0) {
      parent.createEl("p", { cls: "morning-os-empty-state", text: `No ${label.toLowerCase()} tasks.` });
      return;
    }
    const card = parent.createDiv({ cls: "morning-os-card" });
    for (const task of tasks) {
      const row = card.createDiv({ cls: "morning-os-task-row morning-os-task-done" });
      renderMdContent(this.app, this, row, "span", "morning-os-task-text", task.text);
      row.createSpan({ cls: "morning-os-reminder-badge", text: task.date_modified });

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
      cls: "morning-os-wins-input mos-capture-input",
    });
    input.placeholder = "Capture a task…";
    attachTaskTextSuggest(this.app, input);

    const footer = contentEl.createDiv({ cls: "mos-feedback-modal-footer" });
    const hint = footer.createSpan({ cls: "mos-feedback-status", text: "Enter to save" });
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

    const typeRow = contentEl.createDiv({ cls: "mos-feedback-type-row" });
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

    const footer = contentEl.createDiv({ cls: "mos-feedback-modal-footer" });
    const status = footer.createSpan({ cls: "mos-feedback-status" });
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
          contentEl.createDiv({ cls: "mos-feedback-success", text: "✓ Thanks! Feedback received." });
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
