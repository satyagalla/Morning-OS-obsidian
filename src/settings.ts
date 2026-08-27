import { App, PluginSettingTab, Setting } from "obsidian";
import type MorningOSPlugin from "./main";
import type { AreaConfig, FieldDef, LLMSectionMapping } from "./types";

type NumericSettingsKey = { [K in keyof MorningOSSettings]: MorningOSSettings[K] extends number ? K : never }[keyof MorningOSSettings];

export interface MorningOSSettings {
  // Plugin display paths
  briefsDir: string;
  dailyNoteDir: string;
  feedbackDir: string;
  sectionWins: string;

  // Agent source file paths (vault-relative)
  sourceTacticalRules: string;
  sourceEmotionalRules: string;
  sourceGoals: string;
  sourceTechnicalTasks: string;
  sourceHobbyTasks: string;
  sourceIdentity: string;

  // Daily note section headings
  sectionRedAlert: string;
  sectionRegular: string;
  sectionThoughts: string;

  // Goals file section headings
  goalsShortTerm: string;
  goalsLongTerm: string;

  // Agent runner
  agentLastRunDate: string;

  // Field modes (true = llm, false = direct)
  modeTacticalRules: boolean;
  modeIdentityRules: boolean;
  modeGoals: boolean;
  modeHobbyTasks: boolean;
  modeSuggestion: boolean;
  modeWins: boolean;

  // Intelligence LLM
  aiEnabled: boolean;
  intelligenceProvider: string;
  intelligenceModel: string;
  intelligenceRegion: string;

  // Credentials
  awsAccessKeyId: string;
  awsSecretAccessKey: string;
  awsRegion: string;
  openaiApiKey: string;
  geminiApiKey: string;
  groqApiKey: string;

  // Field counts
  tacticalRulesCount: number;
  identityRulesCount: number;
  goalsShortTermCount: number;
  goalsLongTermCount: number;
  hobbyTasksCount: number;
  suggestionCount: number;

  // Home dashboard visibility
  showIdentity: boolean;
  showGoals: boolean;
  showRulesForToday: boolean;

  // Carry detection
  carryLookbackDays: number;

  // Dirty flag — true when settings changed since last agent run
  settingsChangedSinceRun: boolean;

  // Wins log
  sourceWins: string;

  // LLM section mappings (area markdown sections → LLM context slots)
  llmSectionMappings: LLMSectionMapping[];

  // Migration
  migrationComplete: boolean;

  // Onboarding
  onboarded: boolean;

  lastSeenVersion: string;
  areas: AreaConfig[];

  // Advanced area functionality
  advancedAreaFeatures: boolean;

  // Subtasks
  requireSubtasksComplete: boolean;

  // Notes
  showNotesIndicator: boolean;
}

export const PROVIDER_DEFAULT_MODELS: Record<string, string> = {
  bedrock: "us.anthropic.claude-sonnet-4-6",
  openai: "gpt-4o",
  gemini: "gemini-2.0-flash",
  groq: "llama-3.3-70b-versatile",
};

