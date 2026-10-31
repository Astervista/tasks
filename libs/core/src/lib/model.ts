import { DayKey, Millis } from './time';

/** Markdown heading levels ## … ###### */
export const MAX_DEPTH = 5;

export const DEFAULT_ARCHIVE_AFTER_DAYS = 14;

export type TodoId = number;

export function isTemporaryId(id: TodoId): boolean {
  return id < 0;
}

/** A tracked work session; `end` is null while the timer runs */
export interface Session {
  start: Millis;
  end: Millis | null;
}

/** Time logged as a total for a day (manual entries) */
export interface DayTotal {
  day: DayKey;
  minutes: number;
}

export type TimeEntry = Session | DayTotal;

/** "How far along?": a progress report that refines the ETA */
export interface CheckIn {
  at: Millis;
  /** 0 … 1 */
  progress: number;
  note: string;
}

export function isSession(entry: TimeEntry): entry is Session {
  return 'start' in entry;
}

export interface Todo {
  /** Assigned by the server; negative (temporary) for todos written by hand and not synced yet */
  id: TodoId;
  /** Workspace revision at which this todo last changed */
  rev: number | null;
  /** Content hash written at the last sync, used to detect hand edits (see hashTodo) */
  hash: string | null;
  name: string;
  parentId: TodoId | null;
  weight: number;
  created: Millis;
  updated: Millis | null;
  completed: Millis | null;
  /** Free Markdown, no headings */
  desc: string;
  time: TimeEntry[];
  /** The start guess of the total work, in minutes */
  estimate: number | null;
  checkins: CheckIn[];
}

export interface Workspace {
  uid: string;
  /** The H1 title: how people find the project */
  name: string;
  /** Free Markdown between the title and the first todo */
  description: string;
  timezone: string;
  revision: number;
  nextId: TodoId;
  archiveAfterDays: number;
  /** Revision at which the project info (title, description, settings) last changed */
  metaRev: number | null;
  /** Hash of the project info written at the last sync, to detect hand edits (see hashMeta) */
  metaHash: string | null;
  /** Depth-first document order: every todo comes after its parent and before its next sibling */
  todos: Todo[];
}

export type Status = 'new' | 'paused' | 'running' | 'done';

export const STATUS_ORDER: Record<Status, number> = { new: 0, paused: 1, running: 2, done: 3 };

export function openSession(todo: Todo): Session | null {
  for (const entry of todo.time) {
    if (isSession(entry) && entry.end == null) {
      return entry;
    }
  }
  return null;
}

/** Logged minutes, including the running session up to `now` */
export function ownMinutes(todo: Todo, now: Millis): number {
  let total = 0;
  for (const entry of todo.time) {
    if (isSession(entry)) {
      total += Math.max(0, (entry.end ?? now) - entry.start) / 60000;
    } else {
      total += entry.minutes;
    }
  }
  return total;
}

export function statusOf(todo: Todo): Status {
  if (todo.completed != null) {
    return 'done';
  }
  if (openSession(todo) != null) {
    return 'running';
  }
  return todo.time.length > 0 ? 'paused' : 'new';
}

export function findTodo(workspace: Workspace, id: TodoId): Todo | undefined {
  return workspace.todos.find(todo => todo.id === id);
}

export class CoreError extends Error {
  constructor(
    readonly code: 'not-found' | 'invalid' | 'open-descendants' | 'too-deep' | 'cycle' | 'conflict',
    message: string,
  ) {
    super(message);
  }
}

export function getTodo(workspace: Workspace, id: TodoId): Todo {
  const todo = findTodo(workspace, id);
  if (todo == null) {
    throw new CoreError('not-found', `No todo with id ${id}`);
  }
  return todo;
}

export function emptyWorkspace(uid: string, name: string, timezone: string, description = ''): Workspace {
  return {
    uid,
    name,
    description,
    timezone,
    revision: 0,
    nextId: 1,
    archiveAfterDays: DEFAULT_ARCHIVE_AFTER_DAYS,
    metaRev: null,
    metaHash: null,
    todos: [],
  };
}

export function cloneWorkspace(workspace: Workspace): Workspace {
  return {
    ...workspace,
    todos: workspace.todos.map(todo => ({
      ...todo,
      time: todo.time.map(entry => ({ ...entry })),
      checkins: todo.checkins.map(checkin => ({ ...checkin })),
    })),
  };
}
