export interface BriefTask {
  text: string;
  carried_from: string | null;
  id?: string;
}

export interface Task {
  id: string;
  text: string;
  done: boolean;
  created: string;
  modified: string;
  completed: string | null;
  priority: "red" | "regular";
  urgency: "low" | "med" | "high" | "none";
  pillars: string[];
  tags: Record<string, string>;
  in_today: boolean;
  remind_date: string | null;
  deleted_from: string[];
  deleted: boolean;
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

export interface Reminder {
  text: string;
  source_date: string;
  remind_date: string;
}

export interface DailyBrief {
  date: string;
  meta: {
    goals: {
      short_term_count: number;
      long_term_count: number;
    };
  };
  identity: {
    rules: string[];
  };
  goals: {
    short_term: string[];
    long_term: string[];
  };
  tasks: {
    red_alert: BriefTask[];
    regular: BriefTask[];
    completed_red_alert: string[];
    completed_regular: string[];
  };
  tactical_rules: string[];
  technical_tasks: string[];
  hobby_tasks: string[];
  suggestions: Suggestion[];
  wins: string[];
  reminders?: Reminder[];
}
