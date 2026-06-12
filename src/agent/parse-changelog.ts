export interface ChangelogSection {
  heading: string;
  items: string[];
}

export interface ChangelogEntry {
  version: string;
  sections: ChangelogSection[];
}

export function parseChangelog(text: string, version: string): ChangelogEntry | null {
  const lines = text.split("\n");

  // Find the version block
  const startIdx = lines.findIndex(l => l.trim() === `## v${version}` || l.trim() === `## ${version}`);
  if (startIdx === -1) return null;

  // End at the next ## heading or EOF
  const endIdx = lines.findIndex((l, i) => i > startIdx && /^## /.test(l));
  const block = lines.slice(startIdx + 1, endIdx === -1 ? undefined : endIdx);

  const sections: ChangelogSection[] = [];
  let current: ChangelogSection | null = null;

  for (const line of block) {
    const trimmed = line.trim();

    // New section heading
    if (/^### /.test(trimmed)) {
      current = { heading: trimmed.replace(/^### /, ""), items: [] };
      sections.push(current);
      continue;
    }

    // Skip separators and empty lines between sections
    if (!trimmed || trimmed === "---") continue;

    if (!current) continue;

    // Strip markdown bold markers, strip markdown links, strip leading list marker
    const clean = trimmed
      .replace(/^[-*]\s+/, "")                    // - item or * item → item
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")   // [text](url) → text
      .replace(/\*\*/g, "");                       // **bold** → plain

    if (clean) current.items.push(clean);
  }

  return { version, sections };
}
