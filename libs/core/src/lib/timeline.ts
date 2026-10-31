/**
 * The life of every todo as phases on a time axis: not started yet, worked on, worked on through a
 * subtask (macrotasks), paused, until completion (or now).
 */
import { isSession, Todo, TodoId, Workspace } from './model';
import { Millis, startOfDay } from './time';
import { depthOf, descendantsOf } from './tree';

export type PhaseKind = 'new' | 'active' | 'subtask' | 'paused';

export interface Phase {
  kind: PhaseKind;
  start: Millis;
  end: Millis;
  /** From a day total ("2026-10-29: 2h"): the length is right, the time of day is not known */
  approximate: boolean;
}

export interface TimelineRow {
  id: TodoId;
  name: string;
  depth: number;
  created: Millis;
  completed: Millis | null;
  /** Start of the row: creation, or earlier work logged by hand */
  start: Millis;
  /** Completion, or now */
  end: Millis;
  phases: Phase[];
}

type Interval = { start: Millis; end: Millis; approximate: boolean };

/** Rows in document (tree) order */
export function timeline(workspace: Workspace, now: Millis): TimelineRow[] {
  return workspace.todos.map(todo => todoTimeline(workspace, todo, now));
}

/**
 * One todo's life. `withSubtasks` false gives a macrotask's implicit leaf: only its own work, and
 * the time spent on subtasks counts as paused.
 */
export function todoTimeline(workspace: Workspace, todo: Todo, now: Millis, withSubtasks = true): TimelineRow {
  const own = merge(workIntervals(todo, workspace.timezone, now));
  const below = withSubtasks ? merge(descendantsOf(workspace, todo.id).flatMap(item => workIntervals(item, workspace.timezone, now))) : [];
  const end = todo.completed ?? now;
  const start = Math.min(todo.created, ...own.map(item => item.start), ...below.map(item => item.start));
  const work: Phase[] = [
    ...own.map(item => ({ kind: 'active' as const, ...item })),
    ...subtract(below, own).map(item => ({ kind: 'subtask' as const, ...item })),
  ].sort((a, b) => a.start - b.start);
  const phases: Phase[] = [];
  let cursor = start;
  let started = false;
  for (const phase of work) {
    if (phase.start > cursor) {
      phases.push({ kind: started ? 'paused' : 'new', start: cursor, end: Math.min(phase.start, end), approximate: false });
    }
    phases.push(phase);
    started = true;
    cursor = Math.max(cursor, phase.end);
  }
  if (cursor < end) {
    phases.push({ kind: started ? 'paused' : 'new', start: cursor, end, approximate: false });
  }
  return {
    id: todo.id,
    name: todo.name,
    depth: depthOf(workspace, todo.id),
    created: todo.created,
    completed: todo.completed,
    start,
    end: Math.max(end, cursor),
    phases: phases.filter(phase => phase.end > phase.start),
  };
}

/** Sessions as they are; day totals centred on noon of their day */
function workIntervals(todo: Todo, timezone: string, now: Millis): Interval[] {
  return todo.time.map(entry => {
    if (isSession(entry)) {
      return { start: entry.start, end: entry.end ?? now, approximate: false };
    }
    const noon = startOfDay(entry.day, timezone) + 12 * 3600000;
    const half = (entry.minutes * 60000) / 2;
    return { start: noon - half, end: noon + half, approximate: true };
  }).filter(item => item.end > item.start);
}

function merge(intervals: Interval[]): Interval[] {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const result: Interval[] = [];
  for (const item of sorted) {
    const last = result[result.length - 1];
    if (last != null && item.start <= last.end) {
      last.end = Math.max(last.end, item.end);
      last.approximate = last.approximate && item.approximate;
    } else {
      result.push({ ...item });
    }
  }
  return result;
}

/** Parts of `from` not covered by `cut` (both merged) */
function subtract(from: Interval[], cut: Interval[]): Interval[] {
  const result: Interval[] = [];
  for (const item of from) {
    let pieces: Interval[] = [item];
    for (const hole of cut) {
      pieces = pieces.flatMap(piece => {
        if (hole.end <= piece.start || hole.start >= piece.end) return [piece];
        return [
          ...(hole.start > piece.start ? [{ ...piece, end: hole.start }] : []),
          ...(hole.end < piece.end ? [{ ...piece, start: hole.end }] : []),
        ];
      });
    }
    result.push(...pieces);
  }
  return result;
}
