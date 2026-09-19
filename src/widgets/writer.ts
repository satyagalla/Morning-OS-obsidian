import { TFile } from "obsidian";
import { readWidgetOwnership, WIDGET_PRODUCER, WIDGET_VERSION, widgetNotesSemanticallyEqual } from "./render";
import type { WidgetNoteExport } from "./types";

export interface WidgetVault {
  getAbstractFileByPath(path: string): unknown;
  read(file: TFile): Promise<string>;
  modify(file: TFile, content: string): Promise<void>;
  create(path: string, content: string): Promise<TFile>;
  createFolder(path: string): Promise<unknown>;
}

export class WidgetDestinationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WidgetDestinationError";
  }
}

export function validateWidgetDestination(destination: string): string {
  if (!destination || destination !== destination.trim()) throw new WidgetDestinationError("Widget destination is required");
  if (!destination.endsWith(".md") || destination.includes("\\") || destination.startsWith("/") ||
    /^[a-zA-Z]:/.test(destination) || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(destination)) {
    throw new WidgetDestinationError("Widget destination must be a vault-relative .md path");
  }
  const parts = destination.split("/");
  if (parts.some(part => !part || part === "." || part === "..")) {
    throw new WidgetDestinationError("Widget destination cannot contain traversal segments");
  }
  const protectedParts = parts.map(part => part.toLocaleLowerCase());
  if (protectedParts[0] === ".obsidian" || (protectedParts[0] === "_generated" &&
    (protectedParts[1] === "data" || protectedParts[1] === "snapshots"))) {
    throw new WidgetDestinationError("Widget destination is in a protected vault folder");
  }
  return destination;
}

/** Use this key when checking export settings for duplicate destinations. */
export function canonicalWidgetDestination(destination: string): string {
  return validateWidgetDestination(destination).toLocaleLowerCase();
}

export class WidgetNoteWriter {
  private pending = Promise.resolve();

  constructor(private readonly vault: WidgetVault) {}

  write(widgetExport: WidgetNoteExport, content: string): Promise<{ changed: boolean }> {
    const next = this.pending.then(() => this.writeNow(widgetExport, content));
    this.pending = next.then(() => undefined, () => undefined);
    return next;
  }

  private async writeNow(widgetExport: WidgetNoteExport, content: string): Promise<{ changed: boolean }> {
    const destination = validateWidgetDestination(widgetExport.destination);
    const existing = this.vault.getAbstractFileByPath(destination);
    if (existing !== null && existing !== undefined) {
      if (!(existing instanceof TFile)) throw new WidgetDestinationError("Widget destination is a folder");
      const current = await this.vault.read(existing);
      const ownership = readWidgetOwnership(current);
      if (!ownership || ownership.producer !== WIDGET_PRODUCER || ownership.version !== WIDGET_VERSION) {
        throw new WidgetDestinationError("Widget destination is not owned by Morning OS");
      }
      if (ownership.exportId !== widgetExport.id) throw new WidgetDestinationError("Widget destination belongs to a different export");
      if (widgetNotesSemanticallyEqual(current, content)) return { changed: false };
      await this.vault.modify(existing, content);
      return { changed: true };
    }
    await this.ensureFolders(destination);
    await this.vault.create(destination, content);
    return { changed: true };
  }

  private async ensureFolders(destination: string): Promise<void> {
    const parts = destination.split("/");
    parts.pop();
    let path = "";
    for (const part of parts) {
      path = path ? `${path}/${part}` : part;
      if (this.vault.getAbstractFileByPath(path) === null) await this.vault.createFolder(path);
    }
  }
}
