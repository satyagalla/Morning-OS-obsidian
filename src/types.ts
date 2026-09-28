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

/**
 * A durable desired calendar transition. These records are vault state, never
 * credentials: they let a publisher replay A -> B -> C after an interrupted
 * request without guessing which device wrote most recently.
 */
export interface CalendarReminderMutation {
  id: string;
  predecessorId: string | null;
  active: boolean;
  title: string;
  date: string | null;
  time: string;
  timeZone: string;
  /** Durable publication outcome. A missing record means it has never been dispatched. */
  delivery?: CalendarMutationDelivery;
}

export type CalendarDeliveryStatus =
  | "dispatching"
  | "confirmed"
  | "conflict"
  | "missed"
  | "retryable"
  | "unknown"
  | "auth-required"
  | "permission-denied";

export interface CalendarMutationDelivery {
  status: CalendarDeliveryStatus;
  attempts: number;
  updatedAt: string;
  reason?: string;
  eventId?: string;
  etag?: string;
  retryAt?: string;
}

export interface CalendarReminderHistory {
  /** The protocol version is deliberately separate from the state version. */
  version: 1;
  /** Flipped and verified before the first provider POST, including a fence. */
  providerAttempted: boolean;
  /** Mutations are ordered by explicit predecessor links, never wall time. */
  mutations: CalendarReminderMutation[];
}

export interface CalendarIntegrationState {
  version: 1;
  protocolVersion: 1;
  provider: "google";
  integrationId: string;
  ownershipToken: string;
  /** Experimental safety boundary: only the matching device may publish. */
  publisherDeviceId: string;
  enabled: boolean;
  defaultTime: string;
  timeZone: string;
  calendar: {
    status: "unconfigured" | "creating" | "unknown" | "ready" | "conflict";
    attemptId?: string;
    id?: string;
    summary?: string;
    confirmed: boolean;
    reason?: string;
  };
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
  /** Optional wall time/zone. Null/omitted uses the committed integration policy. */
  reminder_time?: string | null;
  reminder_time_zone?: string | null;
  parent_id: string | null;
  /** New records use this explicitly; omitted legacy records are normalized to Tasks. */
  kind: ItemKind;
  /** Notes use their own lifecycle without reinterpreting Task completion data. */
  status_note?: NoteStatus;
  /** Details is the new name for legacy `notes`; both are retained for compatibility. */
  details?: string;
  reminder_occurrence?: ReminderOccurrence | null;
  /** Syncable calendar intent and causal history. It contains no credentials. */
  calendar_reminder?: CalendarReminderHistory | null;
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