export const DEFAULT_SETTINGS: MorningOSSettings = {
  briefsDir: "_generated/briefs",
  dailyNoteDir: "Essential/Daily",
  feedbackDir: "_generated/feedback",
  sectionWins: "Wins",

  sourceTacticalRules: "Essential/State of Mind/Tactical Rules.md",
  sourceEmotionalRules: "Essential/State of Mind/Emotional Rules.md",
  sourceGoals: "Essential/State of Mind/Long-term and Short-term.md",
  sourceTechnicalTasks: "Essential/Pending Tasks/Technical Tasks.md",
  sourceHobbyTasks: "Essential/Pending Tasks/Hobby Tasks.md",
  sourceIdentity: "Essential/Identity-Anchor.md",

  sectionRedAlert: "Red alert",
  sectionRegular: "Regular",
  sectionThoughts: "Thoughts",

  goalsShortTerm: "Short Term",
  goalsLongTerm: "Long Term",

  modeTacticalRules: true,
  modeIdentityRules: false,
  modeGoals: true,
  modeHobbyTasks: true,
  modeSuggestion: true,
  modeWins: false,

  aiEnabled: true,
  intelligenceProvider: "openai",
  intelligenceModel: "gpt-4o",
  intelligenceRegion: "us-east-2",

  awsAccessKeyId: "",
  awsSecretAccessKey: "",
  awsRegion: "us-east-2",
  openaiApiKey: "",
  geminiApiKey: "",
  groqApiKey: "",

  agentLastRunDate: "",

  tacticalRulesCount: 4,
  identityRulesCount: 3,
  goalsShortTermCount: 2,
  goalsLongTermCount: 1,
  hobbyTasksCount: 3,
  suggestionCount: 3,

  showIdentity: false,
  showGoals: true,
  showRulesForToday: true,

  carryLookbackDays: 7,

  settingsChangedSinceRun: false,

  sourceWins: "Essential/Wins.md",

  llmSectionMappings: [
    { heading: "Tactical Rules",  target: "tactical_rules",  enabled: true },
    { heading: "Emotional Rules", target: "emotional_rules", enabled: true },
    { heading: "Short Term",      target: "goals_short",     enabled: true },
    { heading: "Long Term",       target: "goals_long",      enabled: true },
  ],

  migrationComplete: false,

  onboarded: false,

  lastSeenVersion: "",

  areas: [
    { key: "health",       label: "Health",         icon: "❤️",  feedToLLM: true,  tabs: [
      { key: "physical",  label: "Physical",    fields: [], view_mode: "cards" },
      { key: "mental",    label: "Mental/ADHD", fields: [], view_mode: "cards" },
    ]},
    { key: "career",       label: "Career",         icon: "💼",  feedToLLM: true,  tabs: [
      { key: "applications", label: "Applications", fields: [], view_mode: "cards" },
      { key: "leads",        label: "Leads",        fields: [], view_mode: "cards" },
      { key: "followups",    label: "Follow-ups",   fields: [], view_mode: "cards" },
    ]},
    { key: "interests",    label: "Interests",      icon: "✨",  feedToLLM: true,  tabs: [] },
    { key: "family",       label: "Family",         icon: "👨‍👩‍👧", feedToLLM: false, tabs: [] },
    { key: "relationship", label: "Relationships",  icon: "💞",  feedToLLM: false, tabs: [] },
  ],

  advancedAreaFeatures: false,

  requireSubtasksComplete: false,

  showNotesIndicator: true,
};

const PROVIDERS = {
  bedrock: "AWS Bedrock",
  openai: "OpenAI",
  gemini: "Google Gemini",
  groq: "Groq",
};

export class MorningOSSettingTab extends PluginSettingTab {
  plugin: MorningOSPlugin;
  private dirtySections = new Set<string>();

