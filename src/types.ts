export type CompletionStatus = "open" | "done" | "dismissed";
export type ItemKind = "task" | "note";
export type NoteStatus = "active" | "archived";
export type TodayPriority = "red" | "regular";
export type MetadataValue = string | number | boolean | null | MetadataValue[] | { [key: string]: MetadataValue };

export interface ReminderOccurrence {
  /** Changes whenever a reminder is explicitly set or reset. */
  token: string;
  /** A handled occurrence must not promote the item again. */
  handledToken?: string;
  /** Set only when the user removes a reminder-promoted item from Today. */
  dismissedToken?: string;
}

export interface FieldDef {
  key: string;
  label: string;
  type: "text" | "url" | "dropdown" | "date";
  options?: string[];
}

export interface TabConfig {
  key: string;
  label: string;
  fields: FieldDef[];
  view_mode: "cards" | "table";
}

export interface AreaConfig {
  key: string;
  label: string;
  icon: string;
  tabs: TabConfig[];
  feedToLLM: boolean;  // whether area markdown sections feed into LLM context
}

export interface LLMSectionMapping {
  heading: string;    // e.g. "Tactical Rules", "Short Term"
  target: "tactical_rules" | "emotional_rules" | "goals_short" | "goals_long";
  enabled: boolean;
}

export interface Task {
  _id: string;
  text: string;
  notes: string;
  areas: string[];
  /** Area/tab placement and custom-field values. Values are JSON data so child
   * creation can copy them without sharing mutable references. */
  tags: Record<string, MetadataValue>;
  status_completion: CompletionStatus;
  status_priority: "red" | "regular";
  status_urgency: "none" | "low" | "med" | "high";
  is_today: boolean;
  is_deleted: boolean;
  date_created: string;
  date_modified: string;
  date_completed: string | null;
  date_remind: string | null;
  parent_id: string | null;
  /** New records use this explicitly; omitted legacy records are normalized to Tasks. */
  kind: ItemKind;
  /** Notes use their own lifecycle without reinterpreting Task completion data. */
  status_note?: NoteStatus;
  /** Details is the new name for legacy `notes`; both are retained for compatibility. */
  details?: string;
  reminder_occurrence?: ReminderOccurrence | null;
  deletion_batch_id?: string | null;
  deleted_member_ids?: string[];
  /** Preserves legacy and future fields that this version does not interpret. */
  [key: string]: unknown;
}

export type TaskRegistry = Task[];

export type SuggestionSource =
  | "tasks"
  | "goals"
  | "technical_backlog"
  | "wins";

export interface Suggestion {
  text: string;
  source: SuggestionSource;
}

export interface DailyBrief {
  date: string;
  meta?: {
    goals: {
      short_term_count: number;
      long_term_count: number;
    };
  };
  identity?: {
    rules: string[];
  };
  goals?: {
    short_term: string[];
    long_term: string[];
  };
  tactical_rules?: string[];
  suggestions?: Suggestion[];
  wins?: string[];
}
