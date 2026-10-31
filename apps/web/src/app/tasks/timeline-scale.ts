import { addDays, dayKeyOf, dayKeyToLabel, PhaseKind, startOfDay, TimelineRow, toWallTime } from '@tasks/core';

/**
 * The timeline's stretched axis. Time runs left to right, but every event (created, started,
 * paused, completed) and every piece of work gets at least an icon's width, so things that happened
 * minutes apart still show apart and in order. The rest of the length is shared linearly by time;
 * the zoom sets the total length.
 */

/** Width of an event bead, and the least a piece of work gets */
export const BEAD = 22;
/** Room at both ends for the caps */
const PAD = 14;
/** The swelling from the line into a bead, at most; below the least it would look like a glitch */
const CAP = 10;
const MIN_CAP = 5;

export type EventKind = 'created' | 'started' | 'resumed' | 'paused' | 'completed';

export interface RowItem {
  kind: 'event' | 'piece' | 'line';
  type: EventKind | PhaseKind;
  start: number;
  end: number;
  approximate: boolean;
}

/**
 * How a bead ends on each side: swelling out of a line, a rounded dip where it touches another
 * bead (pill against pill), or a plain pill end where nothing connects.
 */
export type BeadEnd = 'swell' | 'joint' | 'pill';

export interface LaidItem extends RowItem {
  /** Whole pixels, so shapes and lines line up */
  x: number;
  width: number;
  capLeft: number;
  capRight: number;
  left: BeadEnd;
  right: BeadEnd;
  /** The bead's outline (body and swellings in one path), from x - capLeft; '' for lines */
  path: string;
}

/** A check-in, as a little flag behind the beads */
export interface LaidFlag {
  x: number;
  at: number;
  progress: number;
  note: string;
}

const HEIGHT = 16;

export interface Scale {
  width: number;
  /** Where the moment's slot begins (its events sit in the slot) */
  slotStart(moment: number): number;
  /** Any moment on the axis */
  x(moment: number): number;
  from: number;
  to: number;
}

export interface Tick {
  at: number;
  x: number;
  label: string;
}

export const ITEM_STYLE: Record<EventKind | PhaseKind, { label: string; icon: string; color: string }> = {
  created: { label: 'Created', icon: 'add', color: '#ff4fb8' },
  started: { label: 'Started', icon: 'play_arrow', color: '#00e5ff' },
  resumed: { label: 'Resumed', icon: 'play_arrow', color: '#00e5ff' },
  paused: { label: 'Paused', icon: 'pause', color: '#b388ff' },
  completed: { label: 'Completed', icon: 'check', color: '#00e676' },
  active: { label: 'Working on it', icon: 'timelapse', color: '#ffe600' },
  subtask: { label: 'On a subtask', icon: 'subdirectory_arrow_right', color: '#ff9100' },
  new: { label: 'Not started', icon: '', color: '#ff4fb8' },
};

/** A todo's life as events, pieces of work and lines (paused, not started), in time order */
export function rowItems(row: TimelineRow): RowItem[] {
  const items: RowItem[] = [{ kind: 'event', type: 'created', start: row.created, end: row.created, approximate: false }];
  let started = false;
  row.phases.forEach((phase, index) => {
    const before = row.phases[index - 1];
    const after = row.phases[index + 1];
    const timed = phase.kind === 'active' && !phase.approximate;
    if (timed && before?.kind !== 'active') {
      items.push({ kind: 'event', type: started ? 'resumed' : 'started', start: phase.start, end: phase.start, approximate: false });
    }
    if (phase.kind === 'active' || phase.kind === 'subtask') started = true;
    items.push({
      kind: phase.kind === 'active' || phase.kind === 'subtask' ? 'piece' : 'line',
      type: phase.kind,
      start: phase.start,
      end: phase.end,
      approximate: phase.approximate,
    });
    // A closed session followed by something else (not a completion, not "still running")
    if (timed && after != null && after.kind !== 'active') {
      items.push({ kind: 'event', type: 'paused', start: phase.end, end: phase.end, approximate: false });
    }
  });
  if (row.completed != null) {
    items.push({ kind: 'event', type: 'completed', start: row.completed, end: row.completed, approximate: false });
  }
  const rank = (item: RowItem) => (item.kind === 'event' ? (item.type === 'created' ? 0 : item.type === 'completed' ? 3 : 1) : 2);
  return items
    .map((item, order) => ({ item, order }))
    .sort((a, b) => a.item.start - b.item.start || rank(a.item) - rank(b.item) || a.order - b.order)
    .map(entry => entry.item);
}

/**
 * The axis for these rows, aiming at `length` pixels: every moment with events gets a slot wide
 * enough for the most events any row has there; every span inside a piece of work gets its share of
 * a bead's width; the rest of the length goes linearly by time.
 */
