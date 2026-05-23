import { App, TFile } from "obsidian";
import type { MorningOSSettings } from "../settings";

export interface ParsedTasks {
  red_alert: string[];
  regular: string[];
  wins: string[];
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

function parseBullet(line: string): string | null {
  if (!line) return null;

  let match = line.match(/^-\s*\[.\]\s*(.*)/);
  if (!match) match = line.match(/^-\s+(.*)/);
  if (!match) return null;

  const text = match[1].trim();
  if (!text) return null;
  if (text.startsWith("~~") && text.endsWith("~~")) return null;

  return text;
}

function extractSection(content: string, headerName: string, variants?: string[]): string[] {
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

  const items: string[] = [];
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
    if (item !== null) items.push(item);
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

  return { red_alert: redAlert, regular, wins };
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

  return extractSection(content, settings.sectionWins, WINS_VARIANTS);
}

export async function parseBulletFile(filePath: string, app: App): Promise<string[]> {
  const content = await readVaultFile(filePath, app);
  if (content === null) return [];
  return parseAllBullets(content);
}

export async function parseGoals(app: App, settings: MorningOSSettings): Promise<ParsedGoals> {
  const content = await readVaultFile(settings.sourceGoals, app);
  if (content === null) return { short_term: [], long_term: [] };

  const shortTerm = extractSection(content, settings.goalsShortTerm);
  const longTerm = extractSection(content, settings.goalsLongTerm);

  return { short_term: shortTerm, long_term: longTerm };
}
