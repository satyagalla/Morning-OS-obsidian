import { AbstractInputSuggest, TFolder, sanitizeHTMLToDom } from "obsidian";
import type MorningOSPlugin from "./main";
import { runAgent } from "./agent/run";

const SAMPLE_TACTICAL_RULES = `- Start the hardest task within 15 minutes of sitting down
- One tab, one task. Close everything else
- If stuck for 10 minutes, change the approach — don't stare harder
- No meetings before noon
- End the day by writing tomorrow's top 3`;

const SAMPLE_EMOTIONAL_RULES = `- Builds things that matter, even if no one's watching yet
- Protects mornings like they're sacred — low dopamine, high clarity
- Trusts the process over the mood`;

const SAMPLE_GOALS = `## Short Term
- Reply to every message within 24 hours this week
- Wake up before 8am for 5 days straight

## Long Term
- Design a life where Mondays feel the same as Fridays
- Become the person who finishes what they start`;

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
- [ ] Reply to the email I've been avoiding since Monday

## Regular
- [ ] 90 minutes deep work — phone in another room
- [ ] Clear 3 tabs I've had open all week
- [ ] Write down what to do first thing tomorrow

## Wins

## Thoughts
- First day using Morning OS
`;
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

  log.push("Generating first briefing...");
  await runAgent(app, plugin.settings);

  const briefPath = `${plugin.settings.briefsDir}/${dateStr}.json`;
  const briefJson = JSON.parse(await app.vault.adapter.read(briefPath)) as import("./types").DailyBrief;
  briefJson.suggestions = [
    { text: "Your rule says 'no meetings before noon' but you have a regular task every morning. Consider batching small tasks after lunch instead.", source: "tasks" },
    { text: "You've been carrying 'reply to email' as a red alert — most dreaded replies take under 5 minutes once you start typing. Send it before deep work so it's not in the back of your mind.", source: "carried_tasks" },
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
