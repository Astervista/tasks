/** Display formatting used by the UIs (the file format has its own, in markdown.ts) */
import { Millis, toWallTime } from './time';

/** "1 h 20 min", "45 min 10 s" (seconds only when asked), "0 min" */
export function formatMinutes(minutes: number, showSeconds = false): string {
  const totalSeconds = Math.floor(minutes * 60);
  const hours = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pieces: string[] = [];
  if (hours !== 0) {
    pieces.push(`${hours} h`);
  }
  if (mins !== 0) {
    pieces.push(`${mins} min`);
  }
  if (showSeconds && seconds !== 0) {
    pieces.push(`${seconds} s`);
  }
  return pieces.length === 0 ? '0 min' : pieces.join(' ');
}

/** "2021-11-24 05:37:44 PM": the classic look of the task list, in the workspace timezone */
export function formatDisplayDate(moment: Millis, timeZone: string): string {
  const wall = toWallTime(moment, timeZone);
  const pad = (value: number) => String(value).padStart(2, '0');
  const hour12 = wall.hour % 12 === 0 ? 12 : wall.hour % 12;
  return `${wall.year}-${pad(wall.month)}-${pad(wall.day)} ${pad(hour12)}:${pad(wall.minute)}:${pad(wall.second)} ${wall.hour >= 12 ? 'PM' : 'AM'}`;
}

/** "Thu, 29 Oct · 5:37 PM", in the workspace timezone; the year only when it is not the current one */
export function formatMoment(moment: Millis, timeZone: string, now: Millis = Date.now()): string {
  const wall = toWallTime(moment, timeZone);
  const pad = (value: number) => String(value).padStart(2, '0');
  const key = `${wall.year}-${pad(wall.month)}-${pad(wall.day)}`;
  const year = wall.year !== toWallTime(now, timeZone).year ? ` ${wall.year}` : '';
  const hour12 = wall.hour % 12 === 0 ? 12 : wall.hour % 12;
  return `${dayKeyToLabel(key, 'medium')}${year} · ${hour12}:${pad(wall.minute)} ${wall.hour >= 12 ? 'PM' : 'AM'}`;
}

/** "Mon 27" (short), "Mon 27 Oct" (medium) or "Monday, 27 October 2026" (long), in the viewer's language */
export function dayKeyToLabel(key: string, style: 'short' | 'medium' | 'long'): string {
  const [year, month, day] = key.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  switch (style) {
    case 'short':
      return `${date.toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' })} ${day}`;
    case 'medium':
      return date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
    case 'long':
      return date.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  }
}
