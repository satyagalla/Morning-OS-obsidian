import { App, AbstractInputSuggest, TFile } from "obsidian";

type SuggestItem =
  | { kind: "file"; file: TFile }
  | { kind: "tag"; tag: string };

function getAllVaultTags(app: App): string[] {
  const tags = new Set<string>();
  for (const file of app.vault.getMarkdownFiles()) {
    const cache = app.metadataCache.getFileCache(file);
    if (!cache) continue;
    for (const t of cache.tags ?? []) tags.add(t.tag.replace(/^#/, ""));
    const fm: unknown = cache.frontmatter?.tags;
    if (Array.isArray(fm)) fm.forEach(t => tags.add(String(t).replace(/^#/, "")));
    else if (typeof fm === "string") fm.split(",").forEach(t => tags.add(t.trim().replace(/^#/, "")));
  }
  return Array.from(tags).sort();
}

// Attaches [[wikilink]] and #tag type-ahead to a plain <input> — mirrors Obsidian's
// native editor autocomplete, which plain text inputs don't get for free.
class TaskTextSuggest extends AbstractInputSuggest<SuggestItem> {
  private triggerStart = -1;
  private triggerKind: "file" | "tag" | null = null;

  constructor(app: App, private inputEl: HTMLInputElement) {
    super(app, inputEl);
  }

  protected getSuggestions(query: string): SuggestItem[] {
    const trigger = this.findTrigger(query);
    if (!trigger) return [];
    this.triggerStart = trigger.start;
    this.triggerKind = trigger.kind;
    const search = trigger.search.toLowerCase();

    if (trigger.kind === "file") {
      return this.app.vault.getMarkdownFiles()
        .filter(f => f.basename.toLowerCase().includes(search))
        .slice(0, 50)
        .map((file): SuggestItem => ({ kind: "file", file }));
    }
    return getAllVaultTags(this.app)
      .filter(t => t.toLowerCase().includes(search))
      .slice(0, 50)
      .map((tag): SuggestItem => ({ kind: "tag", tag }));
  }

  private findTrigger(value: string): { kind: "file" | "tag"; start: number; search: string } | null {
    const cursor = this.inputEl.selectionStart ?? value.length;
    const uptoCursor = value.slice(0, cursor);

    const linkIdx = uptoCursor.lastIndexOf("[[");
    if (linkIdx !== -1) {
      const between = uptoCursor.slice(linkIdx + 2);
      if (!between.includes("]]") && !between.includes("[[") && !/\s{2,}/.test(between)) {
        return { kind: "file", start: linkIdx, search: between };
      }
    }

    const hashIdx = uptoCursor.lastIndexOf("#");
    if (hashIdx !== -1) {
      const before = uptoCursor[hashIdx - 1];
      const between = uptoCursor.slice(hashIdx + 1);
      if ((before === undefined || /\s/.test(before)) && /^[^\s#]*$/.test(between)) {
        return { kind: "tag", start: hashIdx, search: between };
      }
    }
    return null;
  }

  renderSuggestion(item: SuggestItem, el: HTMLElement): void {
    el.setText(item.kind === "file" ? item.file.basename : `#${item.tag}`);
  }

  selectSuggestion(item: SuggestItem): void {
    if (this.triggerKind === null || this.triggerStart === -1) return;
    const value = this.inputEl.value;
    const cursor = this.inputEl.selectionStart ?? value.length;
    const insertText = item.kind === "file" ? `[[${item.file.basename}]] ` : `#${item.tag} `;
    const newValue = value.slice(0, this.triggerStart) + insertText + value.slice(cursor);

    this.inputEl.value = newValue;
    const newCursor = this.triggerStart + insertText.length;
    this.inputEl.focus();
    this.inputEl.setSelectionRange(newCursor, newCursor);
    this.inputEl.dispatchEvent(new Event("input", { bubbles: true }));

    this.close();
    this.triggerKind = null;
    this.triggerStart = -1;
  }
}

export function attachTaskTextSuggest(app: App, inputEl: HTMLInputElement): void {
  new TaskTextSuggest(app, inputEl);
}
