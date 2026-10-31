import { isSession, Status, statusOf, Todo, TodoId, Workspace } from './model';
import { addDays, DayKey, dayKeyOf, Millis, splitByDay, weekdayOf } from './time';
import { ancestorsOf } from './tree';

/** Minutes per day per todo, the running session included up to `now` */
export function minutesByDay(todos: Todo[], timezone: string, now: Millis): Map<DayKey, Map<TodoId, number>> {
  const result = new Map<DayKey, Map<TodoId, number>>();
  const add = (day: DayKey, id: TodoId, minutes: number) => {
    const perTodo = result.get(day) ?? new Map<TodoId, number>();
    perTodo.set(id, (perTodo.get(id) ?? 0) + minutes);
    result.set(day, perTodo);
  };
  for (const todo of todos) {
    for (const entry of todo.time) {
      if (isSession(entry)) {
        for (const [day, millis] of splitByDay(entry.start, entry.end ?? now, timezone)) {
          add(day, todo.id, millis / 60000);
        }
      } else {
        add(entry.day, todo.id, entry.minutes);
      }
    }
  }
  return result;
}

export interface Summary {
  today: number;
  /** Since Monday */
  week: number;
  total: number;
  counts: Record<Status, number>;
  /** Every todo's own weight (a macrotask's is its implicit leaf's) */
  weight: { done: number; total: number };
}

/** Statistics of a workspace; pass the archive to include archived work in the time totals */
export function summarize(workspace: Workspace, archive: Workspace | null, now: Millis): Summary {
  const timezone = workspace.timezone;
  const todos = [...workspace.todos, ...(archive?.todos ?? [])];
  const days = minutesByDay(todos, timezone, now);
  const today = dayKeyOf(now, timezone);
  const monday = addDays(today, -weekdayOf(today));
  let week = 0;
  let total = 0;
  for (const [day, perTodo] of days) {
    const minutes = [...perTodo.values()].reduce((sum, value) => sum + value, 0);
    total += minutes;
    if (day >= monday && day <= today) {
      week += minutes;
    }
  }
  const counts: Record<Status, number> = { new: 0, paused: 0, running: 0, done: 0 };
  for (const todo of workspace.todos) {
    counts[statusOf(todo)]++;
  }
  const weight = { done: 0, total: 0 };
  for (const todo of workspace.todos) {
    weight.total += todo.weight;
    if (todo.completed != null) weight.done += todo.weight;
  }
  return {
    today: [...(days.get(today)?.values() ?? [])].reduce((sum, value) => sum + value, 0),
    week,
    total,
    counts,
    weight,
  };
}

export interface Series {
  /** The todo the series groups (a child of the drill-down parent) */
  id: TodoId;
  name: string;
  /** Minutes per day, aligned with ChartData.days */
  values: number[];
}

export interface ChartData {
  days: DayKey[];
  series: Series[];
}

/**
 * Per-day minutes for the last `dayCount` days, one series per child of `parentId` (top-level todos
 * when null); each series includes the time of its whole subtree. The parent's own time (its implicit
 * leaf) is one more series, with the parent's id.
 */
export function dailySeries(
  workspace: Workspace,
  archive: Workspace | null,
  parentId: TodoId | null,
  dayCount: number,
  now: Millis,
): ChartData {
  const timezone = workspace.timezone;
  const today = dayKeyOf(now, timezone);
  const days = Array.from({ length: dayCount }, (_, index) => addDays(today, index - dayCount + 1));
  const sources = [workspace, ...(archive == null ? [] : [archive])];
  const series = new Map<TodoId, Series>();
  const groupOf = new Map<TodoId, TodoId>();
  for (const source of sources) {
    for (const todo of source.todos) {
      const chain = [todo, ...ancestorsOf(source, todo.id)];
      // The drill-down parent's own time is its implicit leaf: a series of its own
      const group = todo.id === parentId ? todo : chain.find(item => item.parentId === parentId);
      if (group == null) {
        continue;
      }
      groupOf.set(todo.id, group.id);
      if (!series.has(group.id)) {
        series.set(group.id, { id: group.id, name: group.name, values: days.map(() => 0) });
      }
    }
    for (const [day, perTodo] of minutesByDay(source.todos, timezone, now)) {
      const dayIndex = days.indexOf(day);
      if (dayIndex === -1) {
        continue;
      }
      for (const [id, minutes] of perTodo) {
        const group = groupOf.get(id);
        if (group != null) {
          (series.get(group) as Series).values[dayIndex] += minutes;
        }
      }
    }
  }
  return {
    days,
    series: [...series.values()]
      .filter(item => item.values.some(value => value > 0))
      .sort((a, b) => sum(b.values) - sum(a.values)),
  };
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
