import { widgetSourceTitle } from "./selection";
import type { WidgetOwnership, WidgetRenderInput } from "./types";

export const WIDGET_PRODUCER = "morning-os";
export const WIDGET_VERSION = 1;

function yamlValue(value: string): string {
  return JSON.stringify(value);
}

function taskLine(text: string): string {
  return `- [ ] ${text.replace(/\r?\n/g, " ")}`;
}

export function renderWidgetNote(input: WidgetRenderInput): string {
  const { export: widgetExport, selection, updatedAt } = input;
  const output = [
    "---",
    "morning-os-widget:",
    `  producer: ${WIDGET_PRODUCER}`,
    `  version: ${WIDGET_VERSION}`,
    `  export-id: ${yamlValue(widgetExport.id)}`,
    "---",
    "",
    `# ${widgetSourceTitle(widgetExport.source)}`,
    "",
  ];
  if (selection.unavailable) output.push("Morning OS briefing content is unavailable.");
  else if (selection.tasks.length > 0) {
    let lastContext: string | null | undefined;
    for (const entry of selection.tasks) {
      const contextId = entry.parentContext?._id ?? (entry.parentContext === null ? "missing" : undefined);
      if (contextId !== undefined && contextId !== lastContext) {
        output.push(`> Context: ${entry.parentContext?.text ?? "Missing or deleted parent"}`, "");
        lastContext = contextId;
      }
      output.push(taskLine(entry.task.text));
    }
  } else if (selection.lines.length > 0) {
    for (const line of selection.lines) output.push(`- ${line}`);
  } else output.push("No content is available yet.");
  output.push("", `_Updated at: ${updatedAt}_`, "");
  return output.join("\n");
}

export function readWidgetOwnership(content: string): WidgetOwnership | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return null;
  const owner = match[1].match(/^morning-os-widget:\r?\n\s{2}producer:\s*(\S+)\r?\n\s{2}version:\s*(\d+)\r?\n\s{2}export-id:\s*(?:"([^"]*)"|'([^']*)'|(\S+))\s*$/m);
  if (!owner) return null;
  return { producer: owner[1], version: Number(owner[2]), exportId: owner[3] ?? owner[4] ?? owner[5] };
}

export function widgetNotesSemanticallyEqual(left: string, right: string): boolean {
  const withoutTimestamp = (content: string): string => content
    .replace(/\r\n/g, "\n")
    .replace(/^_Updated at: .*_\n?/m, "")
    .trimEnd();
  return withoutTimestamp(left) === withoutTimestamp(right);
}
