/**
 * Estimated time of arrival.
 *
 * Every open leaf todo gets a guess of its total work:
 * - the start guess: its own (optional) `estimate`, else its weight, which is an estimate too: weight ×
 *   the minutes per weight point of the work already done (in the project, else in all projects);
 * - refined by its latest check-in: at progress p after t minutes, the work so far projects to t / p
 *   in total. The two are blended by p, so early reports nudge the guess and late ones decide it.
 * A macrotask's own fields (estimate, weight, time, check-ins) belong to its implicit leaf: the work
 * on the macrotask itself, next to its subtasks. Remaining work sums up through macrotasks (subtasks +
 * implicit leaf); the finish day spreads it over the average daily work of the last two weeks.
 */
import { CheckIn, isSession, ownMinutes, Todo, TodoId, Workspace } from './model';
import { addDays, DayKey, dayKeyOf, Millis } from './time';
import { childrenOf, rollups } from './tree';
import { minutesByDay } from './stats';
import { formatMinutes } from './format';

/** Progress reports below this are too early to project anything */
const MIN_PROGRESS = 0.05;
const PACE_DAYS = 14;
/** Below this much evidence a pace is noise (one short session would project weeks away) */
const MIN_ACTIVE_DAYS = 3;
const MIN_PACE_MINUTES = 120;

export type EtaSource = 'estimate' | 'weight' | 'check-in';

export interface TodoEta {
  /** Guess of the total work, minutes; null when nothing is known */
  total: number | null;
  /** Logged so far, minutes */
  spent: number;
  /** Still to do, minutes; 0 when done */
  remaining: number | null;
  /** Latest reported progress, 0 … 1 */
  progress: number | null;
  source: EtaSource | null;
  /** Spent more than the guess: the guess was too low */
  over: boolean;
}

export interface ProjectEta {
  /** Remaining work of the open leaves that have a guess, minutes */
  remaining: number;
  /** Open leaves (implicit ones included) with no guess at all (no estimate, no weight history, no check-in) */
  unknown: number;
  /** Average work per calendar day recently, minutes; null until there is enough history */
  pace: number | null;
  /** Days with logged work in the pace window, to explain a missing pace */
  activeDays: number;
  /** Expected finish day, when there is a pace and nothing unknown */
  finish: DayKey | null;
}

export interface Pace {
  /** Minutes per calendar day; null when there is too little history to trust */
  perDay: number | null;
  activeDays: number;
  minutes: number;
}

/**
 * Finished todos with logged time of their own: the evidence for how long things take. A finished
 * macrotask counts as its implicit leaf (its own weight against its own time).
 */
export function finishedWork(todos: Todo[], now: Millis): { todo: Todo; minutes: number }[] {
  return todos
    .filter(todo => todo.completed != null)
    .map(todo => ({ todo, minutes: ownMinutes(todo, now) }))
    .filter(item => item.minutes > 0);
}

/** Minutes per weight point of the finished work (the velocity) */
export function minutesPerWeight(todos: Todo[], now: Millis): number | null {
  let minutes = 0;
  let weight = 0;
  for (const item of finishedWork(todos, now)) {
    minutes += item.minutes;
    weight += item.todo.weight;
  }
  return weight > 0 ? minutes / weight : null;
}

export interface AccuracySample {
  id: TodoId;
  name: string;
  weight: number;
  /** What was predicted: weight × rate, or the explicit estimate */
  predicted: number;
  actual: number;
  /** actual / predicted: 1 = spot on, 2 = took twice as long */
  ratio: number;
}

export interface Accuracy {
  samples: AccuracySample[];
  /** Median of |ratio − 1|: "typically off by ±x" */
  typicalError: number | null;
  /** Middle half of the ratios: "usually between low× and high×" */
  low: number | null;
  high: number | null;
}

/**
 * How good weight is as an estimate: each finished leaf's actual time against weight × `rate`
 * (the rate itself comes from the same todos, so this measures the spread around the average).
 */
