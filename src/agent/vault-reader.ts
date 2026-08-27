import { App, TFile } from "obsidian";
import type { MorningOSSettings } from "../settings";

export interface TaskItem {
  text: string;
  done: boolean;
  remind_date?: string | null;
}

export interface ParsedTasks {
  red_alert: TaskItem[];
  regular: TaskItem[];
  wins: TaskItem[];
  reminders: string[];
}

export interface ParsedGoals {
  short_term: string[];
  long_term: string[];
}

const WINS_VARIANTS = ["Wins", "I feel good about these after today"];

function isHeader(line: string, name: string): boolean {
  const stripped = line.trim().replace(/:$/, "");
  const lower = stripped.toLowerCase();
  const target = name.toLowerCase();
  return (
    lower === target ||
    lower === `# ${target}` ||
    lower === `## ${target}` ||
    lower === `### ${target}`
  );
}

function isAnyHeader(line: string): boolean {
  if (/^#{1,3}\s+/.test(line)) return true;
  if (line && !line.startsWith("-") && line.endsWith(":") && line.length < 50) return true;
  return false;
}

function parseBullet(line: string): TaskItem | null {
  if (!line) return null;

  const checkboxMatch = line.match(/^-\s*\[([xX ])\]\s*(.*)/);
  let text: string;
  let done = false;

  if (checkboxMatch) {
    done = checkboxMatch[1] !== " ";
    text = checkboxMatch[2].trim();
  } else {
    const plainMatch = line.match(/^-\s+(.*)/);
    if (!plainMatch) return null;
    text = plainMatch[1].trim();
  }

  if (!text) return null;
  if (text.startsWith("~~") && text.endsWith("~~")) return null;

  const remindMatch = text.match(/@remind\((\d{4}-\d{2}-\d{2})\)/);
  const remind_date = remindMatch ? remindMatch[1] : null;
  if (remindMatch) {
    text = text.replace(/@remind\([^)]*\)/, "").trim();
  }

  return { text, done, remind_date };
}

function extractSection(content: string, headerName: string, variants?: string[]): TaskItem[] {
  const lines = content.split("\n");
  const namesToCheck = [headerName, ...(variants ?? [])];

  let startIdx: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    for (const name of namesToCheck) {
      if (isHeader(lines[i], name)) {
        startIdx = i + 1;
        break;
      }
    }
    if (startIdx !== null) break;
  }

  if (startIdx === null) return [];

  const items: TaskItem[] = [];
  for (let i = startIdx; i < lines.length; i++) {
    const stripped = lines[i].trim();
    if (stripped && (stripped.startsWith("#") || isAnyHeader(stripped))) break;
    const item = parseBullet(stripped);
    if (item !== null) items.push(item);
  }

  return items;
}

function parseAllBullets(content: string): string[] {
  const items: string[] = [];
  for (const line of content.split("\n")) {
    const item = parseBullet(line.trim());
    if (item !== null) items.push(item.text);
  }
  return items;
}

async function readVaultFile(path: string, app: App): Promise<string | null> {
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) return null;
  return await app.vault.read(file);
}

export async function parseDailyNote(
  dateStr: string,
  app: App,
  settings: MorningOSSettings
): Promise<ParsedTasks | null> {
  const path = `${settings.dailyNoteDir}/${dateStr}.md`;
  const content = await readVaultFile(path, app);
  if (content === null) return null;

  const redAlert = extractSection(content, settings.sectionRedAlert);
  const regular = extractSection(content, settings.sectionRegular);
  const wins = extractSection(content, settings.sectionWins, WINS_VARIANTS);
  const reminders = extractSection(content, "Reminders").map(item => {
    return item.remind_date ? `${item.text} @remind(${item.remind_date})` : item.text;
  });

  return { red_alert: redAlert, regular, wins, reminders };
}

export async function parseYesterdayWins(
  todayStr: string,
  app: App,
  settings: MorningOSSettings
): Promise<string[]> {
  const d = new Date(todayStr + "T12:00:00");
  d.setDate(d.getDate() - 1);
  const yesterdayStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  const path = `${settings.dailyNoteDir}/${yesterdayStr}.md`;
  const content = await readVaultFile(path, app);
  if (content === null) return [];

  return extractSection(content, settings.sectionWins, WINS_VARIANTS).map(item => item.text);
}

export async function parseCompletedTasks(
  dateStr: string,
  app: App,
  settings: MorningOSSettings
): Promise<string[]> {
  const result = await parseDailyNote(dateStr, app, settings);
  if (result === null) return [];
  return [...result.red_alert, ...result.regular]
    .filter(t => t.done)
    .map(t => t.text);
}