export function buildScale(rows: RowItem[][], from: number, to: number, length: number): Scale {
  const clamp = (moment: number) => Math.min(to, Math.max(from, moment));
  const points = new Set<number>([from, to]);
  const events = new Map<number, number>();
  for (const items of rows) {
    const here = new Map<number, number>();
    for (const item of items) {
      points.add(clamp(item.start));
      points.add(clamp(item.end));
      if (item.kind === 'event') here.set(clamp(item.start), (here.get(clamp(item.start)) ?? 0) + 1);
    }
    for (const [moment, count] of here) events.set(moment, Math.max(events.get(moment) ?? 0, count));
  }
  const times = [...points].sort((a, b) => a - b);
  const index = new Map(times.map((moment, position) => [moment, position]));
  const slots = times.map(moment => (events.get(moment) ?? 0) * BEAD);
  const durations = times.slice(0, -1).map((moment, position) => times[position + 1] - moment);
  const least = durations.map(() => 0);
  for (const items of rows) {
    for (const item of items) {
      if (item.kind !== 'piece') continue;
      const first = index.get(clamp(item.start))!;
      const last = index.get(clamp(item.end))!;
      const spans = Math.max(1, last - first);
      for (let position = first; position < last; position++) least[position] = Math.max(least[position], BEAD / spans);
    }
  }
  const fixed = slots.reduce((sum, value) => sum + value, 0) + 2 * PAD;
  const widths = stretch(durations, least, Math.max(0, length - fixed));

  const starts: number[] = [];
  let cursor = PAD;
  times.forEach((_, position) => {
    starts.push(cursor);
    cursor += slots[position] + (widths[position] ?? 0);
  });
  const width = cursor + PAD;

  const slotStart = (moment: number) => starts[index.get(clamp(moment)) ?? 0];
  const x = (moment: number) => {
    const target = clamp(moment);
    let low = 0;
    let high = times.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (times[middle] <= target) low = middle;
      else high = middle - 1;
    }
    const after = starts[low] + slots[low];
    return low >= durations.length || durations[low] === 0 ? after : after + ((target - times[low]) / durations[low]) * widths[low];
  };
  return { width, slotStart, x, from, to };
}

/** Linear widths for `durations` filling `room`, but none below its `least` */
function stretch(durations: number[], least: number[], room: number): number[] {
  const total = durations.reduce((sum, value) => sum + value, 0);
  const minimum = least.reduce((sum, value) => sum + value, 0);
  if (total === 0 || minimum >= room) return least;
  const fill = (scale: number) => durations.reduce((sum, duration, position) => sum + Math.max(least[position], duration * scale), 0);
  let low = 0;
  let high = room / total;
  for (let step = 0; step < 50; step++) {
    const middle = (low + high) / 2;
    if (fill(middle) < room) low = middle;
    else high = middle;
  }
  return durations.map((duration, position) => Math.max(least[position], duration * high));
}

/** Pixel positions of a row's items on the scale, with their ends and outlines */
export function layoutRow(items: RowItem[], scale: Scale): LaidItem[] {
  const used = new Map<number, number>();
  const blank = { capLeft: 0, capRight: 0, left: 'pill' as BeadEnd, right: 'pill' as BeadEnd, path: '' };
  const laid: LaidItem[] = items
    .filter(item => item.end >= scale.from && item.start <= scale.to)
    .map(item => {
      if (item.kind === 'event') {
        const slot = used.get(item.start) ?? 0;
        used.set(item.start, slot + 1);
        const x = Math.round(scale.slotStart(item.start) + slot * BEAD);
        return { ...item, ...blank, x, width: BEAD };
      }
      const x = Math.round(scale.slotStart(item.start) + (used.get(item.start) ?? 0) * BEAD);
      return { ...item, ...blank, x, width: Math.max(0, Math.round(scale.slotStart(item.end)) - x) };
    })
    .filter(item => item.kind !== 'line' || item.width > 0);
  const bead = (item: LaidItem | undefined) => item != null && item.kind !== 'line';
  laid.forEach((item, position) => {
    if (!bead(item)) return;
    const before = laid[position - 1];
    const after = laid[position + 1];
    // Free room on each side, shared with whatever is at the other end of the line
    const roomLeft = before == null ? Infinity : bead(before) ? item.x - (before.x + before.width) : item.x - before.x;
    const roomRight = after == null ? Infinity : bead(after) ? after.x - (item.x + item.width) : after.x + after.width - (item.x + item.width);
    [item.left, item.capLeft] = end(before, roomLeft);
    [item.right, item.capRight] = end(after, roomRight);
    item.path = outline(item);
  });
  return laid;
}

/**
 * How a bead meets its neighbour. Every bead is a full pill, so it looks the same from both sides;
 * out of a line, a neck flares from the line into the pill's round end (a snake that ate an
 * elephant); touching pills (or almost) simply dip into each other.
 */
function end(neighbour: LaidItem | undefined, room: number): [BeadEnd, number] {
  if (neighbour == null) return ['pill', 0];
  if (neighbour.kind === 'line' && room >= 2 * MIN_CAP) return ['swell', Math.floor(Math.min(CAP, room / 2))];
  // Touching, or only a sliver of line between: the rounded dip of two pills
  return ['joint', 0];
}