export function weightAccuracy(todos: Todo[], rate: number | null, now: Millis): Accuracy {
  if (rate == null || rate <= 0) return accuracy([]);
  return accuracy(finishedWork(todos, now).map(({ todo, minutes }) => sample(todo, todo.weight * rate, minutes)));
}

/** How good the explicit estimates were, for the finished todos that had one */
export function estimateAccuracy(todos: Todo[], now: Millis): Accuracy {
  return accuracy(finishedWork(todos, now)
    .filter(({ todo }) => todo.estimate != null && todo.estimate > 0)
    .map(({ todo, minutes }) => sample(todo, todo.estimate!, minutes)));
}

function sample(todo: Todo, predicted: number, actual: number): AccuracySample {
  return { id: todo.id, name: todo.name, weight: todo.weight, predicted, actual, ratio: actual / predicted };
}

function accuracy(samples: AccuracySample[]): Accuracy {
  if (samples.length === 0) return { samples, typicalError: null, low: null, high: null };
  const ratios = samples.map(item => item.ratio).sort((a, b) => a - b);
  return {
    samples,
    typicalError: quantile(samples.map(item => Math.abs(item.ratio - 1)).sort((a, b) => a - b), 0.5),
    low: quantile(ratios, 0.25),
    high: quantile(ratios, 0.75),
  };
}

/** Linear interpolation on sorted values */
function quantile(sorted: number[], q: number): number {
  const position = (sorted.length - 1) * q;
  const below = Math.floor(position);
  const above = Math.ceil(position);
  return sorted[below] + (sorted[above] - sorted[below]) * (position - below);
}

/** Minutes logged up to `moment` */
function minutesUntil(todo: Todo, moment: Millis, timezone: string): number {
  const day = dayKeyOf(moment, timezone);
  let total = 0;
  for (const entry of todo.time) {
    if (isSession(entry)) {
      total += Math.max(0, Math.min(entry.end ?? moment, moment) - entry.start) / 60000;
    } else if (entry.day <= day) {
      total += entry.minutes;
    }
  }
  return total;
}

export function latestCheckIn(todo: Todo): CheckIn | null {
  return todo.checkins.reduce<CheckIn | null>((latest, checkin) => (latest == null || checkin.at > latest.at ? checkin : latest), null);
}

export function todoEta(todo: Todo, rate: number | null, timezone: string, now: Millis): TodoEta {
  const spent = ownMinutes(todo, now);
  const checkin = latestCheckIn(todo);
  const progress = checkin?.progress ?? null;
  // Weight 0 without an estimate means no work is expected (typical for a macrotask's implicit leaf)
  let total: number | null = todo.estimate ?? (rate != null ? todo.weight * rate : todo.weight === 0 ? 0 : null);
  let source: EtaSource | null = todo.estimate != null ? 'estimate' : total != null ? 'weight' : null;
  if (checkin != null && checkin.progress >= MIN_PROGRESS) {
    const projected = minutesUntil(todo, checkin.at, timezone) / checkin.progress;
    if (projected > 0) {
      total = total == null ? projected : (1 - checkin.progress) * total + checkin.progress * projected;
      source = 'check-in';
    }
  }
  if (todo.completed != null) {
    return { total: total ?? spent, spent, remaining: 0, progress: 1, source, over: false };
  }
  const remaining = total == null ? null : Math.max(0, total - spent);
  return { total, spent, remaining, progress, source, over: total != null && spent > total };
}

export interface TreeEta {
  remaining: number;
  /** Open leaves below (and the implicit leaf, or itself) without a guess */
  unknown: number;
  /** Done share of the guessed work, 0 … 1 */
  progress: number | null;
}

/**
 * ETA of every todo. `own` is the todo's own guess: for a macrotask, its implicit leaf's. The other
 * fields cover the whole subtree, implicit leaves included. `fallbackRate` (minutes per weight point
 * across all projects) is used while the project has no finished work of its own.
 */
