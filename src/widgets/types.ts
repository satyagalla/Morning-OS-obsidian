import type { DailyBrief, Task, TaskRegistry } from "../types";

export type WidgetSource = "identity" | "goals-short" | "goals-long" | "today-tasks" | "inbox-tasks" | "all-tasks";

export interface WidgetNoteExport {
  id: string;
  enabled: boolean;
  source: WidgetSource;
  destination: string;
  limit: number;
}

export interface WidgetSelectionInput {
  registry: TaskRegistry;
  brief?: DailyBrief | null;
  /** Current identity rules may be supplied before a brief has been persisted. */
  identityLines?: string[];
  source: WidgetSource;
  limit: number;
}

export interface WidgetTaskEntry {
  task: Task;
  /** Present for a Today task independently selected beneath an unselected root. */
  parentContext?: Task | null;
}

export interface WidgetSelection {
  source: WidgetSource;
  lines: string[];
  tasks: WidgetTaskEntry[];
  unavailable: boolean;
}

export interface WidgetRenderInput {
  export: WidgetNoteExport;
  selection: WidgetSelection;
  /** A locally formatted value supplied by the caller, never generated in this module. */
  updatedAt: string;
}

export interface WidgetOwnership {
  producer: string;
  version: number;
  exportId: string;
}