  constructor(app: App, plugin: MorningOSPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  private async save(update: Partial<MorningOSSettings>, section?: string) {
    Object.assign(this.plugin.settings, update);
    this.plugin.settings.settingsChangedSinceRun = true;
    await this.plugin.saveData(this.plugin.settings);
    if (section) {
      this.dirtySections.add(section);
      this.markSectionDirty(section);
      this.showRunBanner();
    }
  }

  clearDirty() {
    this.dirtySections.clear();
    this.containerEl.querySelectorAll(".setting-item-heading[data-dirty]").forEach((el) => {
      (el as HTMLElement).removeAttribute("data-dirty");
    });
    this.hideRunBanner();
  }

  private markSectionDirty(section: string) {
    this.containerEl.querySelectorAll(".setting-item-heading").forEach((el) => {
      const nameEl = el.querySelector(".setting-item-name");
      if (nameEl?.textContent === section) (el as HTMLElement).setAttribute("data-dirty", "true");
    });
  }

  private showRunBanner() {
    const existing = this.containerEl.querySelector(".mos-run-banner");
    if (!existing) {
      const banner = this.containerEl.querySelector(".mos-run-banner-slot");
      if (banner) banner.setAttribute("data-visible", "true");
    }
  }

  private hideRunBanner() {
    const banner = this.containerEl.querySelector(".mos-run-banner-slot");
    if (banner) banner.removeAttribute("data-visible");
  }

  private sectionHeading(containerEl: HTMLElement, text: string) {
    const s = new Setting(containerEl).setName(text).setHeading();
    if (this.dirtySections.has(text)) s.settingEl.setAttribute("data-dirty", "true");
  }

  private activeSettingsTab = "general";

  private renderTabBar(containerEl: HTMLElement) {
    const tabs = [
      { key: "general", label: "General" },
      { key: "advanced", label: "Advanced" },
    ];
    const bar = containerEl.createDiv({ cls: "mos-settings-tab-bar" });
    for (const tab of tabs) {
      const btn = bar.createEl("button", {
        cls: "mos-settings-tab" + (this.activeSettingsTab === tab.key ? " is-active" : ""),
        text: tab.label,
      });
      btn.addEventListener("click", () => {
        this.activeSettingsTab = tab.key;
        this.display();
      });
    }
  }

  private rerender(): void {
    this.display();
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    this.renderTabBar(containerEl);

    const content = containerEl.createDiv({ cls: "mos-settings-content" });
    switch (this.activeSettingsTab) {
      case "general":
        this.renderAISection(content);
        this.renderHomeSection(content);
        this.renderTaskBehaviorSection(content);
        this.renderAreasSection(content);
        break;
      case "advanced":
        this.renderAdvancedAreaFeaturesSection(content);
        this.renderAgentSection(content);
        this.renderAdvancedAISection(content);
        this.renderPathsSection(content);
        this.renderWinsSettingsSection(content);
        this.renderCountsSection(content);
        this.renderModesSection(content);
        this.renderAreaBriefingSourcesSection(content);
        break;
    }
  }

  private renderAgentSection(containerEl: HTMLElement) {
    this.sectionHeading(containerEl, "Briefing agent");

    new Setting(containerEl)
      .setName("Carry lookback days")
      .setDesc("How many days to search back for the previous brief when detecting carried tasks.")
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = "1";
        text.inputEl.max = "30";
        text.inputEl.addClass("mos-number-input-sm");
        text
          .setValue(String(this.plugin.settings.carryLookbackDays))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            if (!isNaN(n) && n >= 1) await this.save({ carryLookbackDays: n }, "Briefing agent");
          });
      });

    // Banner slot — visible only when settingsChangedSinceRun
    const bannerSlot = containerEl.createDiv({ cls: "mos-run-banner-slot" });
    bannerSlot.createSpan({ text: "⚠ Settings changed — run the agent to apply them." });
    if (this.plugin.settings.settingsChangedSinceRun) {
      bannerSlot.setAttribute("data-visible", "true");
    }

    new Setting(containerEl)
      .setName("Run agent now")
      .setDesc("Manually trigger the briefing agent.")
      .addButton((btn) =>
        btn
          .setButtonText("Run")
          .onClick(async () => {
            btn.setButtonText("Running…");
            btn.setDisabled(true);
            try {
              await this.plugin.triggerAgent();
              btn.setButtonText("Done ✓");
              this.clearDirty();
            } catch {
              btn.setButtonText("Failed ✗");
            } finally {
              window.setTimeout(() => { btn.setButtonText("Run"); btn.setDisabled(false); }, 3000);
            }
          })
      );

    new Setting(containerEl)
      .setName("Refresh brief")
      .setDesc("Rebuild the brief from current vault files without calling the AI.")
      .addButton((btn) =>
        btn
          .setButtonText("Refresh")
          .onClick(async () => {
            btn.setButtonText("Refreshing…");
            btn.setDisabled(true);
            try {
              await this.plugin.triggerRefresh();
              btn.setButtonText("Done ✓");
            } catch {
              btn.setButtonText("Failed ✗");
            } finally {
              window.setTimeout(() => { btn.setButtonText("Refresh"); btn.setDisabled(false); }, 3000);
            }
          })
      );
  }

  private renderAISection(containerEl: HTMLElement) {
    this.sectionHeading(containerEl, "AI provider");

    new Setting(containerEl)
      .setName("Use AI for briefings")
      .setDesc("Turn off to build briefings directly from your vault without contacting an AI provider.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.aiEnabled)
          .onChange(async (value) => {
            await this.save({ aiEnabled: value }, "AI provider");
            this.rerender();
          })
      );

    if (!this.plugin.settings.aiEnabled) return;

    new Setting(containerEl)
      .setName("Provider")
      .setDesc("Which AI service generates your daily brief.")
      .addDropdown((dd) =>
        dd
          .addOptions(PROVIDERS)
          .setValue(this.plugin.settings.intelligenceProvider)
          .onChange(async (value) => {
            await this.save({
              intelligenceProvider: value,
              intelligenceModel: PROVIDER_DEFAULT_MODELS[value] ?? "",
              intelligenceRegion: value === "bedrock" ? (this.plugin.settings.awsRegion || "us-east-2") : "",
            }, "AI provider");
            this.rerender();
          })
      );

    const p = this.plugin.settings.intelligenceProvider;

    if (p === "bedrock") {
      new Setting(containerEl)
        .setName("AWS Access Key ID")
        .addText((text) =>
          text
            .setValue(this.plugin.settings.awsAccessKeyId)
            .onChange(async (value) => { await this.save({ awsAccessKeyId: value }, "AI provider"); })
        );
      new Setting(containerEl)
        .setName("AWS Secret Access Key")
        .addText((text) => {
          text.inputEl.type = "password";
          text
            .setValue(this.plugin.settings.awsSecretAccessKey)
            .onChange(async (value) => { await this.save({ awsSecretAccessKey: value }, "AI provider"); });
        });
      new Setting(containerEl)
        .setName("AWS Region")
        .setDesc("e.g. us-east-2")
        .addText((text) =>
          text
            .setValue(this.plugin.settings.awsRegion)
            .onChange(async (value) => { await this.save({ awsRegion: value, intelligenceRegion: value }, "AI provider"); })
        );
    }

    if (p === "openai") {
      new Setting(containerEl)
        .setName("OpenAI API Key")
        .addText((text) => {
          text.inputEl.type = "password";
          text
            .setValue(this.plugin.settings.openaiApiKey)
            .onChange(async (value) => { await this.save({ openaiApiKey: value }, "AI provider"); });
        });
    }

    if (p === "gemini") {
      new Setting(containerEl)
        .setName("Gemini API Key")
        .addText((text) => {
          text.inputEl.type = "password";
          text
            .setValue(this.plugin.settings.geminiApiKey)
            .onChange(async (value) => { await this.save({ geminiApiKey: value }, "AI provider"); });
        });
    }

    if (p === "groq") {
      new Setting(containerEl)
        .setName("Groq API Key")
        .addText((text) => {
          text.inputEl.type = "password";
          text
            .setValue(this.plugin.settings.groqApiKey)
            .onChange(async (value) => { await this.save({ groqApiKey: value }, "AI provider"); });
        });
    }

  }

  private renderAdvancedAISection(containerEl: HTMLElement) {
    this.sectionHeading(containerEl, "AI model");

    new Setting(containerEl)
      .setName("Model")
      .setDesc("Provider model ID. Change this only when you need a model other than the default.")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.intelligenceModel)
          .onChange(async (value) => { await this.save({ intelligenceModel: value }, "AI model"); })
      );
  }

  private renderPathsSection(containerEl: HTMLElement) {
    const migrationDone = this.plugin.settings.migrationComplete;
    if (!migrationDone) {
      this.sectionHeading(containerEl, "Vault migration");
      new Setting(containerEl)
        .setName("Migrate vault to areas")
        .setDesc("Move rules, goals, and tasks from an earlier Morning OS vault into Areas. Old files are archived to _archive/pre-migration/.")
        .addButton(btn =>
        btn.setButtonText("Migrate").setCta().onClick(async () => {
          btn.setButtonText("Migrating…");
          btn.setDisabled(true);
          try {
            await this.plugin.migrateVault();
            this.rerender();
          } catch {
            btn.setButtonText("Failed ✗");
            btn.setDisabled(false);
          }
        })
      );
    }

    this.sectionHeading(containerEl, "Vault paths");
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "All paths are relative to your vault root. Change these only if your vault structure differs from the defaults.",
    });

    new Setting(containerEl)
      .setName("Briefs output folder")
      .setDesc("Where the agent writes daily brief JSON files.")
      .addText((text) =>
        text
          .setPlaceholder("_generated/briefs")
          .setValue(this.plugin.settings.briefsDir)
          .onChange(async (value) => { await this.save({ briefsDir: value }, "Vault paths"); })
      );

    new Setting(containerEl)
      .setName("Feedback folder")
      .setDesc("Where the agent writes feedback and reaction files.")
      .addText((text) =>
        text
          .setPlaceholder("_generated/feedback")
          .setValue(this.plugin.settings.feedbackDir)
          .onChange(async (value) => { await this.save({ feedbackDir: value }, "Vault paths"); })
      );

    new Setting(containerEl)
      .setName("Identity Anchor file")
      .setDesc("5 static lines rendered at the top of the Home view.")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.sourceIdentity)
          .onChange(async (value) => { await this.save({ sourceIdentity: value }, "Vault paths"); })
      );

    new Setting(containerEl)
      .setName("Wins log file")
      .setDesc("Chronological wins log. Plugin appends here when you add a win from the Home view.")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.sourceWins)
          .onChange(async (value) => { await this.save({ sourceWins: value }, "Vault paths"); })
      );
  }

  private renderWinsSettingsSection(containerEl: HTMLElement) {
    this.sectionHeading(containerEl, "Wins log");
    new Setting(containerEl)
      .setName("Wins heading")
      .setDesc("Markdown heading used for entries in the Wins log.")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.sectionWins)
          .onChange(async (value) => { await this.save({ sectionWins: value }, "Wins log"); })
      );
  }

  private renderCountsSection(containerEl: HTMLElement) {
    this.sectionHeading(containerEl, "How many items to show");

    const count = (name: string, key: NumericSettingsKey) => {
      new Setting(containerEl)
        .setName(name)
        .addText((text) => {
          text.inputEl.type = "number";
          text.inputEl.min = "0";
          text.inputEl.addClass("mos-number-input-sm");
          text
            .setValue(String(this.plugin.settings[key]))
            .onChange(async (value) => {
              const n = parseInt(value, 10);
              if (!isNaN(n) && n >= 0) await this.save({ [key]: n }, "How many items to show");
            });
        });
    };

    count("Tactical rules", "tacticalRulesCount");
    count("Identity rules", "identityRulesCount");
    count("Short-term goals (shown in bar)", "goalsShortTermCount");
    count("Long-term goals (shown in bar)", "goalsLongTermCount");
    count("Hobby tasks", "hobbyTasksCount");
    count("Suggestions", "suggestionCount");
  }

  private renderHomeSection(containerEl: HTMLElement) {
    this.sectionHeading(containerEl, "Home dashboard");

    const toggle = (name: string, desc: string, key: "showIdentity" | "showGoals" | "showRulesForToday") => {
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addToggle((t) =>
          t
            .setValue(this.plugin.settings[key])
            .onChange(async (value) => {
              this.plugin.settings[key] = value;
              await this.plugin.saveData(this.plugin.settings);
              await this.plugin.refreshView();
            })
        );
    };

    toggle("Show identity", "Show your Identity Anchor at the top of Home.", "showIdentity");
    toggle("Show goals", "Show short- and long-term goals near the top of Home.", "showGoals");
    toggle("Show rules for today", "Show the briefing agent's task-relevant rules beside today's tasks.", "showRulesForToday");
  }

  private renderTaskBehaviorSection(containerEl: HTMLElement) {
    this.sectionHeading(containerEl, "Task behavior");

    new Setting(containerEl)
      .setName("Require subtasks complete before parent")
      .setDesc("When on, a task with open subtasks cannot be completed until every subtask is done.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.requireSubtasksComplete)
          .onChange(async (value) => {
            this.plugin.settings.requireSubtasksComplete = value;
            await this.plugin.saveData(this.plugin.settings);
            await this.plugin.refreshView();
          })
      );

    new Setting(containerEl)
      .setName("Show notes indicator")
      .setDesc("Show a small indicator on tasks that have notes.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.showNotesIndicator)
          .onChange(async (value) => {
            this.plugin.settings.showNotesIndicator = value;
            await this.plugin.saveData(this.plugin.settings);
            await this.plugin.refreshView();
          })
      );
  }

  private renderAdvancedAreaFeaturesSection(containerEl: HTMLElement) {
    this.sectionHeading(containerEl, "Area features");

    new Setting(containerEl)
      .setName("Advanced area features")
      .setDesc("Enable custom fields and table view. Existing field data is preserved when this is off.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.advancedAreaFeatures)
          .onChange(async (value) => {
            this.plugin.settings.advancedAreaFeatures = value;
            await this.plugin.saveData(this.plugin.settings);
            await this.plugin.refreshView();
          })
      );
  }

  private renderModesSection(containerEl: HTMLElement) {
    this.sectionHeading(containerEl, "AI vs direct mode");
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "When on, the AI picks and filters items for that field. When off, items are taken verbatim from your vault files in order.",
    });

    const toggle = (name: string, desc: string, key: keyof MorningOSSettings) => {
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addToggle((t) =>
          t
            .setValue(this.plugin.settings[key] as boolean)
            .onChange(async (value) => { await this.save({ [key]: value }, "AI vs direct mode"); })
        );
    };

    toggle("Tactical rules", "AI picks the most relevant rules for today's tasks.", "modeTacticalRules");
    toggle("Identity rules", "AI picks identity affirmations resonant with today.", "modeIdentityRules");
    toggle("Goals", "AI selects and orders goals based on current tasks.", "modeGoals");
    toggle("Hobby tasks", "AI picks hobby tasks from your file — no generation.", "modeHobbyTasks");
    toggle("Suggestions", "AI generates new suggestion text (the only field where it writes new content).", "modeSuggestion");
    toggle("Wins", "AI orders recent wins. Off reads the Wins log directly.", "modeWins");
  }

  private renderAreaBriefingSourcesSection(containerEl: HTMLElement) {
    this.sectionHeading(containerEl, "Area briefing sources");
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "Choose which Areas may contribute Markdown sections to AI-generated briefings.",
    });

    for (const area of this.plugin.settings.areas) {
      new Setting(containerEl)
        .setName(`${area.icon} ${area.label}`)
        .addToggle((toggle) =>
          toggle
            .setValue(area.feedToLLM ?? true)
            .onChange(async (value) => {
              area.feedToLLM = value;
              await this.save({ areas: [...this.plugin.settings.areas] }, "Area briefing sources");
            })
        );
    }
  }

  private selectedAreaKey: string | null = null;
  private selectedTabKey: string | null = null;

  private renderAreasSection(containerEl: HTMLElement) {
    this.sectionHeading(containerEl, "Areas");
    const areas = this.plugin.settings.areas;
    const saveDataOnly = async () => {
      await this.plugin.saveData(this.plugin.settings);
      this.plugin.refreshView();
    };
    const saveAndSync = async () => {
      await this.plugin.saveData(this.plugin.settings);
      await this.plugin.reregisterAreaViews();
    };

    if (this.selectedAreaKey && !areas.find(p => p.key === this.selectedAreaKey)) {
      this.selectedAreaKey = null; this.selectedTabKey = null;
    }

    const wrap = containerEl.createDiv({ cls: "mos-areas-layout" });
    const left = wrap.createDiv({ cls: "mos-areas-left" });
    const right = wrap.createDiv({ cls: "mos-areas-right" });

    // ── LEFT: area list ──────────────────────────────────────────────────

    const renderNavRow = (p: typeof areas[0], pi: number) => {
      const row = left.createDiv({ cls: "mos-areas-nav-row" });
      const item = row.createDiv({
        cls: "mos-areas-nav-item" + (this.selectedAreaKey === p.key ? " is-active" : ""),
        text: `${p.icon} ${p.label}`,
        attr: { "data-key": p.key },
      });
      item.addEventListener("click", () => {
        left.querySelectorAll(".mos-areas-nav-item").forEach(el => el.removeClass("is-active"));
        item.addClass("is-active");
        this.selectedAreaKey = p.key;
        this.selectedTabKey = null;
        right.empty();
        renderRight();
      });

      const reorder = row.createDiv({ cls: "mos-areas-reorder" });
      if (pi > 0) {
        reorder.createEl("button", { cls: "mos-btn mos-btn-icon", text: "↑" })
          .addEventListener("click", (e) => {
            void (async () => {
              e.stopPropagation();
              [areas[pi - 1], areas[pi]] = [areas[pi], areas[pi - 1]];
              await saveDataOnly();
              left.empty(); renderLeft();
            })();
          });
      }
      if (pi < areas.length - 1) {
        reorder.createEl("button", { cls: "mos-btn mos-btn-icon", text: "↓" })
          .addEventListener("click", (e) => {
            void (async () => {
              e.stopPropagation();
              [areas[pi], areas[pi + 1]] = [areas[pi + 1], areas[pi]];
              await saveDataOnly();
              left.empty(); renderLeft();
            })();
          });
      }
    };

    const renderLeft = () => {
      areas.forEach((p, pi) => renderNavRow(p, pi));

      left.createDiv({ cls: "mos-areas-nav-divider" });
      const addRow = left.createDiv({ cls: "mos-areas-add-row" });
      const labelIn = addRow.createEl("input", { type: "text", cls: "morning-os-wins-input", placeholder: "New area…" });
      const addBtn = addRow.createEl("button", { cls: "mos-btn mos-btn-primary", text: "Add" });
      const doAdd = async () => {
        const l = labelIn.value.trim();
        if (!l) return;
        const k = l.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
        if (areas.find(p => p.key === k)) return;
        areas.push({ key: k, label: l, icon: "📌", tabs: [], feedToLLM: true });
        this.selectedAreaKey = k;
        this.selectedTabKey = null;
        labelIn.value = "";
        await saveDataOnly();
        // Surgically add the new nav row and re-render right
        left.empty(); renderLeft();
        right.empty(); renderRight();
      };
      addBtn.addEventListener("click", () => { void doAdd(); });
      labelIn.addEventListener("keydown", (e: KeyboardEvent) => { if (e.key === "Enter") void doAdd(); });
    };

    // ── RIGHT: area detail ───────────────────────────────────────────────

    const renderTabDetail = (tabDetailEl: HTMLElement, selectedTab: typeof areas[0]["tabs"][0]) => {
      tabDetailEl.empty();

      // Tab name edit
      new Setting(tabDetailEl).setName("Tab name").addText(t => {
        t.setValue(selectedTab.label);
        t.onChange(async v => {
          selectedTab.label = v;
          // Update pill label in-place
          const pill = right.querySelector(`.mos-areas-tab-btn[data-tabkey="${selectedTab.key}"] span`);
          if (pill) pill.textContent = v;
          await saveAndSync();
        });
      });

      if (!this.plugin.settings.advancedAreaFeatures) return;

      // View mode toggle
      new Setting(tabDetailEl).setName("View mode").setDesc("Cards show task cards with chips. Table shows a spreadsheet-style grid.").addDropdown(dd => {
        dd.addOptions({ cards: "Cards", table: "Table" });
        dd.setValue(selectedTab.view_mode ?? "cards");
        dd.onChange(async v => {
          selectedTab.view_mode = v as "cards" | "table";
          await saveAndSync();
        });
      });

      tabDetailEl.createDiv({ cls: "mos-areas-sub-heading", text: "Fields" });

      const renderFieldRows = () => {
        const existing = tabDetailEl.querySelectorAll(".mos-field-row");
        existing.forEach(el => el.remove());
        selectedTab.fields.forEach((field, fi) => {
          const fRow = tabDetailEl.createDiv({ cls: "mos-area-builder-row mos-field-row" });
          fRow.createSpan({ cls: "mos-area-builder-label", text: field.label });
          fRow.createSpan({ cls: "mos-meta-chip", text: field.type });
          if (field.type === "dropdown") {
            const optStr = (field.options ?? []).join(", ");
            const optInput = fRow.createEl("input", { type: "text", cls: "morning-os-wins-input mos-field-options-inline", placeholder: "Options (comma-separated)" });
            optInput.value = optStr;
            optInput.addEventListener("change", () => {
              void (async () => {
                field.options = optInput.value.split(",").map(s => s.trim()).filter(Boolean);
                await saveDataOnly();
              })();
            });
          }
          fRow.createEl("button", { cls: "mos-btn mos-btn-icon", text: "✕" })
            .addEventListener("click", () => {
              void (async () => {
                selectedTab.fields.splice(fi, 1);
                await saveDataOnly();
                renderFieldRows();
              })();
            });
        });
      };
      renderFieldRows();

      if (selectedTab.fields.length === 0) {
        tabDetailEl.createEl("p", { cls: "mos-areas-empty", text: "No fields yet." });
      }

      const addFRow = tabDetailEl.createDiv({ cls: "mos-area-builder-row" });
      const fLabelIn = addFRow.createEl("input", { type: "text", cls: "morning-os-wins-input", placeholder: "Field label" });
      const fTypeSelect = addFRow.createEl("select", { cls: "mos-btn mos-btn-select" });
      for (const ft of ["text", "url", "dropdown", "date"]) fTypeSelect.createEl("option", { value: ft, text: ft });
      const fOptionsWrap = tabDetailEl.createDiv({ cls: "mos-area-builder-row mos-field-options-row" });
      fOptionsWrap.addClass("mos-field-options-hidden");
      fOptionsWrap.createEl("label", { cls: "mos-edit-label", text: "Options (comma-separated)" });
      const fOptionsIn = fOptionsWrap.createEl("input", { type: "text", cls: "morning-os-wins-input", placeholder: "Option 1, Option 2, Option 3" });
      fTypeSelect.addEventListener("change", () => {
        fOptionsWrap.toggleClass("mos-field-options-hidden", fTypeSelect.value !== "dropdown");
      });
      const doAddField = async () => {
        const l = fLabelIn.value.trim();
        if (!l) return;
        const k = l.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
        const fieldType = fTypeSelect.value as FieldDef["type"];
        const field: FieldDef = { key: k, label: l, type: fieldType };
        if (fieldType === "dropdown") {
          field.options = fOptionsIn.value.split(",").map(s => s.trim()).filter(Boolean);
        }
        selectedTab.fields.push(field);
        fLabelIn.value = "";
        fOptionsIn.value = "";
        fOptionsWrap.addClass("mos-field-options-hidden");
        fTypeSelect.value = "text";
        await saveDataOnly();
        renderFieldRows();
      };
      addFRow.createEl("button", { cls: "mos-btn mos-btn-primary", text: "Add" })
        .addEventListener("click", () => { void doAddField(); });
      fLabelIn.addEventListener("keydown", (e: KeyboardEvent) => { if (e.key === "Enter") void doAddField(); });
    };

    const renderRight = () => {
      if (!this.selectedAreaKey) {
        right.createEl("p", { cls: "mos-areas-empty", text: "← Select an area to edit" });
        return;
      }
      const area = areas.find(p => p.key === this.selectedAreaKey);
      if (!area) return;

      // Header
      const ph = right.createDiv({ cls: "mos-areas-detail-header" });
      const previewEl = ph.createSpan({ cls: "mos-areas-detail-preview", text: `${area.icon} ${area.label}` });
      const navItem = left.querySelector(`.mos-areas-nav-item[data-key="${area.key}"]`);

      ph.createEl("button", { cls: "mos-btn mos-btn-inline mos-btn-danger", text: "Delete area" })
        .addEventListener("click", () => {
          void (async () => {
            const idx = areas.findIndex(p => p.key === area.key);
            if (idx !== -1) areas.splice(idx, 1);
            this.selectedAreaKey = null;
            await saveDataOnly();
            left.empty(); renderLeft();
            right.empty(); renderRight();
          })();
        });

      // Label
      new Setting(right).setName("Label").addText(t => {
        t.setValue(area.label);
        t.onChange(async v => {
          area.label = v;
          previewEl.textContent = `${area.icon} ${area.label}`;
          if (navItem) navItem.textContent = `${area.icon} ${area.label}`;
          await saveAndSync();
        });
      });

      // Icon picker
      const iconSetting = new Setting(right).setName("Icon");
      const iconBtn = iconSetting.controlEl.createEl("button", { cls: "mos-icon-picker-btn", text: area.icon });
      iconBtn.addEventListener("click", () => {
        const existing = right.querySelector(".mos-emoji-picker-wrap");
        if (existing) { existing.remove(); return; }
        const wrap = right.createDiv({ cls: "mos-emoji-picker-wrap" });
        // emoji-picker-element is a web component — just instantiate and append
        void import("emoji-picker-element").then(({ Picker }) => {
          const picker = new Picker({ skinToneEmoji: "👋" });
          picker.classList.add("mos-emoji-picker");
          picker.addEventListener("emoji-click", (e: Event) => {
            void (async () => {
              const unicode = (e as CustomEvent<{ unicode?: string }>).detail?.unicode;
              if (!unicode) return;
              area.icon = unicode;
              iconBtn.textContent = unicode;
              previewEl.textContent = `${unicode} ${area.label}`;
              if (navItem) navItem.textContent = `${unicode} ${area.label}`;
              wrap.remove();
              await saveAndSync();
            })();
          });
          wrap.appendChild(picker);
        });
      });

      // Tabs section
      right.createDiv({ cls: "setting-item-heading mos-areas-sub-heading", text: "Tabs" });

      const tabNav = right.createDiv({ cls: "mos-areas-tab-nav" });
      const tabDetailContainer = right.createDiv();

      const renderTabNav = () => {
        tabNav.empty();
        area.tabs.forEach(tab => {
          const tabBtn = tabNav.createDiv({
            cls: "mos-areas-tab-btn" + (this.selectedTabKey === tab.key ? " is-active" : ""),
            attr: { "data-tabkey": tab.key },
          });
          tabBtn.createSpan({ text: tab.label });
          tabBtn.createEl("button", { cls: "mos-btn mos-btn-icon", text: "✕" })
            .addEventListener("click", (e) => {
              void (async () => {
                e.stopPropagation();
                const ti = area.tabs.findIndex(t => t.key === tab.key);
                if (ti !== -1) area.tabs.splice(ti, 1);
                if (this.selectedTabKey === tab.key) {
                  this.selectedTabKey = null;
                  tabDetailContainer.empty();
                }
                await saveDataOnly();
                renderTabNav();
              })();
            });
          tabBtn.addEventListener("click", () => {
            this.selectedTabKey = this.selectedTabKey === tab.key ? null : tab.key;
            tabNav.querySelectorAll(".mos-areas-tab-btn").forEach(el => el.removeClass("is-active"));
            if (this.selectedTabKey) tabBtn.addClass("is-active");
            tabDetailContainer.empty();
            const t = area.tabs.find(tb => tb.key === this.selectedTabKey);
            if (t) renderTabDetail(tabDetailContainer, t);
          });
        });
      };
      renderTabNav();

      // Render tab detail if one is already selected
      const currentTab = area.tabs.find(t => t.key === this.selectedTabKey);
      if (currentTab) renderTabDetail(tabDetailContainer, currentTab);

      // Add tab
      const addTabRow = right.createDiv({ cls: "mos-area-builder-row" });
      const tabLabelIn = addTabRow.createEl("input", { type: "text", cls: "morning-os-wins-input", placeholder: "New tab…" });
      const doAddTab = async () => {
        const l = tabLabelIn.value.trim();
        if (!l) return;
        const k = l.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
        if (area.tabs.find(t => t.key === k)) return;
        area.tabs.push({ key: k, label: l, fields: [], view_mode: "cards" });
        this.selectedTabKey = k;
        tabLabelIn.value = "";
        await saveDataOnly();
        renderTabNav();
        const newTab = area.tabs.find(t => t.key === k)!;
        tabDetailContainer.empty();
        renderTabDetail(tabDetailContainer, newTab);
      };
      addTabRow.createEl("button", { cls: "mos-btn mos-btn-primary", text: "Add tab" })
        .addEventListener("click", () => { void doAddTab(); });
      tabLabelIn.addEventListener("keydown", (e: KeyboardEvent) => { if (e.key === "Enter") void doAddTab(); });
    };

    renderLeft();
    renderRight();
  }
}
