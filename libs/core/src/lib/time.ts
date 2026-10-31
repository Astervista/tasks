/**
 * Time helpers. Moments are epoch milliseconds; everything human-facing (the Markdown file, day
 * boundaries for statistics) is expressed as wall-clock time in the workspace's IANA timezone, so a
 * server running in UTC and a laptop in Europe/Rome agree on what "today" and "09:30" mean.
 */

export type Millis = number;

/** "YYYY-MM-DD" */
export type DayKey = string;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let result = formatters.get(timeZone);
  if (result == null) {
    result = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, result);
  }
  return result;
}

export interface WallTime {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

export function toWallTime(moment: Millis, timeZone: string): WallTime {
  const parts: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(moment))) {
    if (part.type !== 'literal') {
      parts[part.type] = Number(part.value);
    }
  }
  return {
    year: parts['year'],
    month: parts['month'],
    day: parts['day'],
    hour: parts['hour'],
    minute: parts['minute'],
    second: parts['second'],
  };
}

function offsetAt(moment: Millis, timeZone: string): Millis {
  const wall = toWallTime(moment, timeZone);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return asUtc - Math.floor(moment / 1000) * 1000;
}

/**
 * Converts a wall-clock time in `timeZone` to a moment. Times skipped by a DST jump resolve to the
 * moment after the jump; repeated times resolve to the first occurrence.
 */
export function fromWallTime(wall: WallTime, timeZone: string): Millis {
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  // The offsets in effect a day before and a day after cover both sides of any DST transition
  const candidates = [asUtc - offsetAt(asUtc - DAY, timeZone), asUtc - offsetAt(asUtc + DAY, timeZone)];
  const valid = candidates.filter(candidate => sameWallTime(toWallTime(candidate, timeZone), wall));
  return valid.length > 0 ? Math.min(...valid) : Math.max(...candidates);
}

const DAY = 24 * 60 * 60 * 1000;

function sameWallTime(a: WallTime, b: WallTime): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day
    && a.hour === b.hour && a.minute === b.minute && a.second === b.second;
}

const pad = (value: number) => String(value).padStart(2, '0');

export function dayKeyOf(moment: Millis, timeZone: string): DayKey {
  const wall = toWallTime(moment, timeZone);
  return `${wall.year}-${pad(wall.month)}-${pad(wall.day)}`;
}

export function parseDayKey(key: DayKey): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (match == null) {
    return null;
  }
  const [year, month, day] = match.slice(1).map(Number);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    return null;
  }
  return { year, month, day };
}

/** Adds calendar days to a day key (timezone-independent) */
export function addDays(key: DayKey, days: number): DayKey {
  const parsed = parseDayKey(key);
  if (parsed == null) {
    throw new Error(`Invalid day ${key}`);
  }
  const date = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day + days));
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** 0 = Monday … 6 = Sunday */
export function weekdayOf(key: DayKey): number {
  const parsed = parseDayKey(key);
  if (parsed == null) {
    throw new Error(`Invalid day ${key}`);
  }
  return (new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day)).getUTCDay() + 6) % 7;
}

export function startOfDay(key: DayKey, timeZone: string): Millis {
  const parsed = parseDayKey(key);
  if (parsed == null) {
    throw new Error(`Invalid day ${key}`);
  }
  return fromWallTime({ ...parsed, hour: 0, minute: 0, second: 0 }, timeZone);
}

/**
 * Splits [start, end) on the timezone's midnights. Walks real calendar days, so DST days (23 h / 25 h)
 * are measured correctly.
 */
export function splitByDay(start: Millis, end: Millis, timeZone: string): Map<DayKey, Millis> {
  const result = new Map<DayKey, Millis>();
  let cursor = start;
  while (cursor < end) {
    const key = dayKeyOf(cursor, timeZone);
    const nextMidnight = startOfDay(addDays(key, 1), timeZone);
    const segmentEnd = Math.min(nextMidnight, end);
    result.set(key, (result.get(key) ?? 0) + (segmentEnd - cursor));
    cursor = segmentEnd;
  }
  return result;
}

/** "YYYY-MM-DD HH:mm:ss" in the given timezone */
export function formatStamp(moment: Millis, timeZone: string): string {
  const wall = toWallTime(moment, timeZone);
  return `${wall.year}-${pad(wall.month)}-${pad(wall.day)} ${pad(wall.hour)}:${pad(wall.minute)}:${pad(wall.second)}`;
}

/** "HH:mm:ss" in the given timezone */
export function formatClock(moment: Millis, timeZone: string): string {
  const wall = toWallTime(moment, timeZone);
  return `${pad(wall.hour)}:${pad(wall.minute)}:${pad(wall.second)}`;
}

/** Parses "YYYY-MM-DD HH:mm[:ss]" (or with a "T") as wall time in `timeZone` */
export function parseStamp(text: string, timeZone: string): Millis | null {
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text.trim());
  if (match == null) {
    return null;
  }
  const day = parseDayKey(match[1]);
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  const second = Number(match[4] ?? 0);
  if (day == null || hour > 23 || minute > 59 || second > 59) {
    return null;
  }
  return fromWallTime({ ...day, hour, minute, second }, timeZone);
}

/** Parses "HH:mm[:ss]" on the day of `reference` */
export function parseClock(text: string, reference: Millis, timeZone: string): Millis | null {
  return parseStamp(`${dayKeyOf(reference, timeZone)} ${text.trim()}`, timeZone);
}

/** "2h 20m", "45m", "1h", "30s"; minutes are rounded to the second */
export function formatDuration(minutes: number): string {
  const totalSeconds = Math.round(minutes * 60);
  const hours = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pieces: string[] = [];
  if (hours !== 0) {
    pieces.push(`${hours}h`);
  }
  if (mins !== 0) {
    pieces.push(`${mins}m`);
  }
  if (seconds !== 0) {
    pieces.push(`${seconds}s`);
  }
  return pieces.length === 0 ? '0m' : pieces.join(' ');
}

/** Parses "2h 20m", "1.5h", "90m", "30s", "2h20m"; returns minutes */
export function parseDuration(text: string): number | null {
  const compact = text.trim().toLowerCase();
  if (compact === '') {
    return null;
  }
  const pattern = /(\d+(?:\.\d+)?)\s*(h|m|s)\s*/y;
  let minutes = 0;
  let consumed = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(compact)) != null) {
    const value = Number(match[1]);
    minutes += match[2] === 'h' ? value * 60 : match[2] === 'm' ? value : value / 60;
    consumed = pattern.lastIndex;
  }
  return consumed === compact.length ? minutes : null;
}

/** Orders moments with missing ones first (like an empty column sorting to the top) */
export function compareMoments(a: Millis | null, b: Millis | null): number {
  if (a == null || b == null) {
    return a == null ? (b == null ? 0 : -1) : 1;
  }
  return a - b;
}