/** The pill, plus a neck on each side that comes out of a line; in a box from x - capLeft, HEIGHT tall */
function outline(item: LaidItem): string {
  const { capLeft: l, capRight: n, width: w } = item;
  const h = HEIGHT;
  const c = h / 2;
  const t = 1; // half the line's thickness
  const r = Math.min(c, w / 2);
  const right = l + w;
  const parts = [`M${l + r},0 L${right - r},0 A${r},${c} 0 0 1 ${right - r},${h} L${l + r},${h} A${r},${c} 0 0 1 ${l + r},0 Z`];
  // The neck leaves the line flat and joins the round end tangentially, 35° above and below its
  // tip; it closes through the pill's centre, so the two shapes add up seamlessly
  const angle = (35 * Math.PI) / 180;
  const dx = r * (1 - Math.cos(angle));
  const dy = c * Math.sin(angle);
  const tx = 0.6 * r * Math.sin(angle);
  const ty = 0.6 * c * Math.cos(angle);
  if (item.left === 'swell') {
    const x = l + dx;
    parts.push(
      `M0,${c - t} C${l * 0.5},${c - t} ${x - tx},${c - dy + ty} ${x},${c - dy} ` +
        `L${l + r},${c} L${x},${c + dy} C${x - tx},${c + dy - ty} ${l * 0.5},${c + t} 0,${c + t} Z`,
    );
  }
  if (item.right === 'swell') {
    const x = right - dx;
    const end = right + n;
    // Clockwise like the pill, so the overlap adds up instead of cancelling out
    parts.push(
      `M${end},${c + t} C${end - n * 0.5},${c + t} ${x + tx},${c + dy - ty} ${x},${c + dy} ` +
        `L${right - r},${c} L${x},${c - dy} C${x + tx},${c - dy + ty} ${end - n * 0.5},${c - t} ${end},${c - t} Z`,
    );
  }
  return parts.join(' ');
}

/** Check-ins of these todos inside the axis, as flags */
export function layoutFlags(checkins: { at: number; progress: number; note: string }[], scale: Scale): LaidFlag[] {
  return checkins
    .filter(checkin => checkin.at >= scale.from && checkin.at <= scale.to)
    .map(checkin => ({ ...checkin, x: Math.round(scale.x(checkin.at)) }));
}

/** Day starts first, then noon, every 6, 3 and 1 hours, wherever there is room for a label */
export function ticksOf(scale: Scale, timezone: string): Tick[] {
  const HOUR = 3600000;
  const kept: Tick[] = [];
  const room = 64;
  const fits = (x: number) => kept.every(tick => Math.abs(tick.x - x) >= room);
  const days: string[] = [];
  for (let day = dayKeyOf(scale.from, timezone); startOfDay(day, timezone) <= scale.to; day = addDays(day, 1)) days.push(day);
  for (const step of [24, 12, 6, 3, 1]) {
    for (const day of days) {
      for (let hour = 0; hour < 24; hour += step) {
        const at = startOfDay(day, timezone) + hour * HOUR;
        if (at < scale.from || at > scale.to || kept.some(tick => tick.at === at)) continue;
        const x = scale.x(at);
        if (!fits(x)) continue;
        const wall = toWallTime(at, timezone);
        const label = wall.hour === 0 ? dayKeyToLabel(day, 'short') : `${wall.hour % 12 === 0 ? 12 : wall.hour % 12} ${wall.hour >= 12 ? 'PM' : 'AM'}`;
        kept.push({ at, x, label });
      }
    }
  }
  kept.sort((a, b) => a.at - b.at);
  // The first label says which day it is
  if (kept.length > 0 && toWallTime(kept[0].at, timezone).hour !== 0) {
    kept[0] = { ...kept[0], label: `${dayKeyToLabel(dayKeyOf(kept[0].at, timezone), 'short')} ${kept[0].label}` };
  }
  return kept;
}

export const LEGEND_DAY_TOTAL = { label: 'Logged as a day total', items: [legendBead('active', true)] };

/** Legend entries, laid out like a tiny lane: [key, items] */
export const LEGEND: { label: string; items: LaidItem[] }[] = [
  ...(['created', 'started', 'active', 'subtask', 'paused', 'completed'] as const).map(type => ({
    label: type === 'started' ? 'Started / resumed' : type === 'paused' ? 'Paused (moment)' : ITEM_STYLE[type].label,
    items: [legendBead(type, false)],
  })),
  { label: 'Paused (time)', items: [legendLine('paused')] },
  { label: 'Not started', items: [legendLine('new')] },
];

function legendBead(type: EventKind | PhaseKind, approximate: boolean): LaidItem {
  const kind = type === 'active' || type === 'subtask' ? 'piece' : 'event';
  const item: LaidItem = { kind, type, start: 0, end: 0, approximate, x: 17, width: BEAD, capLeft: CAP, capRight: CAP, left: 'swell', right: 'swell', path: '' };
  item.path = outline(item);
  return item;
}

function legendLine(type: PhaseKind): LaidItem {
  return { kind: 'line', type, start: 0, end: 0, approximate: false, x: 6, width: 44, capLeft: 0, capRight: 0, left: 'pill', right: 'pill', path: '' };
}