export function etas(workspace: Workspace, now: Millis, history: Todo[] = [], fallbackRate: number | null = null): Map<TodoId, TreeEta & { own: TodoEta }> {
  const rate = minutesPerWeight([...workspace.todos, ...history], now) ?? fallbackRate;
  const result = new Map<TodoId, TreeEta & { own: TodoEta }>();
  const roll = rollups(workspace, now);
  for (let i = workspace.todos.length - 1; i >= 0; i--) {
    const todo = workspace.todos[i];
    const own = todoEta(todo, rate, workspace.timezone, now);
    const children = childrenOf(workspace, todo.id).map(child => result.get(child.id)!);
    if (children.length === 0) {
      result.set(todo.id, {
        own,
        remaining: own.remaining ?? 0,
        unknown: own.remaining == null ? 1 : 0,
        progress: own.total == null || own.total === 0 ? (todo.completed != null ? 1 : null) : Math.min(1, own.spent / own.total),
      });
    } else {
      const remaining = (own.remaining ?? 0) + children.reduce((sum, child) => sum + child.remaining, 0);
      const spent = roll.get(todo.id)?.totalMinutes ?? 0;
      result.set(todo.id, {
        own,
        remaining,
        unknown: (own.remaining == null ? 1 : 0) + children.reduce((sum, child) => sum + child.unknown, 0),
        progress: spent + remaining > 0 ? spent / (spent + remaining) : null,
      });
    }
  }
  return result;
}

/**
 * Average minutes worked per calendar day over the last two weeks, counted from the first day with
 * work in that window (a project started two days ago is not seven times slower). Days off in
 * between count, so the pace is real calendar speed. Needs a few days and hours of work to mean
 * anything.
 */
export function dailyPace(todos: Todo[], timezone: string, now: Millis): Pace {
  const today = dayKeyOf(now, timezone);
  const windowStart = addDays(today, -(PACE_DAYS - 1));
  let minutes = 0;
  let firstDay: DayKey | null = null;
  const active = new Set<DayKey>();
  for (const [day, perTodo] of minutesByDay(todos, timezone, now)) {
    if (day < windowStart || day > today) continue;
    const dayMinutes = [...perTodo.values()].reduce((sum, value) => sum + value, 0);
    if (dayMinutes <= 0) continue;
    minutes += dayMinutes;
    active.add(day);
    if (firstDay == null || day < firstDay) firstDay = day;
  }
  if (firstDay == null || active.size < MIN_ACTIVE_DAYS || minutes < MIN_PACE_MINUTES) {
    return { perDay: null, activeDays: active.size, minutes };
  }
  let days = 1;
  while (addDays(firstDay, days - 1) < today) days++;
  return { perDay: minutes / days, activeDays: active.size, minutes };
}

export function projectEta(workspace: Workspace, archive: Workspace | null, now: Millis, fallbackRate: number | null = null): ProjectEta {
  const history = archive?.todos ?? [];
  const all = etas(workspace, now, history, fallbackRate);
  let remaining = 0;
  let unknown = 0;
  for (const todo of childrenOf(workspace, null)) {
    const eta = all.get(todo.id)!;
    remaining += eta.remaining;
    unknown += eta.unknown;
  }
  const pace = dailyPace([...workspace.todos, ...history], workspace.timezone, now);
  const today = dayKeyOf(now, workspace.timezone);
  const finish = remaining === 0 && unknown === 0 ? today
    : pace.perDay == null || unknown > 0 ? null
    : addDays(today, Math.max(0, Math.ceil(remaining / pace.perDay) - 1));
  return { remaining, unknown, pace: pace.perDay, activeDays: pace.activeDays, finish };
}

/** Why there is (or is not) a finish date, for tooltips */
export function paceNote(eta: ProjectEta): string {
  if (eta.pace != null) {
    return `Pace: ${formatMinutes(eta.pace)} a day over the last two weeks (days off included)`;
  }
  const soFar = eta.activeDays === 1 ? '1 day so far' : `${eta.activeDays} days so far`;
  return `No date yet: it needs at least ${MIN_ACTIVE_DAYS} days and ${MIN_PACE_MINUTES / 60} hours of logged work in the last two weeks (${soFar})`;
}
