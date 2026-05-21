export interface Task {
  text: string;
  carried_from: string | null;
}

export interface Suggestion {
  text: string;
  source: string;
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
    red_alert: Task[];
    regular: Task[];
  };
  tactical_rules: string[];
  technical_tasks: string[];
  hobby_tasks: string[];
  suggestions: Suggestion[];
  wins: string[];
}
