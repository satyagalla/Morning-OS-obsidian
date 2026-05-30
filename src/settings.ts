import { App, PluginSettingTab, Setting } from "obsidian";
import type MorningOSPlugin from "./main";

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

  // Onboarding
  onboarded: boolean;
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

  onboarded: false,
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
    this.containerEl.querySelectorAll("h3[data-dirty]").forEach((el) => {
      (el as HTMLElement).removeAttribute("data-dirty");
    });
    this.hideRunBanner();
  }

  private markSectionDirty(section: string) {
    this.containerEl.querySelectorAll("h3").forEach((el) => {
      if (el.textContent === section) (el as HTMLElement).setAttribute("data-dirty", "true");
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
    const h = containerEl.createEl("h3", { text });
    if (this.dirtySections.has(text)) h.setAttribute("data-dirty", "true");
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    this.renderAgentSection(containerEl);
    this.renderAISection(containerEl);
    this.renderPathsSection(containerEl);
    this.renderHeadingsSection(containerEl);
    this.renderCountsSection(containerEl);
    this.renderModesSection(containerEl);
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
        text.inputEl.style.width = "60px";
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
              setTimeout(() => { btn.setButtonText("Run"); btn.setDisabled(false); }, 3000);
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
              setTimeout(() => { btn.setButtonText("Refresh"); btn.setDisabled(false); }, 3000);
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
            this.display();
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

    new Setting(containerEl)
      .setName("Daily notes folder")
      .setDesc("Where your YYYY-MM-DD.md daily notes live.")
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
      .addText((text) =>
        text
          .setValue(this.plugin.settings.sourceTechnicalTasks)
          .onChange(async (value) => { await this.save({ sourceTechnicalTasks: value }, "Vault paths"); })
      );

    new Setting(containerEl)
      .setName("Hobby tasks file")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.sourceHobbyTasks)
          .onChange(async (value) => { await this.save({ sourceHobbyTasks: value }, "Vault paths"); })
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
          text.inputEl.style.width = "60px";
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
  }
}