export async function parseBulletFile(filePath: string, app: App): Promise<string[]> {
  const content = await readVaultFile(filePath, app);
  if (content === null) return [];
  return parseAllBullets(content);
}

export async function parseGoals(app: App, settings: MorningOSSettings): Promise<ParsedGoals> {
  const content = await readVaultFile(settings.sourceGoals, app);
  if (content === null) return { short_term: [], long_term: [] };

  const shortTerm = extractSection(content, settings.goalsShortTerm).map(item => item.text);
  const longTerm = extractSection(content, settings.goalsLongTerm).map(item => item.text);

  return { short_term: shortTerm, long_term: longTerm };
}

export async function parseIdentityAnchor(app: App, settings: MorningOSSettings): Promise<string[]> {
  const content = await readVaultFile(settings.sourceIdentity, app);
  if (content === null) return [];
  return content
    .split("\n")
    .map(l => l.trim().replace(/^-+\s*/, ""))
    .filter(l => l && !l.startsWith("#"));
}

// Parse a named section from a single markdown file — returns bullet texts
export async function parseSectionFromFile(path: string, sectionHeading: string, app: App): Promise<string[]> {
  const content = await readVaultFile(path, app);
  if (content === null) return [];
  return extractSection(content, sectionHeading).map(item => item.text);
}

// Gather a named section from area markdowns. Direct briefing fields always
// read every area; AI prompt inputs may opt in to Feed to LLM filtering.
export async function parseAllAreaSections(
  app: App,
  settings: MorningOSSettings,
  sectionHeading: string,
  onlyFeedToLLM = false
): Promise<string[]> {
  const userFolder = settings.dailyNoteDir.split("/")[0] || "Essential";
  const results: string[] = [];
  for (const area of settings.areas) {
    if (onlyFeedToLLM && !area.feedToLLM) continue;
    const path = `${userFolder}/Areas/${area.label}.md`;
    const bullets = await parseSectionFromFile(path, sectionHeading, app);
    results.push(...bullets);
  }
  return results;
}

// Parse yesterday's wins from Essential/Wins.md by date heading
export async function parseWinsFromLog(
  todayDateStr: string,
  app: App,
  settings: MorningOSSettings
): Promise<string[]> {
  const d = new Date(todayDateStr + "T12:00:00");
  d.setDate(d.getDate() - 1);
  const yesterdayStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const content = await readVaultFile(settings.sourceWins, app);
  if (content === null) return [];
  return extractSection(content, yesterdayStr).map(item => item.text);
}

// Append a win to Essential/Wins.md under today's date heading (idempotent per bullet)
export async function appendWinToLog(
  winText: string,
  todayDateStr: string,
  app: App,
  settings: MorningOSSettings
): Promise<void> {
  const path = settings.sourceWins;
  let content = "";
  const exists = await app.vault.adapter.exists(path);
  if (exists) {
    content = await app.vault.adapter.read(path);
  }

  // Check for duplicate
  const todaySection = extractSection(content, todayDateStr).map(i => i.text.toLowerCase());
  if (todaySection.includes(winText.toLowerCase().trim())) return;

  // Normalize line endings to LF
  content = content.replace(/\r\n/g, "\n");

  const headingLine = `## ${todayDateStr}`;
  if (content.includes(headingLine)) {
    // Insert bullet directly after the last existing bullet under this heading
    const lines = content.split("\n");
    const headingIdx = lines.findIndex(l => l.trim() === headingLine);
    let insertIdx = headingIdx + 1;
    // Skip past existing bullets, stop at next heading or end
    while (insertIdx < lines.length && !lines[insertIdx].startsWith("## ")) {
      insertIdx++;
    }
    // Insert before any trailing blank lines before the next section
    while (insertIdx > headingIdx + 1 && lines[insertIdx - 1].trim() === "") {
      insertIdx--;
    }
    lines.splice(insertIdx, 0, `- ${winText}`);
    content = lines.join("\n");
  } else {
    // Prepend new date heading at top, ensure single blank line between sections
    const rest = content.trim();
    content = rest
      ? `${headingLine}\n- ${winText}\n\n${rest}\n`
      : `${headingLine}\n- ${winText}\n`;
  }

  const dir = path.split("/").slice(0, -1).join("/");
  if (dir && !(await app.vault.adapter.exists(dir))) {
    await app.vault.adapter.mkdir(dir);
  }
  await app.vault.adapter.write(path, content);
}

// Read today's wins from the log
export async function readTodayWinsFromLog(
  todayDateStr: string,
  app: App,
  settings: MorningOSSettings
): Promise<string[]> {
  const content = await readVaultFile(settings.sourceWins, app);
  if (content === null) return [];
  return extractSection(content, todayDateStr).map(item => item.text);
}
