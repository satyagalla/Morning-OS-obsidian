export type CompletionStatus = "open" | "done" | "dismissed";

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

export interface PillarConfig {
  key: string;
  label: string;
  icon: string;
  tabs: TabConfig[];
  feedToLLM: boolean;  // whether pillar markdown sections feed into LLM context
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
  pillars: string[];
  tags: Record<string, string>;
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
}

export type TaskRegistry = Task[];

export type SuggestionSource =
  | "tasks"
  | "goals"
  | "technical_backlog"
  | "carried_tasks"
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
  technical_tasks?: string[];
  hobby_tasks?: string[];
  suggestions?: Suggestion[];
  wins?: string[];
}
