import { App, PluginSettingTab, Setting } from "obsidian";
import type MorningOSPlugin from "./main";
import type { AreaConfig, TabConfig, FieldDef, LLMSectionMapping } from "./types";

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
  sectionPending: string;

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
  modeTechnicalTasks: boolean;
  modeTasks: boolean;
  modeWins: boolean;

  // Intelligence LLM
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
  technicalTasksCount: number;

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
  sectionPending: "Top 3 pending",

  goalsShortTerm: "Short Term",
  goalsLongTerm: "Long Term",

  modeTacticalRules: true,
  modeIdentityRules: false,
  modeGoals: true,
  modeHobbyTasks: true,
  modeSuggestion: true,
  modeTechnicalTasks: false,
  modeTasks: false,
  modeWins: false,

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
  technicalTasksCount: 5,

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

  private activeSettingsTab = "briefing";

  private renderTabBar(containerEl: HTMLElement) {
    const tabs = [
      { key: "briefing", label: "Briefing" },
      { key: "ai",       label: "AI" },
      { key: "vault",    label: "Vault" },
      { key: "display",  label: "Display" },
      { key: "areas",  label: "Areas" },
      { key: "about",    label: "About" },
    ];
    const bar = containerEl.createEl("div", { cls: "mos-settings-tab-bar" });
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

    const content = containerEl.createEl("div", { cls: "mos-settings-content" });
    switch (this.activeSettingsTab) {
      case "briefing": this.renderAgentSection(content); break;
      case "ai":       this.renderAISection(content); break;
      case "vault":    this.renderPathsSection(content); this.renderHeadingsSection(content); break;
      case "display":  this.renderCountsSection(content); this.renderModesSection(content); break;
      case "areas":  this.renderAreasSection(content); break;
      case "about":    this.renderAboutSection(content); break;
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
    const bannerSlot = containerEl.createEl("div", { cls: "mos-run-banner-slot" });
    bannerSlot.createEl("span", { text: "⚠ Settings changed — run the agent to apply them." });
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

    new Setting(containerEl)
      .setName("Model")
      .setDesc("Model ID to use. Defaults are pre-filled per provider.")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.intelligenceModel)
          .onChange(async (value) => { await this.save({ intelligenceModel: value }, "AI provider"); })
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

  private renderPathsSection(containerEl: HTMLElement) {
    this.sectionHeading(containerEl, "Vault paths");
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "All paths are relative to your vault root. Change these only if your vault structure differs from the defaults.",
    });

    const migrationDone = this.plugin.settings.migrationComplete;
    const migrationSetting = new Setting(containerEl)
      .setName("Migrate vault to areas")
      .setDesc(migrationDone
        ? "Migration complete. Your vault is using the new area system."
        : "Move your existing rules, goals, and tasks to the new area system. Old files are archived to _archive/pre-migration/.");

    if (migrationDone) {
      migrationSetting.setDesc("Migration complete. Your vault is using the new area system. Only re-run if you've added new content to old source files.");
      migrationSetting.addButton(btn => {
        btn.setButtonText("Migrated ✓").setDisabled(true);
        btn.buttonEl.addClass("mos-btn-success");
      });
      migrationSetting.addButton(btn => {
        btn.setButtonText("Re-run").onClick(async () => {
          btn.setButtonText("Checking…");
          btn.setDisabled(true);
          try {
            await this.plugin.migrateVault();
            this.rerender();
          } catch (e) {
            btn.setButtonText("Failed ✗");
            window.setTimeout(() => { btn.setButtonText("Re-run"); btn.setDisabled(false); }, 3000);
          }
        });
      });
    } else {
      migrationSetting.addButton(btn =>
        btn.setButtonText("Migrate").setCta().onClick(async () => {
          btn.setButtonText("Migrating…");
          btn.setDisabled(true);
          try {
            await this.plugin.migrateVault();
            this.rerender();
          } catch (e) {
            btn.setButtonText("Failed ✗");
            btn.setDisabled(false);
          }
        })
      );
    }

    new Setting(containerEl)
      .setName("Daily notes folder")
      .setDesc("Used by migration to archive old daily notes. Run migration to move these to _archive/daily-notes/ and remove this folder.")
      .addText((text) =>
        text
          .setPlaceholder("Essential/Daily")
          .setValue(this.plugin.settings.dailyNoteDir)
          .onChange(async (value) => { await this.save({ dailyNoteDir: value }, "Vault paths"); })
      );

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
      .setName("Tactical rules file")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.sourceTacticalRules)
          .onChange(async (value) => { await this.save({ sourceTacticalRules: value }, "Vault paths"); })
      );

    new Setting(containerEl)
      .setName("Emotional rules file")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.sourceEmotionalRules)
          .onChange(async (value) => { await this.save({ sourceEmotionalRules: value }, "Vault paths"); })
      );

    new Setting(containerEl)
      .setName("Goals file")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.sourceGoals)
          .onChange(async (value) => { await this.save({ sourceGoals: value }, "Vault paths"); })
      );

    new Setting(containerEl)
      .setName("Technical tasks file")
      .setDesc("Legacy — tasks now live in the registry. Kept for brief context.")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.sourceTechnicalTasks)
          .onChange(async (value) => { await this.save({ sourceTechnicalTasks: value }, "Vault paths"); })
      );

    new Setting(containerEl)
      .setName("Hobby tasks file")
      .setDesc("Legacy — tasks now live in the registry. Kept for brief context.")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.sourceHobbyTasks)
          .onChange(async (value) => { await this.save({ sourceHobbyTasks: value }, "Vault paths"); })
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

  private renderHeadingsSection(containerEl: HTMLElement) {
    this.sectionHeading(containerEl, "Section headings");
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "The ## heading names used in your daily note and goals file. Must match exactly (case-insensitive).",
    });

    new Setting(containerEl)
      .setName("Red alert heading")
      .setDesc("Daily note heading for urgent tasks.")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.sectionRedAlert)
          .onChange(async (value) => { await this.save({ sectionRedAlert: value }, "Section headings"); })
      );

    new Setting(containerEl)
      .setName("Regular tasks heading")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.sectionRegular)
          .onChange(async (value) => { await this.save({ sectionRegular: value }, "Section headings"); })
      );

    new Setting(containerEl)
      .setName("Wins heading")
      .setDesc("Used in both your daily note and the dashboard input.")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.sectionWins)
          .onChange(async (value) => { await this.save({ sectionWins: value }, "Section headings"); })
      );

    new Setting(containerEl)
      .setName("Thoughts heading")
      .setDesc("Daily note heading for unstructured captures.")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.sectionThoughts)
          .onChange(async (value) => { await this.save({ sectionThoughts: value }, "Section headings"); })
      );

    new Setting(containerEl)
      .setName("Top pending heading")
      .setDesc("Daily note heading for the top 3 pending items.")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.sectionPending)
          .onChange(async (value) => { await this.save({ sectionPending: value }, "Section headings"); })
      );

    new Setting(containerEl)
      .setName("Short-term goals heading")
      .setDesc("Heading in your goals file.")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.goalsShortTerm)
          .onChange(async (value) => { await this.save({ goalsShortTerm: value }, "Section headings"); })
      );

    new Setting(containerEl)
      .setName("Long-term goals heading")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.goalsLongTerm)
          .onChange(async (value) => { await this.save({ goalsLongTerm: value }, "Section headings"); })
      );
  }

  private renderCountsSection(containerEl: HTMLElement) {
    this.sectionHeading(containerEl, "How many items to show");

    const count = (name: string, key: keyof MorningOSSettings) => {
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
              if (!isNaN(n) && n >= 0) await this.save({ [key]: n } as Partial<MorningOSSettings>, "How many items to show");
            });
        });
    };

    count("Tactical rules", "tacticalRulesCount");
    count("Identity rules", "identityRulesCount");
    count("Short-term goals (shown in bar)", "goalsShortTermCount");
    count("Long-term goals (shown in bar)", "goalsLongTermCount");
    count("Hobby tasks", "hobbyTasksCount");
    count("Suggestions", "suggestionCount");
    count("Pending technical tasks", "technicalTasksCount");
  }

  private renderAboutSection(containerEl: HTMLElement) {
    this.sectionHeading(containerEl, "About");
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
            .onChange(async (value) => { await this.save({ [key]: value } as Partial<MorningOSSettings>, "AI vs direct mode"); })
        );
    };

    toggle("Tactical rules", "AI picks the most relevant rules for today's tasks.", "modeTacticalRules");
    toggle("Identity rules", "AI picks identity affirmations resonant with today.", "modeIdentityRules");
    toggle("Goals", "AI selects and orders goals based on current tasks.", "modeGoals");
    toggle("Hobby tasks", "AI picks hobby tasks from your file — no generation.", "modeHobbyTasks");
    toggle("Suggestions", "AI generates new suggestion text (the only field where it writes new content).", "modeSuggestion");
    toggle("Technical tasks", "AI filters technical tasks. Off = top N items in order.", "modeTechnicalTasks");
    toggle("Tasks", "AI processes red alert and regular tasks. Off = read directly from daily note.", "modeTasks");
    toggle("Wins", "AI processes wins. Off = read directly from daily note.", "modeWins");

    this.sectionHeading(containerEl, "Subtasks");
    new Setting(containerEl)
      .setName("Require subtasks complete before parent")
      .setDesc("When on, a task with open subtasks can't be checked off until every subtask is done. When off, a task's own checkbox is independent of its subtasks.")
      .addToggle((t) =>
        t
          .setValue(this.plugin.settings.requireSubtasksComplete)
          .onChange(async (value) => { await this.save({ requireSubtasksComplete: value }, "Subtasks"); })
      );

    this.sectionHeading(containerEl, "Notes");
    new Setting(containerEl)
      .setName("Show notes indicator")
      .setDesc("When on, tasks with notes show a small indicator on their row.")
      .addToggle((t) =>
        t
          .setValue(this.plugin.settings.showNotesIndicator)
          .onChange(async (value) => { await this.save({ showNotesIndicator: value }, "Notes"); })
      );
  }

  private selectedAreaKey: string | null = null;
  private selectedTabKey: string | null = null;

  private async saveAreas() {
    await this.save({ areas: [...this.plugin.settings.areas] });
    await this.plugin.reregisterAreaViews();
  }

  private renderAreasSection(containerEl: HTMLElement) {
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

    const wrap = containerEl.createEl("div", { cls: "mos-areas-layout" });
    const left = wrap.createEl("div", { cls: "mos-areas-left" });
    const right = wrap.createEl("div", { cls: "mos-areas-right" });

    // ── LEFT: area list ──────────────────────────────────────────────────

    const renderNavRow = (p: typeof areas[0], pi: number) => {
      const row = left.createEl("div", { cls: "mos-areas-nav-row" });
      const item = row.createEl("div", {
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

      const reorder = row.createEl("div", { cls: "mos-areas-reorder" });
      if (pi > 0) {
        reorder.createEl("button", { cls: "mos-btn mos-btn-icon", text: "↑" })
          .addEventListener("click", async (e) => {
            e.stopPropagation();
            [areas[pi - 1], areas[pi]] = [areas[pi], areas[pi - 1]];
            await saveDataOnly();
            left.empty(); renderLeft();
          });
      }
      if (pi < areas.length - 1) {
        reorder.createEl("button", { cls: "mos-btn mos-btn-icon", text: "↓" })
          .addEventListener("click", async (e) => {
            e.stopPropagation();
            [areas[pi], areas[pi + 1]] = [areas[pi + 1], areas[pi]];
            await saveDataOnly();
            left.empty(); renderLeft();
          });
      }
    };

    const renderLeft = () => {
      areas.forEach((p, pi) => renderNavRow(p, pi));

      left.createEl("div", { cls: "mos-areas-nav-divider" });
      const addRow = left.createEl("div", { cls: "mos-areas-add-row" });
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
      addBtn.addEventListener("click", doAdd);
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

      // View mode toggle
      new Setting(tabDetailEl).setName("View mode").setDesc("Cards show task cards with chips. Table shows a spreadsheet-style grid.").addDropdown(dd => {
        dd.addOptions({ cards: "Cards", table: "Table" });
        dd.setValue(selectedTab.view_mode ?? "cards");
        dd.onChange(async v => {
          selectedTab.view_mode = v as "cards" | "table";
          await saveAndSync();
        });
      });

      tabDetailEl.createEl("div", { cls: "mos-areas-sub-heading", text: "Fields" });

      const renderFieldRows = () => {
        const existing = tabDetailEl.querySelectorAll(".mos-field-row");
        existing.forEach(el => el.remove());
        selectedTab.fields.forEach((field, fi) => {
          const fRow = tabDetailEl.createEl("div", { cls: "mos-area-builder-row mos-field-row" });
          fRow.createEl("span", { cls: "mos-area-builder-label", text: field.label });
          fRow.createEl("span", { cls: "mos-meta-chip", text: field.type });
          if (field.type === "dropdown") {
            const optStr = (field.options ?? []).join(", ");
            const optInput = fRow.createEl("input", { type: "text", cls: "morning-os-wins-input mos-field-options-inline", placeholder: "Options (comma-separated)" });
            optInput.value = optStr;
            optInput.addEventListener("change", async () => {
              field.options = optInput.value.split(",").map(s => s.trim()).filter(Boolean);
              await saveDataOnly();
            });
          }
          fRow.createEl("button", { cls: "mos-btn mos-btn-icon", text: "✕" })
            .addEventListener("click", async () => {
              selectedTab.fields.splice(fi, 1);
              await saveDataOnly();
              renderFieldRows();
            });
        });
      };
      renderFieldRows();

      if (selectedTab.fields.length === 0) {
        tabDetailEl.createEl("p", { cls: "mos-areas-empty", text: "No fields yet." });
      }

      const addFRow = tabDetailEl.createEl("div", { cls: "mos-area-builder-row" });
      const fLabelIn = addFRow.createEl("input", { type: "text", cls: "morning-os-wins-input", placeholder: "Field label" });
      const fTypeSelect = addFRow.createEl("select", { cls: "mos-btn mos-btn-select" });
      for (const ft of ["text", "url", "dropdown", "date"]) fTypeSelect.createEl("option", { value: ft, text: ft });
      const fOptionsWrap = tabDetailEl.createEl("div", { cls: "mos-area-builder-row mos-field-options-row" });
      fOptionsWrap.style.display = "none";
      fOptionsWrap.createEl("label", { cls: "mos-edit-label", text: "Options (comma-separated)" });
      const fOptionsIn = fOptionsWrap.createEl("input", { type: "text", cls: "morning-os-wins-input", placeholder: "Option 1, Option 2, Option 3" });
      fTypeSelect.addEventListener("change", () => {
        fOptionsWrap.style.display = fTypeSelect.value === "dropdown" ? "flex" : "none";
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
        fOptionsWrap.style.display = "none";
        fTypeSelect.value = "text";
        await saveDataOnly();
        renderFieldRows();
      };
      addFRow.createEl("button", { cls: "mos-btn mos-btn-primary", text: "Add" })
        .addEventListener("click", doAddField);
      fLabelIn.addEventListener("keydown", (e: KeyboardEvent) => { if (e.key === "Enter") void doAddField(); });
    };

    const renderRight = () => {
      if (!this.selectedAreaKey) {
        right.createEl("p", { cls: "mos-areas-empty", text: "← Select a area to edit" });
        return;
      }
      const area = areas.find(p => p.key === this.selectedAreaKey);
      if (!area) return;

      // Header
      const ph = right.createEl("div", { cls: "mos-areas-detail-header" });
      const previewEl = ph.createEl("span", { cls: "mos-areas-detail-preview", text: `${area.icon} ${area.label}` });
      const navItem = left.querySelector(`.mos-areas-nav-item[data-key="${area.key}"]`) as HTMLElement | null;

      ph.createEl("button", { cls: "mos-btn mos-btn-inline mos-btn-danger", text: "Delete area" })
        .addEventListener("click", async () => {
          const idx = areas.findIndex(p => p.key === area.key);
          if (idx !== -1) areas.splice(idx, 1);
          this.selectedAreaKey = null;
          await saveDataOnly();
          left.empty(); renderLeft();
          right.empty(); renderRight();
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
        const wrap = right.createEl("div", { cls: "mos-emoji-picker-wrap" });
        // emoji-picker-element is a web component — just instantiate and append
        import("emoji-picker-element").then(({ Picker }) => {
          const picker = new Picker({ skinToneEmoji: "👋" });
          picker.addEventListener("emoji-click", async (e: Event) => {
            const unicode = (e as CustomEvent).detail?.unicode as string | undefined;
            if (!unicode) return;
            area.icon = unicode;
            iconBtn.textContent = unicode;
            previewEl.textContent = `${unicode} ${area.label}`;
            if (navItem) navItem.textContent = `${unicode} ${area.label}`;
            wrap.remove();
            await saveAndSync();
          });
          wrap.appendChild(picker);
        });
      });

      // Feed to LLM toggle
      new Setting(right).setName("Feed to LLM").setDesc("Allow this area's markdown sections to feed into the briefing agent context.").addToggle(t => {
        t.setValue(area.feedToLLM ?? true);
        t.onChange(async v => { area.feedToLLM = v; await saveAndSync(); });
      });

      // Tabs section
      right.createEl("div", { cls: "setting-item-heading mos-areas-sub-heading", text: "Tabs" });

      const tabNav = right.createEl("div", { cls: "mos-areas-tab-nav" });
      const tabDetailContainer = right.createEl("div");

      const renderTabNav = () => {
        tabNav.empty();
        area.tabs.forEach(tab => {
          const tabBtn = tabNav.createEl("div", {
            cls: "mos-areas-tab-btn" + (this.selectedTabKey === tab.key ? " is-active" : ""),
            attr: { "data-tabkey": tab.key },
          });
          tabBtn.createEl("span", { text: tab.label });
          tabBtn.createEl("button", { cls: "mos-btn mos-btn-icon", text: "✕" })
            .addEventListener("click", async (e) => {
              e.stopPropagation();
              const ti = area.tabs.findIndex(t => t.key === tab.key);
              if (ti !== -1) area.tabs.splice(ti, 1);
              if (this.selectedTabKey === tab.key) {
                this.selectedTabKey = null;
                tabDetailContainer.empty();
              }
              await saveDataOnly();
              renderTabNav();
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
      const addTabRow = right.createEl("div", { cls: "mos-area-builder-row" });
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
        .addEventListener("click", doAddTab);
      tabLabelIn.addEventListener("keydown", (e: KeyboardEvent) => { if (e.key === "Enter") void doAddTab(); });
    };

    renderLeft();
    renderRight();
  }
}
