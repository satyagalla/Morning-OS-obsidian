import { AbstractInputSuggest, TFolder } from "obsidian";
import type MorningOSPlugin from "./main";
import type { DailyBrief } from "./types";

const SAMPLE_TACTICAL_RULES = `- Break tasks into 25-minute focus blocks
- Process inbox to zero before starting deep work
- One task at a time — close all unrelated tabs
- If stuck for 10 minutes, change approach or ask for help
- End each day by writing tomorrow's top 3 priorities`;

const SAMPLE_EMOTIONAL_RULES = `- follows through on commitments, even small ones
- chooses discomfort over regret
- protects deep focus time without guilt`;

const SAMPLE_GOALS = `## Short Term
- Ship the MVP and get 10 beta users
- Build a consistent morning routine that sticks
- Read one non-fiction book this month

## Long Term
- Build a product that helps 10,000 people
- Achieve financial independence through my own work
- Become someone others trust for clear thinking`;

const SAMPLE_TECHNICAL_TASKS = `## Top 3 pending
- Set up CI/CD pipeline for the main project
- Refactor the authentication module
- Write integration tests for the API layer`;

const SAMPLE_HOBBY_TASKS = `- Practice guitar for 20 minutes
- Sketch one thing from observation
- Try a new recipe this week`;

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function dailyNoteTemplate(): string {
  return `## Red alert
- [ ] Complete the most important task of the day

## Regular
- [ ] Review my goals and priorities
- [ ] Clear inbox to zero
- [ ] Plan tomorrow before shutting down

## Wins

## Thoughts
- First day using Morning OS
`;
}

export function generateDemoBrief(dateStr: string): DailyBrief {
  return {
    date: dateStr,
    meta: { goals: { short_term_count: 2, long_term_count: 1 } },
    identity: {
      rules: [
        "follows through on commitments, even small ones",
        "chooses discomfort over regret",
        "protects deep focus time without guilt",
      ],
    },
    goals: {
      short_term: [
        "Ship the MVP and get 10 beta users",
        "Build a consistent morning routine that sticks",
      ],
      long_term: [
        "Build a product that helps 10,000 people",
      ],
    },
    tasks: {
      red_alert: [
        { text: "Complete the onboarding flow", carried_from: null },
      ],
      regular: [
        { text: "Review pull requests", carried_from: null },
        { text: "Update project documentation", carried_from: null },
        { text: "Plan next sprint priorities", carried_from: null },
      ],
    },
    tactical_rules: [
      "Break tasks into 25-minute focus blocks",
      "One task at a time — close all unrelated tabs",
      "If stuck for 10 minutes, change approach or ask for help",
      "End each day by writing tomorrow's top 3 priorities",
    ],
    technical_tasks: [
      "Set up CI/CD pipeline for the main project",
      "Refactor the authentication module",
      "Write integration tests for the API layer",
    ],
    hobby_tasks: [
      "Practice guitar for 20 minutes",
      "Sketch one thing from observation",
      "Try a new recipe this week",
    ],
    suggestions: [
      {
        text: "Your morning routine is your operating system's boot sequence. Protect it from interrupts — no messages, no email, no news until the system is fully online.",
        source: "Based on your tactical rules",
      },
      {
        text: "You listed 'Ship the MVP' as a goal. Consider blocking 2 hours today for the single highest-leverage task toward that — what would make everything else easier?",
        source: "Based on your goals",
      },
    ],
    wins: [],
    reminders: [],
  };
}

class FolderSuggest extends AbstractInputSuggest<TFolder> {
  private inputEl: HTMLInputElement;

  constructor(app: import("obsidian").App, inputEl: HTMLInputElement) {
    super(app, inputEl);
    this.inputEl = inputEl;
  }

  getSuggestions(query: string): TFolder[] {
    const folders = this.app.vault.getAllFolders();
    const lower = query.toLowerCase();
    return folders
      .filter(f => f.path.toLowerCase().includes(lower))
      .slice(0, 10);
  }

  renderSuggestion(folder: TFolder, el: HTMLElement): void {
    el.setText(folder.path || "/");
  }

  selectSuggestion(folder: TFolder): void {
    this.inputEl.value = folder.path;
    this.inputEl.dispatchEvent(new Event("input"));
    this.close();
  }
}

interface ScaffoldFile {
  path: string;
  content: string;
}

