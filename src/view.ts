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
import { todayStr } from "./utils";
import { loadRegistry, saveRegistry, setTaskStatus, setNoteStatus, updateTask, createTask, createNote, createChildItem, changeItemKind, moveTaskToToday, changeTodayPriority, removeTaskFromToday, setTaskReminder, deleteTask, restoreTask, purgeTask, getActiveReminders, getChildren, hasOpenChildren, promoteDueReminders, cloneItemDraft, saveItemDraft } from "./task-registry";
import { appendWinToLog, readTodayWinsFromLog } from "./agent/vault-reader";
import { parseIdentityAnchor } from "./agent/vault-reader";
import { attachTaskTextSuggest } from "./task-text-suggest";
import { beginEditingSession, disposeEditorsIn, hasActiveEditingSession, onEditingSessionsSettled, registerEditorCleanup } from "./editing-session";
import type { DraftConflictChoice } from "./data/draft-reconciliation";
import { sortItems } from "./item-order";

export const VIEW_TYPE_AREA = "morning-os-area-view";
export const VIEW_TYPE_DUMP = "morning-os-inbox-view";
export const VIEW_TYPE_ALL_ITEMS = "morning-os-all-items-view";
export const VIEW_TYPE_TRASH = "morning-os-trash-view";

function buildNavItems(areas: AreaConfig[]) {
  return [
    { id: "home",  label: "🌅 Home",  type: VIEW_TYPE_MORNING },
    { id: "dump",  label: "📥 Inbox", type: VIEW_TYPE_DUMP },
    { id: "all", label: "All Items", type: VIEW_TYPE_ALL_ITEMS },
    { id: "trash", label: "🗑 Trash", type: VIEW_TYPE_TRASH },
    ...areas.map(p => ({ id: p.key, label: `${p.icon} ${p.label}`, type: `${VIEW_TYPE_AREA}-${p.key}` })),
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

    // Auto-promote tasks with due date_remind to today
    await this.promoteReminders();

    // Always load registry and render immediately — don't block on agent
    await this.loadRegistryAndIdentity();
    await this.loadBrief();
    await this.loadWins();
    await this.loadSuggestionReaction();
    this.render();

  }

  async onClose() {
    disposeEditorsIn(this.containerEl);
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
    await promoteDueReminders(this.app);
  }

  private async loadRegistryAndIdentity() {
    this.registry = await loadRegistry(this.app);
    this.identityLines = await parseIdentityAnchor(this.app, this.settings);
  }

  private async loadBrief() {
    const today = todayStr();
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
    disposeEditorsIn(container);
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
      s.modeSuggestion || s.modeWins
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
    const eligible = (item: Task): boolean => isItemActive(item) || (item.kind === "task" && item.status_completion === "done" && item.date_completed === today);
    const selectedRoots = (priority: "red" | "regular", done: boolean): Task[] => this.registry.filter(item =>
      item.is_today && !item.is_deleted && item.parent_id === null && item.status_priority === priority &&
      (done ? item.status_completion === "done" && item.date_completed === today : isItemActive(item))
    );
    const redOpen = selectedRoots("red", false);
    const regOpen = selectedRoots("regular", false);
    const redDone = selectedRoots("red", true);
    const regDone = selectedRoots("regular", true);
    const renderedRootIds = new Set([...redOpen, ...regOpen, ...redDone, ...regDone].map(item => item._id));
    const selectedChildren = (priority: "red" | "regular"): Task[] => this.registry.filter(item =>
      item.is_today && !item.is_deleted && item.parent_id !== null && !renderedRootIds.has(item.parent_id) &&
      item.status_priority === priority && eligible(item)
    );
    const redContextual = selectedChildren("red");
    const regContextual = selectedChildren("regular");

    if (!redOpen.length && !regOpen.length && !redDone.length && !regDone.length && !redContextual.length && !regContextual.length) {
      const empty = parent.createDiv({ cls: "morning-os-card morning-os-card-empty" });
      empty.createEl("p", { cls: "morning-os-empty-state", text: "You're all caught up for today." });
      empty.createEl("p", { cls: "morning-os-empty-state", text: "Add a task here or pick from the Inbox to get started." });
    } else {
      if (redOpen.length > 0 || redDone.length > 0 || redContextual.length > 0) {
        parent.createEl("h2", { cls: "morning-os-section-heading morning-os-red-heading", text: "Red alert" });
        const card = parent.createDiv({ cls: "morning-os-card morning-os-card-red" });
        this.renderRegistryTaskList(card, redOpen);
        this.renderRegistryDoneList(card, redDone);
        this.renderContextualTodayChildren(card, redContextual);
      }
      if (regOpen.length > 0 || regDone.length > 0 || regContextual.length > 0) {
        parent.createEl("h2", { cls: "morning-os-section-heading", text: "Regular" });
        const card = parent.createDiv({ cls: "morning-os-card" });
        this.renderRegistryTaskList(card, regOpen);
        this.renderRegistryDoneList(card, regDone);
        this.renderContextualTodayChildren(card, regContextual);
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

  private renderContextualTodayChildren(parent: HTMLElement, children: Task[]): void {
    const groups = new Map<string, Task[]>();
    for (const child of children) {
      const group = groups.get(child.parent_id!) ?? [];
      group.push(child);
      groups.set(child.parent_id!, group);
    }
    for (const [parentId, group] of groups) {
      const context = this.registry.find(item => item._id === parentId);
      parent.createDiv({
        cls: "mos-today-context-parent",
        text: context && !context.is_deleted ? context.text : "Missing or deleted parent",
      });
      for (const child of group) {
        renderTaskRowShared(parent, child, this.app, this, () => this.plugin.refreshView(), this.plugin, false, undefined, this.registry, true);
      }
    }
  }

  private renderTodayRootSupportingContent(parent: HTMLElement, row: HTMLElement, task: Task): void {
    const childNotes = getChildren(this.registry, task._id).filter(child => child.kind === "note" && isItemActive(child));
    const details = task.details?.trim() || task.notes?.trim();
    if (!childNotes.length && !details) return;
    const supporting = parent.createDiv({ cls: "mos-subtask-list mos-today-root-supporting" });
    row.after(supporting);
    if (childNotes.length) {
      const notes = supporting.createEl("details", { cls: "mos-today-supporting-notes" });
      notes.createEl("summary", { text: `Supporting notes (${childNotes.length})` });
      const content = notes.createDiv({ cls: "mos-today-supporting-content" });
      for (const child of childNotes) {
        renderTaskRowShared(content, child, this.app, this, () => this.plugin.refreshView(), this.plugin, false, undefined, this.registry, true, undefined, undefined, { parentOwnsPlacement: true });
      }
    }
    if (details) {
      const detailsEl = supporting.createEl("details", { cls: "mos-today-parent-details" });
      detailsEl.createEl("summary", { text: "Details" });
      renderMdContent(this.app, this, detailsEl, "div", "mos-today-parent-details-content", details);
    }
  }

  private renderRegistryTaskList(parent: HTMLElement, tasks: Task[]) {
    for (const task of tasks) {
      const children = getChildren(this.registry, task._id).filter(child => child.kind === "task" &&
        (isItemActive(child) || (child.status_completion === "done" && child.date_completed === todayStr())));
      const row = parent.createDiv({ cls: "morning-os-task-row" });

      let childListEl: HTMLElement | null = null;
      const ensureChildList = (): HTMLElement => {
        if (!childListEl) {
          childListEl = parent.createDiv({ cls: "mos-subtask-list" });
          row.after(childListEl);
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

      const isNote = task.kind === "note";
      const checkbox = isNote ? null : row.createEl("input", { type: "checkbox" });
      if (isNote) row.createSpan({ cls: "mos-note-kind-icon", attr: { "aria-label": "Note", title: "Note" }, text: "📝" });
      const textSpan = renderMdContent(this.app, this, row, "span", "morning-os-task-text", task.text);
      attachInlineTextEdit(this.app, textSpan, task, () => this.plugin.refreshView(), this);
      if (task.date_remind) {
        row.createSpan({ cls: "morning-os-reminder-badge", text: `⏰ ${task.date_remind}` });
      }
      if (task.notes?.trim() && this.plugin.settings.showNotesIndicator) {
        row.createSpan({ cls: "mos-notes-badge", attr: { title: "Has notes" }, text: "📝" });
      }

      const moreBtn = row.createEl("button", { cls: "mos-more-btn", text: "⋯" });
      moreBtn.addEventListener("click", () => {
        const menuItems: MenuAction[] = [];
        if (task.parent_id === null) {
          menuItems.push({
            label: "＋ Add subtask",
            action: () => {
              const list = ensureChildList();
              collapsedTasks.delete(task._id);
              list.removeClass("is-collapsed");
              row.querySelector<HTMLButtonElement>(".mos-subtask-toggle")?.setText("▾");
              renderAddTaskInput(list, this.app, "Add subtask…", async (text) => {
                const child = createChildItem(text, task);
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
          ...buildTodayMembershipActions(this.app, task, this.plugin, () => this.plugin.refreshView()),
          {
            label: task.kind === "note" ? "Archive" : "",
            action: () => {
              if (task.kind === "note") void setNoteStatus(this.app, task._id, "archived").then(() => this.plugin.refreshView());
            },
          },
          {
            label: task.kind === "note" ? "Convert to task" : "Convert to note",
            action: () => void changeItemKind(this.app, task._id, task.kind === "note" ? "task" : "note").then(() => this.plugin.refreshView()),
          },
          {
            label: "✎ Edit metadata",
            action: () => {
              new TaskEditModal(this.app, task, () => {
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
        openContextMenu(moreBtn, menuItems.filter(item => item.label));
      });

      checkbox?.addEventListener("change", () => {
        if (checkbox.checked && this.plugin.settings.requireSubtasksComplete && hasOpenChildren(this.registry, task._id)) {
          checkbox.checked = false;
          new Notice("Morning OS: Complete all subtasks first");
          return;
        }
        row.toggleClass("morning-os-task-done", checkbox.checked);
        const updateStatus = setTaskStatus(this.app, task._id, checkbox.checked ? "done" : "open");
        void updateStatus
          .then(() => this.plugin.refreshView());
      });

      if (children.length > 0) {
        const list = ensureChildList();
        for (const child of children) {
          renderTaskRowShared(list, child, this.app, this, () => this.plugin.refreshView(), this.plugin, false, undefined, this.registry, true, undefined, undefined, { parentOwnsPlacement: true });
        }
      }
      this.renderTodayRootSupportingContent(parent, row, task);
    }
  }

  private renderRegistryDoneList(parent: HTMLElement, tasks: Task[]) {
    for (const task of tasks) {
      const children = getChildren(this.registry, task._id).filter(child => child.kind === "task" &&
        (isItemActive(child) || (child.status_completion === "done" && child.date_completed === todayStr())));
      const isArchivedNote = task.kind === "note" && task.status_note === "archived";
      const row = parent.createDiv({ cls: "morning-os-task-row" + (task.kind === "task" ? " morning-os-task-done" : "") + (isArchivedNote ? " mos-note-archived" : "") });

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

      const checkbox = task.kind === "task" ? row.createEl("input", { type: "checkbox" }) : null;
      if (checkbox) checkbox.checked = true;
      if (task.kind === "note") {
        row.createSpan({ cls: "mos-note-kind-icon", attr: { "aria-label": "Note", title: "Note" }, text: "📝" });
        row.createSpan({ cls: "mos-note-status", text: "Archived" });
      }
      const textSpan = renderMdContent(this.app, this, row, "span", "morning-os-task-text", task.text);
      attachInlineTextEdit(this.app, textSpan, task, () => this.plugin.refreshView(), this);
      if (task.notes?.trim() && this.plugin.settings.showNotesIndicator) {
        row.createSpan({ cls: "mos-notes-badge", attr: { title: "Has notes" }, text: "📝" });
      }
      const moreBtn = row.createEl("button", { cls: "mos-more-btn", text: "⋯" });
      moreBtn.addEventListener("click", () => {
        const menuItems: MenuAction[] = [
          {
            label: task.kind === "note" ? "Unarchive" : "",
            action: () => { if (task.kind === "note") void setNoteStatus(this.app, task._id, "active").then(() => this.plugin.refreshView()); },
          },
          {
            label: task.kind === "note" ? "Convert to task" : "Convert to note",
            action: () => void changeItemKind(this.app, task._id, task.kind === "note" ? "task" : "note").then(() => this.plugin.refreshView()),
          },
        ];
        openContextMenu(moreBtn, menuItems.filter(item => item.label));
      });
      checkbox?.addEventListener("change", () => {
        if (checkbox.checked && this.plugin.settings.requireSubtasksComplete && hasOpenChildren(this.registry, task._id)) {
          checkbox.checked = false;
          new Notice("Morning OS: Complete all subtasks first");
          return;
        }
        row.toggleClass("morning-os-task-done", checkbox.checked);
        const updateStatus = setTaskStatus(this.app, task._id, checkbox.checked ? "done" : "open");
        void updateStatus
          .then(() => this.plugin.refreshView());
      });

      if (children.length > 0) {
        const list = ensureChildList();
        for (const child of children) {
          renderTaskRowShared(list, child, this.app, this, () => this.plugin.refreshView(), this.plugin, false, undefined, this.registry, true, undefined, undefined, { parentOwnsPlacement: true });
        }
      }
      this.renderTodayRootSupportingContent(parent, row, task);
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
      const checkbox = task.kind === "task" ? row.createEl("input", { type: "checkbox" }) : null;
      if (task.kind === "note") row.createSpan({ cls: "mos-note-kind-icon", attr: { "aria-label": "Note", title: "Note" }, text: "📝" });
      const textSpan = renderMdContent(this.app, this, row, "span", "morning-os-task-text", task.text);
      attachInlineTextEdit(this.app, textSpan, task, () => void this.plugin.refreshView(), this);
      row.createSpan({ cls: "morning-os-reminder-badge", text: `⏰ ${task.date_remind}` });

      // Dismiss = clear remind date (task stays open)
      const dismissBtn = row.createEl("button", { cls: "mos-task-action-btn mos-task-action-delete", text: "🗑" });
      dismissBtn.setAttribute("aria-label", "Dismiss reminder");
      dismissBtn.addEventListener("click", () => {
        row.remove();
        void setTaskReminder(this.app, task._id, null).then(() => this.plugin.refreshView());
      });

      // Completion is a Task-only operation; Notes remain reference items.
      checkbox?.addEventListener("change", () => {
        row.toggleClass("morning-os-task-done", checkbox.checked);
        if (checkbox.checked) {
          void setTaskStatus(this.app, task._id, "done").then(() => this.plugin.refreshView());
        }
      });
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
  const activeDocument = container.ownerDocument;
  const handle = container.createEl("button", { cls: "morning-os-floating-handle", attr: { type: "button", "aria-label": "Open Morning OS navigation", "aria-expanded": "false" } });
  handle.createSpan({ cls: "morning-os-floating-handle-icon", text: "☰" });
  const actions = container.createDiv({ cls: "morning-os-floating-actions", attr: { "aria-label": "Morning OS navigation" } });

  const show = () => {
    actions.addClass("is-visible");
    handle.setAttribute("aria-expanded", "true");
  };
  const hide = () => {
    actions.removeClass("is-visible");
    handle.setAttribute("aria-expanded", "false");
  };
  const toggle = () => actions.hasClass("is-visible") ? hide() : show();
  const isMobileLayout = () => container.ownerDocument.defaultView?.matchMedia("(max-width: 600px)").matches ?? false;

  // Desktop exposes navigation as a hover/focus flyout. Only the compact mobile
  // layout needs a persistent tap-to-toggle state.
  handle.addEventListener("click", () => {
    if (isMobileLayout()) toggle();
  });
  const outsideHandler = (e: PointerEvent) => {
    if (isMobileLayout() && !handle.contains(e.target as Node) && !actions.contains(e.target as Node)) hide();
  };
  activeDocument.addEventListener("pointerdown", outsideHandler);
  const keyHandler = (event: KeyboardEvent) => {
    if (isMobileLayout() && event.key === "Escape" && actions.hasClass("is-visible")) {
      hide();
      handle.focus();
    }
  };
  activeDocument.addEventListener("keydown", keyHandler);
  const cleanup = () => {
    activeDocument.removeEventListener("pointerdown", outsideHandler);
    activeDocument.removeEventListener("keydown", keyHandler);
  };

  const renderNavigationItems = (parent: HTMLElement, items: ReturnType<typeof buildNavItems>) => {
    for (const item of items) {
      const btn = parent.createEl("button", { cls: "morning-os-fab morning-os-fab-view", text: item.label });
      btn.addEventListener("click", () => {
        hide();
        if (item.id === "home") void plugin.activateView();
        else if (item.id === "all") void plugin.activateAllItems();
        else if (item.id === "dump") void plugin.activateDump();
        else if (item.id === "trash") void plugin.activateTrash();
        else void plugin.activateArea(item.id);
      });
    }
  };

  const navigation = actions.createDiv({ cls: "morning-os-floating-group" });
  navigation.createDiv({ cls: "morning-os-fab-label", text: "Views" });
  renderNavigationItems(navigation, buildNavItems([]));

  if (plugin.settings.areas.length > 0) {
    const areas = actions.createDiv({ cls: "morning-os-floating-group morning-os-floating-areas" });
    areas.createDiv({ cls: "morning-os-fab-label", text: "Areas" });
    renderNavigationItems(areas, buildNavItems(plugin.settings.areas).slice(4));
  }

  const briefing = actions.createDiv({ cls: "morning-os-floating-group morning-os-floating-briefing" });
  briefing.createDiv({ cls: "morning-os-fab-label", text: "Briefing" });
  const refreshBtn = briefing.createEl("button", { cls: "morning-os-fab" });
  refreshBtn.appendChild(sanitizeHTMLToDom(`<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>`));
  refreshBtn.appendText(" Regenerate briefing");
  refreshBtn.setAttribute("aria-label", "Regenerate briefing");
  refreshBtn.addEventListener("click", () => { hide(); void plugin.regenerateBriefing(); });

  return { handle, actions, cleanup };
}

type FilterState = {
  query?: string;
  priority?: "red" | "regular";
  urgency?: "none" | "low" | "med" | "high";
  remind?: "has" | "due";
  status?: "open" | "done" | "dismissed";
  custom?: Record<string, string>;
};

function metadataText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function itemMatchesQuery(item: Task, rawQuery: string): boolean {
  const query = rawQuery.trim().toLocaleLowerCase();
  if (!query) return true;
  return [item.text, item.notes, item.details ?? "", ...Object.values(item.tags).map(metadataText)]
    .some(value => value.toLocaleLowerCase().includes(query));
}

/** A defined result means this root matched only through live children. */
export function getChildOnlySearchMatches(parent: Task, filters: FilterState, registry: TaskRegistry): Task[] | undefined {
  const query = filters.query;
  if (!query?.trim() || itemMatchesQuery(parent, query)) return undefined;
  return getChildren(registry, parent._id).filter(child => itemMatchesQuery(child, query));
}

export function applyFilters(tasks: Task[], filters: FilterState, registry: TaskRegistry = tasks): Task[] {
  const today = todayStr();
  return tasks.filter(t => {
    const query = filters.query;
    if (query?.trim()) {
      if (!itemMatchesQuery(t, query) && !getChildren(registry, t._id).some(child => itemMatchesQuery(child, query))) return false;
    }
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

export function isItemActive(item: Task): boolean {
  return item.kind === "note" ? item.status_note !== "archived" : item.status_completion === "open";
}

export function renderFilterSelects(
  parent: HTMLElement,
  filters: FilterState,
  onChange: (f: FilterState) => void,
  showUrgency = false,
  tabFields?: FieldDef[],
  onQueryInput?: (f: FilterState) => void,
  getCurrentFilters: () => FilterState = () => filters,
) {
  const search = parent.createEl("input", { type: "search", cls: "mos-filter-search", placeholder: "Search items", attr: { "aria-label": "Search items" } });
  search.value = filters.query ?? "";
  search.addEventListener("input", () => {
    const next = { ...getCurrentFilters(), query: search.value };
    if (onQueryInput) onQueryInput(next);
    else onChange(next);
  });

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
    v => onChange({ ...getCurrentFilters(), priority: v as FilterState["priority"] || undefined })
  );

  mkSelect(
    [{ value: "", label: "Status: All" }, { value: "open", label: "Open" }, { value: "done", label: "Done" }, { value: "dismissed", label: "Dismissed" }],
    filters.status,
    v => onChange({ ...getCurrentFilters(), status: v as FilterState["status"] || undefined })
  );

  if (showUrgency) {
    mkSelect(
      [{ value: "", label: "Urgency: All" }, { value: "none", label: "—" }, { value: "low", label: "Low" }, { value: "med", label: "Med" }, { value: "high", label: "High" }],
      filters.urgency,
      v => onChange({ ...getCurrentFilters(), urgency: v as FilterState["urgency"] || undefined })
    );
  }

  mkSelect(
    [{ value: "", label: "Remind: All" }, { value: "has", label: "Has reminder" }, { value: "due", label: "Due today" }],
    filters.remind,
    v => onChange({ ...getCurrentFilters(), remind: v as FilterState["remind"] || undefined })
  );

  // Custom field filters (dropdown fields only)
  if (tabFields?.length) {
    for (const field of tabFields) {
      if (field.type === "dropdown" && field.options?.length) {
        const opts = [{ value: "", label: `${field.label}: All` }, ...field.options.map(o => ({ value: o, label: o }))];
        const currentCustom = filters.custom?.[field.key];
        mkSelect(opts, currentCustom, v => {
          const custom = { ...(getCurrentFilters().custom ?? {}) };
          if (v) custom[field.key] = v;
          else delete custom[field.key];
          onChange({ ...getCurrentFilters(), custom: Object.keys(custom).length > 0 ? custom : undefined });
        });
      }
    }
  }
}

type ViewToolbarOptions = {
  filters: FilterState;
  getCurrentFilters: () => FilterState;
  onFiltersChange: (filters: FilterState) => void;
  sortField: SortField;
  sortDir: SortDir;
  onSortChange: (field: SortField) => void;
  onSortDirectionChange: (direction: SortDir) => void;
  showGrouping: boolean;
  groupByStatus?: boolean;
  onGroupByStatusChange?: (groupByStatus: boolean) => void;
  showUrgency: boolean;
  tabFields?: FieldDef[];
};

type ActiveFilter = { label: string; clear: (filters: FilterState) => FilterState };

function getActiveFilters(filters: FilterState, tabFields?: FieldDef[]): ActiveFilter[] {
  const active: ActiveFilter[] = [];
  if (filters.status) active.push({ label: `Status: ${filters.status}`, clear: current => ({ ...current, status: undefined }) });
  if (filters.urgency) active.push({ label: `Urgency: ${filters.urgency}`, clear: current => ({ ...current, urgency: undefined }) });
  if (filters.remind) active.push({ label: `Reminder: ${filters.remind === "due" ? "Due today" : "Has reminder"}`, clear: current => ({ ...current, remind: undefined }) });
  for (const [key, value] of Object.entries(filters.custom ?? {})) {
    if (!value) continue;
    const label = tabFields?.find(field => field.key === key)?.label ?? key;
    active.push({
      label: `${label}: ${value}`,
      clear: current => {
        const custom = { ...(current.custom ?? {}) };
        delete custom[key];
        return { ...current, custom: Object.keys(custom).length ? custom : undefined };
      },
    });
  }
  return active;
}

/**
 * Mounts the persistent search and view-options surface used by Area, Inbox,
 * and All Items. Result updates are delegated to the caller so typing and
 * option changes never replace the toolbar or close its open panel.
 */
export function renderViewToolbar(parent: HTMLElement, options: ViewToolbarOptions): () => void {
  const toolbar = parent.createDiv({ cls: "mos-view-toolbar" });
  const search = toolbar.createEl("input", {
    type: "search",
    cls: "mos-filter-search",
    placeholder: "Search items",
    attr: { "aria-label": "Search items" },
  });
  search.value = options.filters.query ?? "";

  const optionsButton = toolbar.createEl("button", {
    cls: "mos-btn mos-view-options-button",
    text: "⚙ View options",
    attr: { "aria-label": "View options", "aria-expanded": "false" },
  });
  const overlay = toolbar.createDiv({ cls: "mos-view-options-overlay", attr: { hidden: "" } });
  const panel = overlay.createDiv({ cls: "mos-view-options-panel", attr: { role: "dialog", "aria-label": "View options" } });
  const panelHeader = panel.createDiv({ cls: "mos-view-options-header" });
  panelHeader.createEl("strong", { text: "View options" });
  const closeButton = panelHeader.createEl("button", { cls: "mos-btn mos-btn-icon mos-view-options-close", text: "×", attr: { "aria-label": "Close view options" } });
  const panelBody = panel.createDiv({ cls: "mos-view-options-body" });
  const chips = parent.createDiv({ cls: "mos-active-filter-chips" });

  const filterSelects: { select: HTMLSelectElement; getValue: (filters: FilterState) => string }[] = [];
  const applyFilters = (next: FilterState): void => {
    options.onFiltersChange(next);
    renderChips();
    syncOptionValues();
  };
  const createSection = (label: string): HTMLElement => {
    const section = panelBody.createDiv({ cls: "mos-view-options-section" });
    section.createEl("h2", { text: label });
    return section;
  };
  const createSelect = (
    section: HTMLElement,
    label: string,
    entries: { value: string; label: string }[],
    getValue: (filters: FilterState) => string | undefined,
    change: (value: string) => void,
  ): HTMLSelectElement => {
    const field = section.createEl("label", { cls: "mos-view-options-field", text: label });
    const select = field.createEl("select", { cls: "mos-btn mos-btn-select mos-filter-select", attr: { "aria-label": label } });
    for (const entry of entries) select.createEl("option", { value: entry.value, text: entry.label });
    select.value = getValue(options.getCurrentFilters()) ?? "";
    select.addEventListener("change", () => change(select.value));
    filterSelects.push({ select, getValue: filters => getValue(filters) ?? "" });
    return select;
  };

  const sortSection = createSection("Sort");
  const sortField = createSelect(
    sortSection,
    "Sort field",
    [
      { value: "date_created", label: "Created" },
      { value: "date_modified", label: "Modified" },
      { value: "date_completed", label: "Completed" },
      { value: "name", label: "Name" },
    ],
    () => options.sortField,
    value => {
      options.sortField = value as SortField;
      options.onSortChange(options.sortField);
    },
  );
  const directionButton = sortSection.createEl("button", {
    cls: "mos-btn mos-view-options-direction",
    text: options.sortDir === "asc" ? "↑ Ascending" : "↓ Descending",
    attr: { "aria-label": "Sort direction" },
  });
  directionButton.addEventListener("click", () => {
    const next = options.sortDir === "asc" ? "desc" : "asc";
    options.onSortDirectionChange(next);
    options.sortDir = next;
    directionButton.textContent = next === "asc" ? "↑ Ascending" : "↓ Descending";
  });

  if (options.showGrouping && options.onGroupByStatusChange) {
    const grouping = createSection("Grouping");
    const groupField = grouping.createEl("label", { cls: "mos-view-options-switch", text: "Group by status" });
    const groupSwitch = groupField.createEl("input", {
      type: "checkbox",
      attr: { "aria-label": "Group items by active status" },
    });
    groupSwitch.checked = options.groupByStatus ?? true;
    groupSwitch.addEventListener("change", () => options.onGroupByStatusChange?.(groupSwitch.checked));
  }

  const filtersSection = createSection("Filters");
  createSelect(
    filtersSection,
    "Task status",
    [{ value: "", label: "All" }, { value: "open", label: "Open" }, { value: "done", label: "Done" }, { value: "dismissed", label: "Dismissed" }],
    filters => filters.status,
    value => applyFilters({ ...options.getCurrentFilters(), status: value as FilterState["status"] || undefined }),
  );
  if (options.showUrgency) {
    createSelect(
      filtersSection,
      "Urgency",
      [{ value: "", label: "All" }, { value: "none", label: "None" }, { value: "low", label: "Low" }, { value: "med", label: "Medium" }, { value: "high", label: "High" }],
      filters => filters.urgency,
      value => applyFilters({ ...options.getCurrentFilters(), urgency: value as FilterState["urgency"] || undefined }),
    );
  }
  createSelect(
    filtersSection,
    "Reminder",
    [{ value: "", label: "All" }, { value: "has", label: "Has reminder" }, { value: "due", label: "Due today" }],
    filters => filters.remind,
    value => applyFilters({ ...options.getCurrentFilters(), remind: value as FilterState["remind"] || undefined }),
  );
  for (const field of options.tabFields ?? []) {
    if (field.type !== "dropdown" || !field.options?.length) continue;
    createSelect(
      filtersSection,
      field.label,
      [{ value: "", label: "All" }, ...field.options.map(value => ({ value, label: value }))],
      filters => filters.custom?.[field.key],
      value => {
        const custom = { ...(options.getCurrentFilters().custom ?? {}) };
        if (value) custom[field.key] = value;
        else delete custom[field.key];
        applyFilters({ ...options.getCurrentFilters(), custom: Object.keys(custom).length ? custom : undefined });
      },
    );
  }

  const syncOptionValues = (): void => {
    const current = options.getCurrentFilters();
    for (const control of filterSelects) control.select.value = control.getValue(current);
    sortField.value = options.sortField;
  };
  const renderChips = (): void => {
    chips.empty();
    const active = getActiveFilters(options.getCurrentFilters(), options.tabFields);
    optionsButton.textContent = active.length ? `⚙ View options · ${active.length}` : "⚙ View options";
    if (!active.length) return;
    for (const filter of active) {
      const chip = chips.createEl("button", { cls: "mos-filter-chip", text: `${filter.label} ×`, attr: { "aria-label": `Remove ${filter.label} filter` } });
      chip.addEventListener("click", () => applyFilters(filter.clear(options.getCurrentFilters())));
    }
    const clear = chips.createEl("button", { cls: "mos-btn mos-filter-clear", text: "Clear filters" });
    clear.addEventListener("click", () => applyFilters({ query: options.getCurrentFilters().query }));
  };

  let open = false;
  const setOpen = (next: boolean): void => {
    open = next;
    overlay.toggleAttribute("hidden", !next);
    optionsButton.setAttribute("aria-expanded", String(next));
    if (next) sortField.focus();
    else optionsButton.focus();
  };
  optionsButton.addEventListener("click", () => setOpen(!open));
  closeButton.addEventListener("click", () => setOpen(false));
  search.addEventListener("input", () => options.onFiltersChange({ ...options.getCurrentFilters(), query: search.value }));

  const ownerDocument = parent.ownerDocument;
  const onPointerDown = (event: PointerEvent): void => {
    if (open && !panel.contains(event.target as Node) && event.target !== optionsButton) setOpen(false);
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (open && event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
    }
  };
  ownerDocument.addEventListener("pointerdown", onPointerDown);
  ownerDocument.addEventListener("keydown", onKeyDown);
  renderChips();
  return () => {
    ownerDocument.removeEventListener("pointerdown", onPointerDown);
    ownerDocument.removeEventListener("keydown", onKeyDown);
  };
}


type SortField = "date_created" | "date_modified" | "date_completed" | "name";
type SortDir = "asc" | "desc";

const sortTasks = sortItems;

const URGENCY_DOT: Record<string, string> = { low: "#3fb950", med: "#c9a84c", high: "#e5534b", none: "transparent" };
const URGENCY_LABEL: Record<string, string> = { low: "L", med: "M", high: "H", none: "" };

type MenuAction = { label: string; danger?: boolean; action: () => void };

type TodayMembershipContext = { parentOwnsPlacement?: boolean };

function buildTodayMembershipActions(
  app: App,
  task: Task,
  plugin: MorningOSPlugin | undefined,
  onRefresh: () => void,
  context: TodayMembershipContext = {},
): MenuAction[] {
  if (!task.is_today) return [];
  const placementHint = context.parentOwnsPlacement ? " (parent placement unchanged)" : "";
  const removalHint = context.parentOwnsPlacement ? " (still shown under parent)" : "";
  const refresh = async (): Promise<void> => {
    if (plugin) {
      await plugin.autoRefreshBrief();
      plugin.refreshView();
      return;
    }
    onRefresh();
  };
  const run = (operation: () => Promise<void>): void => {
    void operation().then(refresh).catch(error => {
      new Notice(`Morning OS: could not update Today — ${(error as Error).message}`);
    });
  };
  const nextPriority = task.status_priority === "red" ? "regular" : "red";
  const nextLabel = task.status_priority === "red" ? "→ Move to Regular" : "🔴 Move to Red alert";
  return [
    {
      label: `${nextLabel}${placementHint}`,
      action: () => run(() => changeTodayPriority(app, task._id, nextPriority)),
    },
    {
      label: `✕ Remove from Today${removalHint}`,
      action: () => run(() => removeTaskFromToday(app, task._id)),
    },
  ];
}

function openContextMenu(anchor: HTMLElement, items: MenuAction[]) {
  const ownerDocument = anchor.ownerDocument;
  ownerDocument.querySelector(".mos-ctx-menu")?.remove();
  const menu = ownerDocument.body.createDiv({ cls: "mos-ctx-menu" });
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
    if (!menu.contains(e.target as Node)) { menu.remove(); ownerDocument.removeEventListener("mousedown", close); }
  };
  ownerDocument.addEventListener("mousedown", close);
}

/**
 * Keep a root and its direct children together while applying the same ordering
 * rules in cards and tables. Deleted children are intentionally absent because
 * getChildren filters them before group activity is calculated.
 */
export function sortItemsByStatus(
  items: Task[],
  registry: TaskRegistry,
  field: SortField,
  dir: SortDir,
  groupByStatus: boolean,
  includeChildActivity = false,
): Task[] {
  if (!groupByStatus) return sortTasks(items, field, dir);
  const active: Task[] = [];
  const inactive: Task[] = [];
  for (const item of items) {
    const groupIsActive = isItemActive(item) || (includeChildActivity && getChildren(registry, item._id).some(isItemActive));
    (groupIsActive ? active : inactive).push(item);
  }
  return [...sortTasks(active, field, dir), ...sortTasks(inactive, field, dir)];
}

export function attachInlineTextEdit(app: App, textSpan: HTMLElement, task: Task, onSaved: () => void, owner?: Component, onSaveSettled?: () => void) {
  textSpan.addEventListener("dblclick", () => {
    const base = cloneItemDraft(task);
    const input = textSpan.parentElement!.createEl("input", { type: "text", cls: "morning-os-wins-input mos-inline-edit" });
    input.value = base.text;
    textSpan.replaceWith(input);
    attachTaskTextSuggest(app, input);
    input.focus();
    const finishEditing = beginEditingSession();
    let saving = false;
    let closed = false;
    let recoveryOpen = false;
    let conflictEl: HTMLElement | null = null;
    const scope = input.parentElement!;
    let unregister: () => void = () => undefined;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      unregister();
      finishEditing();
    };
    unregister = registerEditorCleanup(scope, cleanup);
    owner?.register(cleanup);
    const discard = () => {
      if (closed) return;
      conflictEl?.remove();
      if (input.isConnected) input.replaceWith(textSpan);
      cleanup();
    };
    const showDeleted = () => {
      if (closed || !input.isConnected) return;
      recoveryOpen = true;
      conflictEl?.remove();
      conflictEl = input.parentElement!.createDiv({ cls: "mos-edit-conflict", text: "This item was deleted elsewhere. Your draft is preserved below; copy it before closing." });
      const copy = conflictEl.createEl("textarea", { cls: "mos-edit-input mos-edit-textarea" });
      copy.value = input.value;
      copy.readOnly = true;
      conflictEl.createEl("button", { cls: "mos-btn", text: "Keep draft open" }).addEventListener("click", () => input.focus());
      input.focus();
    };
    const save = async () => {
      if (saving || closed || recoveryOpen) return;
      saving = true;
      const newText = input.value.trim();
      try {
        if (!newText || newText === base.text) { discard(); return; }
        const draft = cloneItemDraft(base);
        draft.text = newText;
        const result = await saveItemDraft(app, base, draft);
        if (closed) return;
        if (result.status === "saved") {
          cleanup();
          onSaved();
          return;
        }
        if (result.status === "deleted") { showDeleted(); return; }
        conflictEl?.remove();
        const conflict = result.conflicts.find(entry => entry.field === "text");
        conflictEl = input.parentElement!.createDiv({ cls: "mos-edit-conflict" });
        conflictEl.createEl("p", { text: "Text changed elsewhere. Choose which version to keep:" });
        const external = conflictEl.createEl("textarea", { cls: "mos-edit-input mos-edit-textarea" });
        external.value = String(conflict?.external ?? ""); external.readOnly = true;
        const draftText = conflictEl.createEl("textarea", { cls: "mos-edit-input mos-edit-textarea" });
        draftText.value = input.value; draftText.readOnly = true;
        conflictEl.createEl("button", { cls: "mos-btn", text: "Use external text" }).addEventListener("click", () => {
          if (closed) return;
          textSpan.setText(String(conflict?.external ?? ""));
          discard();
          onSaved();
        });
        conflictEl.createEl("button", { cls: "mos-btn mos-btn-primary", text: "Use my draft" }).addEventListener("click", () => {
          if (saving || closed) return;
          saving = true;
          void saveItemDraft(app, base, draft, ["text"]).then(forced => {
            if (closed) return;
            if (forced.status === "saved") { cleanup(); onSaved(); }
            else if (forced.status === "deleted") showDeleted();
            else { conflictEl?.createEl("p", { text: "This field changed again. Review the latest conflict before saving." }); }
          }).catch(error => {
            if (!closed) {
              conflictEl?.createEl("p", { text: `Could not save draft: ${(error as Error).message}` });
              input.focus();
            }
          }).finally(() => {
            if (!closed) saving = false;
            onSaveSettled?.();
          });
        });
        input.focus();
      } catch (error) {
        if (closed) return;
        new Notice(`Morning OS: draft was not saved — ${(error as Error).message}`);
        input.focus();
      } finally {
        if (!closed) saving = false;
        onSaveSettled?.();
      }
    };
    input.addEventListener("blur", () => { if (!recoveryOpen) void save(); });
    scope.addEventListener("pointerdown", event => {
      if (conflictEl?.contains(event.target as Node)) recoveryOpen = true;
    });
    input.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") void save();
      if (e.key === "Escape") discard();
    });
  });
}

// Tracks which parent tasks have their subtask list collapsed. Module-level so the
// collapsed/expanded state survives the full re-render every refresh triggers.
const collapsedTasks = new Set<string>();

export function renderTaskRowShared(
  parent: HTMLElement,
  task: Task,
  app: App,
  component: Component,
  onRefresh: () => void,
  plugin?: MorningOSPlugin,
  showUrgency = false,
  tabFields?: FieldDef[],
  registry: TaskRegistry = [],
  isChild = false,
  visibleChildren?: Task[],
  orderChildren?: (children: Task[]) => Task[],
  todayContext?: TodayMembershipContext,
) {
  const isArchivedNote = task.kind === "note" && task.status_note === "archived";
  const isDone = task.kind === "task" && task.status_completion === "done";
  const unfilteredChildren = !isChild ? (visibleChildren ?? getChildren(registry, task._id)) : [];
  const children = orderChildren ? orderChildren(unfilteredChildren) : unfilteredChildren;
  const searchExpandedChildren = visibleChildren !== undefined;
  const hasChildren = children.length > 0;
  const row = parent.createDiv({ cls: "morning-os-task-row" + (isDone ? " morning-os-task-done" : "") + (isArchivedNote ? " mos-note-archived" : "") + (isChild ? " mos-task-row-child" : "") });

  if (hasChildren) {
    const toggleBtn = row.createEl("button", {
      cls: "mos-subtask-toggle",
      text: !searchExpandedChildren && collapsedTasks.has(task._id) ? "▸" : "▾",
    });
    toggleBtn.addEventListener("click", () => {
      const collapsed = collapsedTasks.has(task._id);
      if (collapsed) collapsedTasks.delete(task._id); else collapsedTasks.add(task._id);
      toggleBtn.setText(collapsed ? "▾" : "▸");
      ensureChildList().toggleClass("is-collapsed", !collapsed);
    });
  }

  let checkbox: HTMLInputElement | null = null;
  if (task.kind === "task") {
    checkbox = row.createEl("input", { type: "checkbox" });
    checkbox.checked = isDone;
  } else {
    row.createSpan({ cls: "mos-note-kind-icon", attr: { "aria-label": "Note", title: "Note" }, text: "📝" });
    if (isArchivedNote) row.createSpan({ cls: "mos-note-status", text: "Archived" });
  }

  // Urgency dot
  const dot = row.createSpan({ cls: "mos-urgency-dot", attr: { title: `Urgency: ${task.status_urgency}` } });
  dot.style.background = URGENCY_DOT[task.status_urgency] ?? URGENCY_DOT.none;
  dot.textContent = URGENCY_LABEL[task.status_urgency] ?? "";

  // Inline text — double-click to edit
  const textSpan = renderMdContent(app, component, row, "span", "morning-os-task-text", task.text);
  attachInlineTextEdit(app, textSpan, task, onRefresh, component);

  if (task.date_remind) {
    row.createSpan({ cls: "morning-os-reminder-badge", text: `⏰ ${task.date_remind}` });
  }

  if ((task.details?.trim() || task.notes?.trim()) && (plugin?.settings.showNotesIndicator ?? true)) {
    row.createSpan({ cls: "mos-notes-badge", attr: { title: "Has details" }, text: "📝" });
  }

  // Meta field chips (area tab context only)
  if (tabFields?.length) {
    const chipRow = row.createSpan({ cls: "mos-task-meta-chips" });
    for (const field of tabFields) {
      const val = metadataText(task.tags[field.key]);
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
      row.after(childListEl);
      if (!searchExpandedChildren && collapsedTasks.has(task._id)) childListEl.addClass("is-collapsed");
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
          collapsedTasks.delete(task._id);
          list.removeClass("is-collapsed");
          row.querySelector<HTMLButtonElement>(".mos-subtask-toggle")?.setText("▾");
          renderAddTaskInput(list, app, "Add subtask…", async (text) => {
            const child = createChildItem(text, task);
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
    menuItems.push(...buildTodayMembershipActions(app, task, plugin, onRefresh, todayContext));
    menuItems.push(
      {
        label: task.kind === "note" ? "Convert to task" : "Convert to note",
        action: () => {
          void changeItemKind(app, task._id, task.kind === "note" ? "task" : "note").then(() => {
            if (plugin) void plugin.refreshView();
            onRefresh();
          });
        },
      },
      {
        label: task.kind === "note" ? (isArchivedNote ? "Unarchive" : "Archive") : "",
        action: () => {
          if (task.kind !== "note") return;
          void setNoteStatus(app, task._id, isArchivedNote ? "active" : "archived").then(() => {
            if (plugin) plugin.refreshView();
            onRefresh();
          });
        },
      },
      {
        label: "✎ Edit metadata",
        action: () => {
          new TaskEditModal(app, task, () => {
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
    openContextMenu(moreBtn, menuItems.filter(item => item.label));
  });

  checkbox?.addEventListener("change", () => {
    if (checkbox.checked && plugin?.settings.requireSubtasksComplete && hasOpenChildren(registry, task._id)) {
      checkbox.checked = false;
      new Notice("Morning OS: Complete all subtasks first");
      return;
    }
    row.toggleClass("morning-os-task-done", checkbox.checked);
    const updateStatus = setTaskStatus(app, task._id, checkbox.checked ? "done" : "open");
    void updateStatus.then(() => {
      if (plugin) plugin.refreshView();
    });
  });

  if (!isChild) {
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
  private viewOptionsCleanup: (() => void) | null = null;
  private filters: FilterState = {};
  private activeItemPanel: "tasks" | "notes" = "tasks";
  private collapsedItemPanel: "tasks" | "notes" | null = null;
  private groupByStatus: boolean | null = null;
  private resultsEl: HTMLElement | null = null;
  private scrollEl: HTMLElement | null = null;
  private refreshQueued: "results" | "layout" | null = null;
  private refreshSettledUnsubscribe: (() => void) | null = null;
  private closed = false;
  private lifecycle = 0;

  constructor(leaf: WorkspaceLeaf, settings: MorningOSSettings, plugin: MorningOSPlugin, areaKey: string) {
    super(leaf);
    this.settings = settings;
    this.plugin = plugin;
    this.areaKey = areaKey;
  }

  getViewType(): string { return `${VIEW_TYPE_AREA}-${this.areaKey}`; }
  getDisplayText(): string { return this.plugin.settings.areas.find(p => p.key === this.areaKey)?.label ?? this.areaKey; }
  getIcon(): string { return "layers"; }

  async onOpen() {
    this.closed = false;
    const lifecycle = ++this.lifecycle;
    const registry = await loadRegistry(this.app);
    if (!this.isCurrent(lifecycle)) return;
    this.registry = registry;
    this.render();
  }
  async refresh(layout = false) {
    if (this.closed) return;
    const lifecycle = this.lifecycle;
    const registry = await loadRegistry(this.app);
    if (!this.isCurrent(lifecycle)) return;
    this.registry = registry;
    if (hasActiveEditingSession()) { this.deferRefresh(layout); return; }
    if (!this.resultsEl || !this.scrollEl) { this.render(); return; }
    const scrollTop = this.scrollEl.scrollTop;
    if (layout) { this.normalizeCustomFilters(); this.render(); if (this.isCurrent(lifecycle)) this.restoreScroll(scrollTop); return; }
    const area = this.plugin.settings.areas.find(p => p.key === this.areaKey);
    if (!area) { this.render(); return; }
    const activeTabConfig = area.tabs.find(t => t.key === this.activeTab) ?? null;
    const advanced = this.plugin.settings.advancedAreaFeatures;
    this.renderResults(this.resultsEl, area, activeTabConfig, advanced ? activeTabConfig?.fields : undefined, advanced);
    if (this.isCurrent(lifecycle)) this.restoreScroll(scrollTop);
  }
  async onClose() {
    if (this.closed) return;
    this.closed = true;
    ++this.lifecycle;
    this.refreshQueued = null;
    this.refreshSettledUnsubscribe?.();
    this.refreshSettledUnsubscribe = null;
    disposeEditorsIn(this.containerEl);
    this.floatingCleanup?.();
    this.floatingCleanup = null;
    this.viewOptionsCleanup?.();
    this.viewOptionsCleanup = null;
  }

  private isCurrent(lifecycle: number): boolean { return !this.closed && this.lifecycle === lifecycle; }
  private restoreScroll(scrollTop: number): void {
    if (!this.scrollEl) return;
    this.scrollEl.scrollTop = Math.min(scrollTop, Math.max(0, this.scrollEl.scrollHeight - this.scrollEl.clientHeight));
  }
  private deferRefresh(layout: boolean): void {
    if (layout || this.refreshQueued === null) this.refreshQueued = layout ? "layout" : "results";
    if (this.refreshSettledUnsubscribe) return;
    const lifecycle = this.lifecycle;
    this.refreshSettledUnsubscribe = onEditingSessionsSettled(() => {
      this.refreshSettledUnsubscribe?.(); this.refreshSettledUnsubscribe = null;
      const queued = this.refreshQueued; this.refreshQueued = null;
      if (queued && this.isCurrent(lifecycle)) void this.refresh(queued === "layout");
    });
  }
  private normalizeCustomFilters(): void {
    const area = this.plugin.settings.areas.find(candidate => candidate.key === this.areaKey);
    const tab = area?.tabs.find(candidate => candidate.key === this.activeTab);
    const allowed = this.plugin.settings.advancedAreaFeatures
      ? new Map((tab?.fields ?? []).filter(field => field.type === "dropdown" && field.options?.length).map(field => [field.key, new Set(field.options)]))
      : new Map<string, Set<string>>();
    const custom = Object.fromEntries(Object.entries(this.filters.custom ?? {}).filter(([key, value]) => allowed.get(key)?.has(value)));
    this.filters = { ...this.filters, custom: Object.keys(custom).length ? custom : undefined };
  }

  private getGroupByStatus(): boolean {
    if (this.groupByStatus === null) {
      const saved = this.app.loadLocalStorage(`mos-group-by-status-area-${this.areaKey}`);
      this.groupByStatus = typeof saved === "boolean" ? saved : true;
    }
    return this.groupByStatus;
  }

  private setGroupByStatus(next: boolean): void {
    this.groupByStatus = next;
    this.app.saveLocalStorage(`mos-group-by-status-area-${this.areaKey}`, next);
  }

  private render() {
    const container = this.containerEl.children[1] as HTMLElement;
    disposeEditorsIn(container);
    container.empty();
    container.addClass("morning-os");
    this.floatingCleanup?.();
    this.floatingCleanup = mountFloatingPanel(container, this.plugin).cleanup;
    this.viewOptionsCleanup?.();
    this.viewOptionsCleanup = null;

    const area = this.plugin.settings.areas.find(p => p.key === this.areaKey);
    if (!area) return;

    const wrapper = container.createDiv({ cls: "morning-os-scroll" });
    this.scrollEl = wrapper;
    const inner = wrapper.createDiv({ cls: "morning-os-wrapper" });

    const titleRow = inner.createDiv({ cls: "mos-view-title-row" });
    titleRow.createEl("h1", { cls: "mos-area-title", text: `${area.icon} ${area.label}` });

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
    const advancedAreaFeatures = this.plugin.settings.advancedAreaFeatures;
    this.normalizeCustomFilters();
    const activeFields = advancedAreaFeatures ? activeTabConfig?.fields : undefined;
    const results = inner.createDiv({ cls: "mos-filter-results" });
    this.resultsEl = results;
    this.viewOptionsCleanup = renderViewToolbar(sortFilterRow, {
      filters: this.filters,
      getCurrentFilters: () => this.filters,
      onFiltersChange: (filters) => {
        this.filters = filters;
        this.renderResults(results, area, activeTabConfig, activeFields, advancedAreaFeatures);
      },
      sortField: this.sortField,
      sortDir: this.sortDir,
      onSortChange: (field) => {
        this.sortField = field;
        this.renderResults(results, area, activeTabConfig, activeFields, advancedAreaFeatures);
      },
      onSortDirectionChange: (direction) => {
        this.sortDir = direction;
        this.renderResults(results, area, activeTabConfig, activeFields, advancedAreaFeatures);
      },
      showGrouping: true,
      groupByStatus: this.getGroupByStatus(),
      onGroupByStatusChange: (groupByStatus) => {
        this.setGroupByStatus(groupByStatus);
        this.renderResults(results, area, activeTabConfig, activeFields, advancedAreaFeatures);
      },
      showUrgency: false,
      tabFields: activeFields,
    });
    this.renderResults(results, area, activeTabConfig, activeFields, advancedAreaFeatures);
  }

  private renderResults(
    parent: HTMLElement,
    area: AreaConfig,
    activeTabConfig: TabConfig | null,
    activeFields: FieldDef[] | undefined,
    advancedAreaFeatures: boolean,
  ) {
    disposeEditorsIn(parent);
    parent.empty();
    // View mode: table vs cards
    if (advancedAreaFeatures && activeTabConfig?.view_mode === "table") {
      this.renderTableView(parent, activeTabConfig, area);
    } else {
      let tasks = this.registry.filter(t =>
        !t.is_deleted &&
        t.parent_id === null &&
        t.areas.includes(this.areaKey) &&
        (this.activeTab === null || t.tags[this.areaKey] === this.activeTab)
      );
      tasks = applyFilters(tasks, this.filters, this.registry);
      tasks = sortItemsByStatus(tasks, this.registry, this.sortField, this.sortDir, this.getGroupByStatus(), true);

      const taskItems = tasks.filter(item => item.kind !== "note");
      const noteItems = tasks.filter(item => item.kind === "note");
      this.renderItemPanelSwitcher(parent);

      if (this.collapsedItemPanel) {
        const hiddenPanel = this.collapsedItemPanel;
        const hiddenCount = hiddenPanel === "tasks" ? taskItems.length : noteItems.length;
        const restore = parent.createDiv({ cls: "mos-area-panel-restore" });
        const restoreButton = restore.createEl("button", {
          cls: "mos-btn mos-area-panel-restore-button",
          text: `Show ${hiddenPanel === "tasks" ? "Tasks" : "Notes"} (${hiddenCount})`,
        });
        restoreButton.addEventListener("click", () => {
          this.collapsedItemPanel = null;
          this.render();
        });
      }

      const panels = parent.createDiv({ cls: "mos-area-item-panels" });
      panels.toggleClass("is-tasks-minimized", this.collapsedItemPanel === "tasks");
      panels.toggleClass("is-notes-minimized", this.collapsedItemPanel === "notes");
      this.renderItemPanel(panels, "tasks", "Tasks", taskItems, area, activeFields ?? []);
      this.renderItemPanel(panels, "notes", "Notes", noteItems, area, activeFields ?? []);
    }
  }

  private renderItemPanelSwitcher(parent: HTMLElement) {
    const switcher = parent.createDiv({ cls: "mos-mobile-item-switch", attr: { "aria-label": "Choose item type" } });
    for (const panel of ["tasks", "notes"] as const) {
      const label = panel === "tasks" ? "Tasks" : "Notes";
      const button = switcher.createEl("button", {
        cls: "mos-btn mos-btn-tab" + (this.activeItemPanel === panel ? " is-active" : ""),
        text: label,
        attr: { "aria-pressed": String(this.activeItemPanel === panel) },
      });
      button.addEventListener("click", () => {
        this.activeItemPanel = panel;
        if (this.collapsedItemPanel === panel) this.collapsedItemPanel = null;
        this.render();
      });
    }
  }

  private renderItemPanel(
    parent: HTMLElement,
    panel: "tasks" | "notes",
    label: string,
    items: Task[],
    area: AreaConfig,
    fields: FieldDef[]
  ) {
    const isCollapsed = this.collapsedItemPanel === panel;
    const section = parent.createDiv({ cls: `mos-area-item-panel mos-area-item-panel-${panel}` });
    section.toggleClass("is-collapsed", isCollapsed);
    section.toggleClass("is-mobile-hidden", this.activeItemPanel !== panel);

    const header = section.createDiv({ cls: "mos-area-item-panel-header" });
    header.createEl("h2", { cls: "mos-area-item-panel-title", text: label });
    const collapseButton = header.createEl("button", {
      cls: "mos-btn mos-btn-icon mos-area-panel-minimize",
      text: isCollapsed ? "↗" : "−",
      attr: { title: isCollapsed ? `Restore ${label} panel` : `Minimize ${label} panel` },
    });
    collapseButton.addEventListener("click", () => {
      this.collapsedItemPanel = isCollapsed ? null : panel;
      this.render();
    });

    const body = section.createDiv({ cls: "mos-area-item-panel-body" });
    if (items.length === 0) {
      body.createEl("p", { cls: "morning-os-empty-state mos-area-item-empty", text: `No ${label.toLowerCase()} here yet.` });
    } else {
      const card = body.createDiv({ cls: "morning-os-card mos-area-item-card" });
      for (const item of items) {
        renderTaskRowShared(
          card, item, this.app, this, () => void this.refresh(), this.plugin, false, fields, this.registry, false,
          getChildOnlySearchMatches(item, this.filters, this.registry),
          children => sortItemsByStatus(children, this.registry, this.sortField, this.sortDir, this.getGroupByStatus()),
        );
      }
    }

    const itemLabel = panel === "tasks" ? "task" : "note";
    renderAddTaskInput(body, this.app, `Capture a ${itemLabel}…`, async (text) => {
      const activeTab = this.activeTab;
      const tags = activeTab ? { [area.key]: activeTab } : {};
      const item = panel === "tasks"
        ? createTask(text, { areas: [area.key], tags })
        : createNote(text, { areas: [area.key], tags });
      const registry = await loadRegistry(this.app);
      await saveRegistry(this.app, [...registry, item]);
      await this.refresh();
    });
  }

  private renderTableView(parent: HTMLElement, tabConfig: TabConfig, area: AreaConfig) {
    const fields = tabConfig.fields;
    const allItems = this.registry.filter(t =>
      !t.is_deleted && t.parent_id === null && t.areas.includes(this.areaKey) &&
      t.tags[this.areaKey] === tabConfig.key
    );
    const items = sortItemsByStatus(
      applyFilters(allItems, this.filters, this.registry), this.registry,
      this.sortField, this.sortDir, this.getGroupByStatus(), true,
    );

    const table = parent.createEl("table", { cls: "mos-table" });
    const thead = table.createEl("thead");
    const headRow = thead.createEl("tr");
    headRow.createEl("th", { cls: "mos-table-th mos-table-check", text: "Kind" });
    headRow.createEl("th", { cls: "mos-table-th", text: "Name" });
    for (const f of fields) headRow.createEl("th", { cls: "mos-table-th", text: f.label });
    headRow.createEl("th", { cls: "mos-table-th mos-table-actions", text: "" });

    const tbody = table.createEl("tbody");
    for (const task of items) {
      const isArchivedNote = task.kind === "note" && task.status_note === "archived";
      const tr = tbody.createEl("tr", { cls: "mos-table-row" + (task.kind === "task" && task.status_completion === "done" ? " mos-table-row-done" : "") + (isArchivedNote ? " mos-note-archived" : "") });

      // Checkbox cell
      const checkTd = tr.createEl("td", { cls: "mos-table-td mos-table-check" });
      if (task.kind === "note") {
        checkTd.createSpan({ cls: "mos-note-kind-icon", attr: { "aria-label": "Note", title: "Note" }, text: "📝" });
        if (isArchivedNote) checkTd.createSpan({ cls: "mos-note-status", text: "Archived" });
      } else {
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
      }

      // Name cell (editable on click)
      const nameTd = tr.createEl("td", { cls: "mos-table-td mos-table-name" });
      const nameSpan = renderMdContent(this.app, this, nameTd, "span", "", task.text);
      if (task.notes?.trim() && this.plugin.settings.showNotesIndicator) {
        nameTd.createSpan({ cls: "mos-notes-badge", attr: { title: "Has notes" }, text: "📝" });
      }
      attachInlineTextEdit(this.app, nameSpan, task, () => void this.refresh(), this);

      // Field cells
      for (const f of fields) {
        const td = tr.createEl("td", { cls: "mos-table-td" });
        const val = metadataText(task.tags[f.key]);
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
            label: task.kind === "note" ? (isArchivedNote ? "Unarchive" : "Archive") : "",
            action: () => {
              if (task.kind === "note") void setNoteStatus(this.app, task._id, isArchivedNote ? "active" : "archived").then(() => this.refresh());
            },
          },
          {
            label: task.kind === "note" ? "Convert to task" : "Convert to note",
            action: () => void changeItemKind(this.app, task._id, task.kind === "note" ? "task" : "note").then(() => this.refresh()),
          },
          {
            label: "✎ Edit metadata",
            action: () => {
              new TaskEditModal(this.app, task, () => {
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
        ].filter(item => item.label));
      });

      const childOnlyMatches = getChildOnlySearchMatches(task, this.filters, this.registry);
      if (childOnlyMatches) {
        for (const child of childOnlyMatches) {
          const matchRow = tbody.createEl("tr", { cls: "mos-table-row mos-table-context-child" });
          const matchCell = matchRow.createEl("td", {
            cls: "mos-table-td mos-table-context-child-cell",
            attr: { colspan: String(fields.length + 3) },
          });
          matchCell.createSpan({ cls: "mos-table-context-child-label", text: "Matching child" });
          renderTaskRowShared(matchCell, child, this.app, this, () => void this.refresh(), this.plugin, false, fields, this.registry, true);
        }
      }
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
    const groupBtn = wrap.createEl("button", {
      cls: "mos-btn mos-group-status-toggle",
      text: `Group by status: ${this.getGroupByStatus() ? "On" : "Off"}`,
      attr: {
        "aria-label": "Group items by active status",
        "aria-pressed": String(this.getGroupByStatus()),
      },
    });
    groupBtn.addEventListener("click", () => this.setGroupByStatus(!this.getGroupByStatus()));
  }
}

export class DumpView extends ItemView {
  private settings: MorningOSSettings;
  private plugin: MorningOSPlugin;
  private registry: TaskRegistry = [];
  private sortField: SortField = "date_created";
  private sortDir: SortDir = "desc";
  private floatingCleanup: (() => void) | null = null;
  private viewOptionsCleanup: (() => void) | null = null;
  private filters: FilterState = {};
  private groupByStatus: boolean | null = null;
  private resultsEl: HTMLElement | null = null;
  private scrollEl: HTMLElement | null = null;
  private refreshQueued: "results" | "layout" | null = null;
  private refreshSettledUnsubscribe: (() => void) | null = null;
  private closed = false;
  private lifecycle = 0;

  constructor(leaf: WorkspaceLeaf, settings: MorningOSSettings, plugin: MorningOSPlugin, private readonly allItems = false) {
    super(leaf);
    this.settings = settings;
    this.plugin = plugin;
  }

  getViewType(): string { return this.allItems ? VIEW_TYPE_ALL_ITEMS : VIEW_TYPE_DUMP; }
  getDisplayText(): string { return this.allItems ? "All Items" : "Inbox"; }
  getIcon(): string { return "inbox"; }

  async onOpen() {
    this.closed = false;
    const lifecycle = ++this.lifecycle;
    const registry = await loadRegistry(this.app);
    if (!this.isCurrent(lifecycle)) return;
    this.registry = registry;
    this.render();
  }
  async refresh(layout = false) {
    if (this.closed) return;
    const lifecycle = this.lifecycle;
    const registry = await loadRegistry(this.app);
    if (!this.isCurrent(lifecycle)) return;
    this.registry = registry;
    if (hasActiveEditingSession()) { this.deferRefresh(layout); return; }
    if (!this.resultsEl || !this.scrollEl) { this.render(); return; }
    const scrollTop = this.scrollEl.scrollTop;
    if (layout) { this.render(); if (this.isCurrent(lifecycle)) this.restoreScroll(scrollTop); return; }
    this.renderResults(this.resultsEl);
    if (this.isCurrent(lifecycle)) this.restoreScroll(scrollTop);
  }
  async onClose() {
    if (this.closed) return;
    this.closed = true;
    ++this.lifecycle;
    this.refreshQueued = null;
    this.refreshSettledUnsubscribe?.();
    this.refreshSettledUnsubscribe = null;
    disposeEditorsIn(this.containerEl);
    this.floatingCleanup?.();
    this.floatingCleanup = null;
    this.viewOptionsCleanup?.();
    this.viewOptionsCleanup = null;
  }

  private isCurrent(lifecycle: number): boolean { return !this.closed && this.lifecycle === lifecycle; }
  private restoreScroll(scrollTop: number): void {
    if (!this.scrollEl) return;
    this.scrollEl.scrollTop = Math.min(scrollTop, Math.max(0, this.scrollEl.scrollHeight - this.scrollEl.clientHeight));
  }
  private deferRefresh(layout: boolean): void {
    if (layout || this.refreshQueued === null) this.refreshQueued = layout ? "layout" : "results";
    if (this.refreshSettledUnsubscribe) return;
    const lifecycle = this.lifecycle;
    this.refreshSettledUnsubscribe = onEditingSessionsSettled(() => {
      this.refreshSettledUnsubscribe?.(); this.refreshSettledUnsubscribe = null;
      const queued = this.refreshQueued; this.refreshQueued = null;
      if (queued && this.isCurrent(lifecycle)) void this.refresh(queued === "layout");
    });
  }

  private getGroupByStatus(): boolean {
    if (this.groupByStatus === null) {
      const saved = this.app.loadLocalStorage("mos-group-by-status-all-items");
      this.groupByStatus = typeof saved === "boolean" ? saved : true;
    }
    return this.groupByStatus;
  }

  private setGroupByStatus(next: boolean): void {
    this.groupByStatus = next;
    this.app.saveLocalStorage("mos-group-by-status-all-items", next);
  }

  private render() {
    const container = this.containerEl.children[1] as HTMLElement;
    disposeEditorsIn(container);
    container.empty();
    container.addClass("morning-os");
    this.floatingCleanup?.();
    this.floatingCleanup = mountFloatingPanel(container, this.plugin).cleanup;
    this.viewOptionsCleanup?.();
    this.viewOptionsCleanup = null;

    const wrapper = container.createDiv({ cls: "morning-os-scroll" });
    this.scrollEl = wrapper;
    const inner = wrapper.createDiv({ cls: "morning-os-wrapper" });

    const titleRow = inner.createDiv({ cls: "mos-view-title-row" });
    titleRow.createEl("h1", { cls: "morning-os-section-heading", text: this.allItems ? "All Items" : "Inbox" });

    renderAddTaskInput(inner, this.app, "Capture a task…", async (text) => {
      const task = createTask(text);
      const reg = await loadRegistry(this.app);
      reg.push(task);
      await saveRegistry(this.app, reg);
      await this.refresh();
    });

    const results = inner.createDiv({ cls: "mos-filter-results" });
    this.resultsEl = results;
    this.viewOptionsCleanup = renderViewToolbar(titleRow, {
      filters: this.filters,
      getCurrentFilters: () => this.filters,
      onFiltersChange: (filters) => {
        this.filters = filters;
        this.renderResults(results);
      },
      sortField: this.sortField,
      sortDir: this.sortDir,
      onSortChange: (field) => {
        this.sortField = field;
        this.renderResults(results);
      },
      onSortDirectionChange: (direction) => {
        this.sortDir = direction;
        this.renderResults(results);
      },
      showGrouping: this.allItems,
      groupByStatus: this.allItems ? this.getGroupByStatus() : undefined,
      onGroupByStatusChange: this.allItems ? (groupByStatus) => {
        this.setGroupByStatus(groupByStatus);
        this.renderResults(results);
      } : undefined,
      showUrgency: true,
    });
    this.renderResults(results);
  }

  private renderResults(parent: HTMLElement) {
    disposeEditorsIn(parent);
    parent.empty();
    let tasks = this.registry.filter(t =>
      !t.is_deleted && t.parent_id === null &&
      (this.allItems || (t.areas.length === 0 && (isItemActive(t) || hasOpenChildren(this.registry, t._id))))
    );
    tasks = applyFilters(tasks, this.filters, this.registry);
    tasks = this.allItems
      ? sortItemsByStatus(tasks, this.registry, this.sortField, this.sortDir, this.getGroupByStatus(), true)
      : sortTasks(tasks, this.sortField, this.sortDir);

    if (tasks.length === 0) {
      parent.createEl("p", { cls: "morning-os-empty-state", text: this.allItems ? "No items match these filters." : "All clear. Capture fast, organize later." });
    } else {
      const card = parent.createDiv({ cls: "morning-os-card" });
      for (const t of tasks) {
        renderTaskRowShared(
          card, t, this.app, this, () => void this.refresh(), this.plugin, true, undefined, this.registry, false,
          getChildOnlySearchMatches(t, this.filters, this.registry),
          children => this.allItems
            ? sortItemsByStatus(children, this.registry, this.sortField, this.sortDir, this.getGroupByStatus())
            : sortTasks(children, this.sortField, this.sortDir),
        );
      }
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
    if (this.allItems) {
      const groupBtn = wrap.createEl("button", {
        cls: "mos-btn mos-group-status-toggle",
        text: `Group by status: ${this.getGroupByStatus() ? "On" : "Off"}`,
        attr: {
          "aria-label": "Group items by active status",
          "aria-pressed": String(this.getGroupByStatus()),
        },
      });
      groupBtn.addEventListener("click", () => this.setGroupByStatus(!this.getGroupByStatus()));
    }
  }
}

import { Modal as ObsidianModal } from "obsidian";

export class TaskEditModal extends ObsidianModal {
  private task: Task;
  private base: Task;
  private onSaved: () => void;
  private endEditing: (() => void) | null = null;
  private showUrgency: boolean;
  private areaConfigs: AreaConfig[];
  private showAdvancedAreaFeatures: boolean;
  private closed = false;
  private saving = false;

  constructor(
    app: App,
    task: Task,
    onSaved: () => void,
    showUrgency = false,
    areaConfigs: AreaConfig[] = [],
    showAdvancedAreaFeatures = false
  ) {
    super(app);
    this.base = cloneItemDraft(task);
    this.task = cloneItemDraft(task);
    this.onSaved = onSaved;
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
    this.closed = false;
    this.endEditing ??= beginEditingSession();
    const { contentEl } = this;
    contentEl.addClass("mos-edit-modal");
    contentEl.createEl("h2", { cls: "mos-edit-title", text: this.task.kind === "note" ? "Edit note" : "Edit task" });

    // Text
    const textWrap = this.field(contentEl, "Text");
    const textInput = textWrap.createEl("input", { type: "text", cls: "mos-edit-input" });
    textInput.value = this.task.text;
    textInput.addEventListener("input", () => { this.task.text = textInput.value.trim(); });
    attachTaskTextSuggest(this.app, textInput);

    // Status
    const statusWrap = this.field(contentEl, "Status");
    const statusGroup = statusWrap.createDiv({ cls: "mos-edit-btn-group" });
    const renderStatusButton = (label: string, active: boolean, setStatus: () => void) => {
      const btn = statusGroup.createEl("button", {
        cls: "mos-btn mos-btn-seg" + (active ? " is-active" : ""),
        text: label,
      });
      btn.addEventListener("click", () => {
        setStatus();
        statusGroup.querySelectorAll(".mos-btn").forEach(button => button.removeClass("is-active"));
        btn.addClass("is-active");
      });
    };
    if (this.task.kind === "note") {
      for (const status of ["active", "archived"] as const) {
        renderStatusButton(status, this.task.status_note === status, () => { this.task.status_note = status; });
      }
    } else {
      for (const status of ["open", "done", "dismissed"] as const) {
        renderStatusButton(status, this.task.status_completion === status, () => { this.task.status_completion = status; });
      }
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
        const currentVal = metadataText(this.task.tags[fieldDef.key]);
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

    // Details uses the new field while mirroring legacy notes for existing consumers.
    const detailsWrap = this.field(contentEl, "Details");
    const detailsInput = detailsWrap.createEl("textarea", { cls: "mos-edit-input mos-edit-textarea" });
    detailsInput.value = this.task.details ?? this.task.notes ?? "";
    detailsInput.addEventListener("input", () => {
      this.task.details = detailsInput.value;
      this.task.notes = detailsInput.value;
    });

    const footer = contentEl.createDiv({ cls: "mos-edit-footer" });
    const saveBtn = footer.createEl("button", { cls: "mos-btn mos-btn-primary", text: "Save" });
    const cancelBtn = footer.createEl("button", { cls: "mos-btn", text: "Cancel" });
    saveBtn.addEventListener("click", () => { void this.saveDraft(); });
    cancelBtn.addEventListener("click", () => this.close());
  }

  private async saveDraft(forceFields: readonly DraftConflictChoice[] = []): Promise<void> {
    if (this.saving || this.closed) return;
    this.saving = true;
    try {
      const result = await saveItemDraft(this.app, this.base, this.task, forceFields);
      if (this.closed) return;
      if (result.status === "saved") {
        this.close();
        this.onSaved();
        return;
      }
      if (result.status === "deleted") {
        this.showDeletedDraft();
        return;
      }
      this.showConflicts(result.conflicts);
    } catch (error) {
      if (this.closed) return;
      new Notice(`Morning OS: draft was not saved — ${(error as Error).message}`);
    } finally {
      if (!this.closed) this.saving = false;
    }
  }

  private showDeletedDraft(): void {
    if (this.closed) return;
    this.contentEl.querySelector(".mos-edit-conflict")?.remove();
    const panel = this.contentEl.createDiv({ cls: "mos-edit-conflict" });
    panel.createEl("p", { text: "This item was deleted elsewhere. It was not restored. Copy your draft below for recovery." });
    panel.createEl("label", { cls: "mos-edit-label", text: "Complete editable draft" });
    const copy = panel.createEl("textarea", { cls: "mos-edit-input mos-edit-textarea" });
    copy.value = JSON.stringify({
      title: this.task.text,
      details: this.task.details ?? this.task.notes ?? "",
      kind: this.task.kind,
      taskStatus: this.task.status_completion,
      noteStatus: this.task.status_note,
      placement: { areas: this.task.areas, parentId: this.task.parent_id },
      customFields: this.task.tags,
      reminder: this.task.date_remind,
      today: this.task.is_today,
      todayPriority: this.task.status_priority,
      urgency: this.task.status_urgency,
    }, null, 2);
    copy.readOnly = true;
  }

  private showConflicts(conflicts: import("./data/draft-reconciliation").DraftConflict[]): void {
    if (this.closed) return;
    this.contentEl.querySelector(".mos-edit-conflict")?.remove();
    const panel = this.contentEl.createDiv({ cls: "mos-edit-conflict" });
    panel.createEl("p", { text: "These fields changed elsewhere. Both versions are shown; choose explicitly before saving." });
    for (const conflict of conflicts) {
      panel.createEl("p", { text: String(conflict.field) });
      const external = panel.createEl("textarea", { cls: "mos-edit-input mos-edit-textarea" });
      external.value = JSON.stringify(conflict.external, null, 2); external.readOnly = true;
      const draft = panel.createEl("textarea", { cls: "mos-edit-input mos-edit-textarea" });
      draft.value = JSON.stringify(conflict.draft, null, 2); draft.readOnly = true;
    }
    panel.createEl("button", { cls: "mos-btn", text: "Use external values" }).addEventListener("click", () => {
      if (this.closed) return;
      for (const conflict of conflicts) {
        if (conflict.field === "tags" && typeof conflict.external === "object" && conflict.external !== null) {
          if (conflict.key) {
            const value = (conflict.external as Record<string, Task["tags"][string]>)[conflict.key];
            if (value === undefined) {
              delete this.task.tags[conflict.key];
              delete this.base.tags[conflict.key];
            } else {
              this.task.tags[conflict.key] = value;
              this.base.tags[conflict.key] = value;
            }
          }
          continue;
        }
        this.task[conflict.field] = cloneItemDraft({ ...this.task, [conflict.field]: conflict.external } as Task)[conflict.field];
        this.base[conflict.field] = cloneItemDraft({ ...this.base, [conflict.field]: conflict.external } as Task)[conflict.field];
      }
      panel.remove();
      this.contentEl.empty();
      this.onOpen();
    });
    panel.createEl("button", { cls: "mos-btn mos-btn-primary", text: "Use my draft" }).addEventListener("click", () => {
      if (this.closed) return;
      void this.saveDraft(conflicts.map(conflict => conflict.field === "tags" && conflict.key
        ? { field: "tags" as const, key: conflict.key }
        : conflict.field));
    });
  }

  onClose() {
    if (this.closed) return;
    this.closed = true;
    this.endEditing?.();
    this.endEditing = null;
    this.contentEl.empty();
  }
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
    const titleRow = inner.createDiv({ cls: "mos-view-title-row" });
    titleRow.createEl("h1", { cls: "morning-os-section-heading", text: "Trash" });

    const deletedRoots = this.registry.filter(task => {
      if (!task.is_deleted) return false;
      const parent = task.parent_id ? this.registry.find(candidate => candidate._id === task.parent_id) : null;
      return !parent || !parent.is_deleted;
    });
    this.renderTrashSection(inner, deletedRoots, "Deleted");
  }

  private renderTrashSection(parent: HTMLElement, tasks: Task[], label: string) {
    parent.createEl("h2", { cls: "morning-os-section-heading", text: `${label} (${tasks.length})` });
    if (tasks.length === 0) {
      parent.createEl("p", { cls: "morning-os-empty-state", text: `No ${label.toLowerCase()} tasks.` });
      return;
    }
    const card = parent.createDiv({ cls: "morning-os-card" });
    for (const task of tasks) {
      const row = card.createDiv({ cls: "morning-os-task-row" + (task.kind === "task" ? " morning-os-task-done" : " mos-note-deleted") });
      if (task.kind === "note") row.createSpan({ cls: "mos-note-kind-icon", attr: { "aria-label": "Note", title: "Note" }, text: "📝" });
      renderMdContent(this.app, this, row, "span", "morning-os-task-text", task.text);
      row.createSpan({ cls: "morning-os-reminder-badge", text: task.date_modified });
      const deletedChildren = this.registry.filter(child => child.parent_id === task._id && child.is_deleted);
      if (deletedChildren.length > 0) {
        row.createSpan({ cls: "mos-notes-badge", attr: { title: `${deletedChildren.length} deleted child item${deletedChildren.length === 1 ? "" : "s"}` }, text: `+${deletedChildren.length}` });
      }

      const restoreBtn = row.createEl("button", { cls: "mos-task-action-btn", text: "Restore" });
      restoreBtn.addEventListener("click", () => {
        void (async () => {
          await restoreTask(this.app, task._id);
          await this.plugin.refreshView();
          void this.refresh();
        })();
      });

      const permDeleteBtn = row.createEl("button", { cls: "mos-task-action-btn mos-task-action-delete", text: "Delete permanently" });
      permDeleteBtn.addEventListener("click", () => {
        void (async () => {
          const count = 1 + deletedChildren.length;
          if (!window.confirm(`Permanently delete ${count} item${count === 1 ? "" : "s"}? This cannot be undone, but existing snapshots remain available.`)) return;
          await purgeTask(this.app, task._id);
          await this.plugin.refreshView();
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
