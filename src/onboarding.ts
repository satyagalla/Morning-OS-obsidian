import { AbstractInputSuggest, TFolder, sanitizeHTMLToDom } from "obsidian";
import type MorningOSPlugin from "./main";
import { runAgent } from "./agent/run";

const SAMPLE_HEALTH_CONTENT = `## Tactical Rules
- Start the hardest task within 15 minutes of sitting down
- One tab, one task. Close everything else
- If stuck for 10 minutes, change the approach — don't stare harder
- End the day by writing tomorrow's top 3

## Emotional Rules
- Builds things that matter, even if no one's watching yet
- Protects mornings like they're sacred — low dopamine, high clarity
- Trusts the process over the mood
`;

const SAMPLE_CAREER_CONTENT = `## Short Term
- Reply to every message within 24 hours this week
- Wake up before 8am for 5 days straight

## Long Term
- Design a life where Mondays feel the same as Fridays
- Become the person who finishes what they start
`;

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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

  // Create required directories
  const dirs = [
    `${rootPath}/Pillars`,
    `_generated/briefs`,
    `_generated/feedback`,
    `_generated/feedback/reactions`,
  ];
  for (const dir of dirs) {
    await app.vault.adapter.mkdir(dir);
    log.push(`Creating ${dir}/ ✓`);
  }

  // Create pillar markdown files (empty body, just the title heading)
  const pillarFiles: ScaffoldFile[] = plugin.settings.pillars.map(p => ({
    path: `${rootPath}/Pillars/${p.label}.md`,
    content: "",
  }));

  // Pre-populate Health and Career with sample content
  const healthFile = pillarFiles.find(f => f.path.includes("Health"));
  const careerFile = pillarFiles.find(f => f.path.includes("Career"));
  if (healthFile) healthFile.content = SAMPLE_HEALTH_CONTENT;
  if (careerFile) careerFile.content = SAMPLE_CAREER_CONTENT;

  // Create identity anchor
  const allFiles: ScaffoldFile[] = [
    ...pillarFiles,
    {
      path: `${rootPath}/Identity-Anchor.md`,
      content: `- I build things that matter\n- I protect my mornings\n- I trust the process\n- I am more than my to-do list\n- I am figuring it out, and that is enough\n`,
    },
    {
      path: `${rootPath}/Wins.md`,
      content: "",
    },
  ];

  for (const file of allFiles) {
    const exists = await app.vault.adapter.exists(file.path);
    if (exists) {
      log.push(`${file.path} exists, kept`);
    } else {
      await app.vault.adapter.write(file.path, file.content);
      log.push(`Creating ${file.path} ✓`);
    }
  }

  // Update settings paths
  plugin.settings.dailyNoteDir    = `${rootPath}/Daily`;
  plugin.settings.briefsDir       = `_generated/briefs`;
  plugin.settings.feedbackDir     = `_generated/feedback`;
  plugin.settings.sourceIdentity  = `${rootPath}/Identity-Anchor.md`;
  plugin.settings.sourceWins      = `${rootPath}/Wins.md`;
  // Legacy paths kept for migration fallback
  plugin.settings.sourceTacticalRules  = `${rootPath}/Pillars/Health.md`;
  plugin.settings.sourceEmotionalRules = `${rootPath}/Pillars/Health.md`;
  plugin.settings.sourceGoals          = `${rootPath}/Pillars/Career.md`;
  plugin.settings.sourceTechnicalTasks = `${rootPath}/Pillars/Career.md`;
  plugin.settings.sourceHobbyTasks     = `${rootPath}/Pillars/Interests.md`;
  plugin.settings.onboarded = true;
  await plugin.saveData(plugin.settings);

  log.push("Generating first briefing...");
  await runAgent(app, plugin.settings);

  const briefPath = `${plugin.settings.briefsDir}/${dateStr}.json`;
  const briefJson = JSON.parse(await app.vault.adapter.read(briefPath)) as import("./types").DailyBrief;
  briefJson.suggestions = [
    { text: "Welcome to Morning OS. Add your rules and goals to your Health and Career pillars — the briefing agent will use them to personalise your daily brief.", source: "tasks" },
    { text: "Start with your top 3 tasks for today: open the Inbox, add them, and move them to Today.", source: "tasks" },
  ];
  await app.vault.adapter.write(briefPath, JSON.stringify(briefJson, null, 2));

  log.push("System online.");
  return log;
}

export function renderOnboarding(container: HTMLElement, plugin: MorningOSPlugin) {
  const wrap = container.createEl("div", { cls: "morning-os-onboarding" });

  const icon = wrap.createEl("div", { cls: "mos-onboard-icon" });
  icon.appendChild(sanitizeHTMLToDom(`<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>`));

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

  btn.addEventListener("click", () => {
    void (async () => {
      const rootPath = input.value.trim() || "Essential";

      wrap.empty();
      const terminal = wrap.createEl("div", { cls: "mos-onboard-terminal" });
      terminal.createEl("div", { cls: "mos-onboard-line", text: "> Initializing vault structure..." });

      const lines = await scaffoldVault(plugin, rootPath);

      let i = 0;
      const interval = window.setInterval(() => {
        if (i >= lines.length) {
          window.clearInterval(interval);
          window.setTimeout(() => plugin.refreshView(), 600);
          return;
        }
        const line = terminal.createEl("div", { cls: "mos-onboard-line" });
        line.setText(`> ${lines[i]}`);
        i++;
      }, 150);
    })();
  });
}