async function scaffoldVault(plugin: MorningOSPlugin, rootPath: string): Promise<string[]> {
  const app = plugin.app;
  const dateStr = todayStr();
  const log: string[] = [];

  const dirs = [
    `${rootPath}/Daily`,
    `${rootPath}/State of Mind`,
    `${rootPath}/Pending Tasks`,
    `${rootPath}/_generated/briefs`,
    `${rootPath}/_generated/feedback`,
    `${rootPath}/_generated/feedback/reactions`,
  ];

  for (const dir of dirs) {
    await app.vault.adapter.mkdir(dir);
    log.push(`Creating ${dir}/ ✓`);
  }

  const files: ScaffoldFile[] = [
    { path: `${rootPath}/State of Mind/Tactical Rules.md`, content: SAMPLE_TACTICAL_RULES },
    { path: `${rootPath}/State of Mind/Emotional Rules.md`, content: SAMPLE_EMOTIONAL_RULES },
    { path: `${rootPath}/State of Mind/Long-term and Short-term.md`, content: SAMPLE_GOALS },
    { path: `${rootPath}/Pending Tasks/Technical Tasks.md`, content: SAMPLE_TECHNICAL_TASKS },
    { path: `${rootPath}/Pending Tasks/Hobby Tasks.md`, content: SAMPLE_HOBBY_TASKS },
    { path: `${rootPath}/Daily/${dateStr}.md`, content: dailyNoteTemplate() },
  ];

  for (const file of files) {
    const exists = await app.vault.adapter.exists(file.path);
    if (exists) {
      log.push(`${file.path} exists, kept`);
    } else {
      await app.vault.adapter.write(file.path, file.content);
      log.push(`Creating ${file.path} ✓`);
    }
  }

  const briefPath = `${rootPath}/_generated/briefs/${dateStr}.json`;
  const brief = generateDemoBrief(dateStr);
  await app.vault.adapter.write(briefPath, JSON.stringify(brief, null, 2));
  log.push(`Generating first briefing ✓`);

  plugin.settings.dailyNoteDir = `${rootPath}/Daily`;
  plugin.settings.briefsDir = `${rootPath}/_generated/briefs`;
  plugin.settings.feedbackDir = `${rootPath}/_generated/feedback`;
  plugin.settings.sourceTacticalRules = `${rootPath}/State of Mind/Tactical Rules.md`;
  plugin.settings.sourceEmotionalRules = `${rootPath}/State of Mind/Emotional Rules.md`;
  plugin.settings.sourceGoals = `${rootPath}/State of Mind/Long-term and Short-term.md`;
  plugin.settings.sourceTechnicalTasks = `${rootPath}/Pending Tasks/Technical Tasks.md`;
  plugin.settings.sourceHobbyTasks = `${rootPath}/Pending Tasks/Hobby Tasks.md`;
  plugin.settings.onboarded = true;
  await plugin.saveData(plugin.settings);

  log.push("System online.");
  return log;
}

export function renderOnboarding(container: HTMLElement, plugin: MorningOSPlugin) {
  const wrap = container.createEl("div", { cls: "morning-os-onboarding" });

  const icon = wrap.createEl("div", { cls: "mos-onboard-icon" });
  icon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>`;

  wrap.createEl("h1", { cls: "mos-onboard-title", text: "Morning OS" });
  wrap.createEl("p", { cls: "mos-onboard-subtitle", text: "Your operating system is booting up." });
  wrap.createEl("p", { cls: "mos-onboard-subtitle", text: "Choose a root folder for the Morning OS structure." });

  const inputRow = wrap.createEl("div", { cls: "mos-onboard-input-row" });
  const input = inputRow.createEl("input", {
    cls: "mos-onboard-folder-input",
    attr: { type: "text", placeholder: "Essential", value: "Essential" },
  });

  new FolderSuggest(plugin.app, input);

  const btn = wrap.createEl("button", { cls: "mos-onboard-btn", text: "Initialize system" });

  btn.addEventListener("click", async () => {
    const rootPath = input.value.trim() || "Essential";

    wrap.empty();
    const terminal = wrap.createEl("div", { cls: "mos-onboard-terminal" });
    terminal.createEl("div", { cls: "mos-onboard-line", text: "> Initializing vault structure..." });

    const lines = await scaffoldVault(plugin, rootPath);

    let i = 0;
    const interval = window.setInterval(() => {
      if (i >= lines.length) {
        clearInterval(interval);
        setTimeout(() => plugin.refreshView(), 600);
        return;
      }
      const line = terminal.createEl("div", { cls: "mos-onboard-line" });
      line.setText(`> ${lines[i]}`);
      i++;
    }, 150);
  });
}
