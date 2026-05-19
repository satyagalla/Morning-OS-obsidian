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
  hobby_tasks: string[];
  suggestion: Suggestion | null;
  wins: string[];
}
