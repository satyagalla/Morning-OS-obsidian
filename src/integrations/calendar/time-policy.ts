export type ReminderAmbiguity = "none" | "earlier";

export interface ReminderWindow {
  start: string;
  end: string;
  missed: boolean;
  ambiguity: ReminderAmbiguity;
}

interface WallTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const EVENT_DURATION_MS = 15 * 60_000;

function parseWallTime(date: string, time: string): WallTime {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(time);
  if (!dateMatch || !timeMatch) throw new Error("Invalid reminder date or time.");
  const value = {
    year: Number(dateMatch[1]), month: Number(dateMatch[2]), day: Number(dateMatch[3]),
    hour: Number(timeMatch[1]), minute: Number(timeMatch[2]),
  };
  const check = new Date(Date.UTC(value.year, value.month - 1, value.day));
  if (value.year < 1 || value.month < 1 || value.month > 12 || value.day < 1 ||
      check.getUTCFullYear() !== value.year || check.getUTCMonth() + 1 !== value.month || check.getUTCDate() !== value.day ||
      value.hour > 23 || value.minute > 59) {
    throw new Error("Invalid reminder date or time.");
  }
  return value;
}

function formatter(timeZone: string): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone, calendar: "gregory", numberingSystem: "latn", hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
  } catch {
    throw new Error("Invalid reminder time zone.");
  }
}

function partsAt(format: Intl.DateTimeFormat, instant: number): WallTime & { second: number } {
  const values: Record<string, number> = {};
  for (const part of format.formatToParts(new Date(instant))) {
    if (["year", "month", "day", "hour", "minute", "second"].includes(part.type)) values[part.type] = Number(part.value);
  }
  if (["year", "month", "day", "hour", "minute", "second"].some(key => !Number.isInteger(values[key]))) {
    throw new Error("Reminder time zone could not be resolved.");
  }
  return values as unknown as WallTime & { second: number };
}

function sameWallTime(left: WallTime, right: WallTime & { second: number }): boolean {
  return left.year === right.year && left.month === right.month && left.day === right.day &&
    left.hour === right.hour && left.minute === right.minute && right.second === 0;
}

function localEpoch(parts: WallTime & { second?: number }): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second ?? 0);
}

function offsetAt(format: Intl.DateTimeFormat, instant: number): number {
  return localEpoch(partsAt(format, instant)) - instant;
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, "0");
}

function rfc3339(format: Intl.DateTimeFormat, instant: number): string {
  const parts = partsAt(format, instant);
  const offsetMinutes = Math.round(offsetAt(format, instant) / 60_000);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  return `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}` +
    `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

/** Resolve an explicit wall time without depending on the device's current zone.
 * Offset candidates are sampled around the target because IANA transitions may
 * make a local minute absent or map it to two instants. */
export function resolveReminderWindow(date: string, time: string, timeZone: string, nowMs: number): ReminderWindow {
  if (!Number.isFinite(nowMs)) throw new Error("Invalid current time.");
  const wall = parseWallTime(date, time);
  const format = formatter(timeZone);
  const naive = localEpoch(wall);
  const offsets = new Set<number>();
  for (let delta = -36; delta <= 36; delta += 3) offsets.add(offsetAt(format, naive + delta * 60 * 60_000));
  const candidates = [...offsets]
    .map(offset => naive - offset)
    .filter((instant, index, values) => values.indexOf(instant) === index && sameWallTime(wall, partsAt(format, instant)))
    .sort((left, right) => left - right);
  if (candidates.length === 0) throw new Error("Reminder time does not exist in this time zone.");
  const startMs = candidates[0];
  const endMs = startMs + EVENT_DURATION_MS;
  return {
    start: rfc3339(format, startMs),
    end: rfc3339(format, endMs),
    missed: startMs <= nowMs,
    ambiguity: candidates.length > 1 ? "earlier" : "none",
  };
}
