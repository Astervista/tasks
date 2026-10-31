/**
 * Todo state changes. They mutate the workspace in place; callers that need the previous state clone
 * it first (cloneWorkspace). Revisions are stamped afterwards by stampRevisions.
 */
import { cleanDescription, cleanName, cleanNote, hashMeta, hashTodo } from './markdown';
import { CoreError, getTodo, MAX_DEPTH, openSession, Todo, TodoId, Workspace } from './model';
import { Millis } from './time';
import { ancestorsOf, canMoveTo, childrenOf, depthOf, descendantsOf, moveTodo, normalizeOrder } from './tree';

/** The file stores seconds, so moments are truncated to keep hashes stable across a round-trip */
export function toSeconds(moment: Millis): Millis {
  return Math.floor(moment / 1000) * 1000;
}

export interface TodoFields {
  name: string;
  weight: number;
  desc: string;
  /** Start guess of the total work in minutes; null = none */
  estimate?: number | null;
}

export function validateFields(fields: Partial<TodoFields>): void {
  if (fields.name !== undefined && (typeof fields.name !== 'string' || fields.name.trim() === '')) {
    throw new CoreError('invalid', 'The name cannot be empty');
  }
  if (fields.weight !== undefined && (typeof fields.weight !== 'number' || !Number.isFinite(fields.weight) || fields.weight < 0)) {
    throw new CoreError('invalid', 'The weight must be a number, 0 or more');
  }
  if (fields.desc !== undefined && typeof fields.desc !== 'string') {
    throw new CoreError('invalid', 'The description must be text');
  }
  if (fields.estimate != null && (typeof fields.estimate !== 'number' || !Number.isFinite(fields.estimate) || fields.estimate <= 0)) {
    throw new CoreError('invalid', 'The estimate must be a positive number of minutes');
  }
}

export function addTodo(
  workspace: Workspace,
  fields: TodoFields & { parentId?: TodoId | null; index?: number },
  now: Millis,
): Todo {
  validateFields(fields);
  const parentId = fields.parentId ?? null;
  if (parentId != null) {
    getTodo(workspace, parentId);
    if (depthOf(workspace, parentId) >= MAX_DEPTH) {
      throw new CoreError('too-deep', `Todos can be nested at most ${MAX_DEPTH} levels deep`);
    }
  }
  const moment = toSeconds(now);
  const todo: Todo = {
    id: workspace.nextId++,
    rev: null,
    hash: null,
    name: cleanName(fields.name),
    parentId: null,
    weight: fields.weight,
    created: moment,
    updated: moment,
    completed: null,
    desc: cleanDescription(fields.desc),
    time: [],
    estimate: fields.estimate ?? null,
    checkins: [],
  };
  workspace.todos.push(todo);
  moveTodo(workspace, todo.id, parentId, fields.index);
  // A new open child means the parent is not done anymore
  for (const ancestor of ancestorsOf(workspace, todo.id)) {
    ancestor.completed = null;
  }
  return todo;
}

export function editTodo(workspace: Workspace, id: TodoId, fields: Partial<TodoFields>, now: Millis): void {
  validateFields(fields);
  const todo = getTodo(workspace, id);
  if (fields.name !== undefined) {
    todo.name = cleanName(fields.name);
  }
  if (fields.weight !== undefined) {
    todo.weight = fields.weight;
  }
  if (fields.desc !== undefined) {
    todo.desc = cleanDescription(fields.desc);
  }
  if (fields.estimate !== undefined) {
    todo.estimate = fields.estimate;
  }
  touch(todo, now);
}

export function moveTodoTo(workspace: Workspace, id: TodoId, parentId: TodoId | null, index: number | undefined, now: Millis): void {
  moveTodo(workspace, id, parentId, index);
  const todo = getTodo(workspace, id);
  if (todo.completed == null) {
    for (const ancestor of ancestorsOf(workspace, id)) {
      ancestor.completed = null;
    }
  }
  touch(todo, now);
}

export { canMoveTo };

/** The running todo of a workspace, if any */
export function runningTodo(workspace: Workspace): Todo | undefined {
  return workspace.todos.find(todo => openSession(todo) != null);
}

/** Closes the open session of every running todo in the workspace */
export function pauseAll(workspace: Workspace, now: Millis): Todo[] {
  const paused: Todo[] = [];
  for (const todo of workspace.todos) {
    if (openSession(todo) != null) {
      pauseTodo(workspace, todo.id, now);
      paused.push(todo);
    }
  }
  return paused;
}

/** Starts (or resumes, or reopens and starts) a todo, pausing whatever else runs in the workspace */
export function startTodo(workspace: Workspace, id: TodoId, now: Millis): void {
  const todo = getTodo(workspace, id);
  if (openSession(todo) != null) {
    return;
  }
  const moment = toSeconds(now);
  pauseAll(workspace, moment);
  reopenTodo(workspace, id, moment);
  todo.time.push({ start: moment, end: null });
  touch(todo, moment);
}

export function pauseTodo(workspace: Workspace, id: TodoId, now: Millis): void {
  const todo = getTodo(workspace, id);
  const session = openSession(todo);
  if (session == null) {
    return;
  }
  const moment = toSeconds(now);
  if (moment > session.start) {
    session.end = moment;
  } else {
    // A session of zero seconds (or one "ending" before it started, after a clock change) is dropped
    todo.time.splice(todo.time.indexOf(session), 1);
  }
  touch(todo, moment);
}

/**
 * Stops the timer as of `at` (clamped between the session start and now): for a check-in nobody
 * answered, or a computer that went to sleep, the time after that moment is not work.
 */
export function pauseTodoAt(workspace: Workspace, id: TodoId, at: Millis, now: Millis): void {
  const session = openSession(getTodo(workspace, id));
  if (session == null) return;
  pauseTodo(workspace, id, Math.max(session.start, Math.min(at, now)));
}

/** Records how far along a todo is (0 … 1), refining its ETA */
export function checkIn(workspace: Workspace, id: TodoId, progress: number, note: string, now: Millis): void {
  if (typeof progress !== 'number' || !Number.isFinite(progress) || progress < 0 || progress > 1) {
    throw new CoreError('invalid', 'Progress must be between 0 and 1');
  }
  const todo = getTodo(workspace, id);
  const moment = toSeconds(now);
  todo.checkins = todo.checkins.filter(checkin => checkin.at !== moment);
  todo.checkins.push({ at: moment, progress, note: cleanNote(note) });
  touch(todo, moment);
}

/** Discards the running session without logging it */
export function resetTimer(workspace: Workspace, id: TodoId, now: Millis): void {
  const todo = getTodo(workspace, id);
  const session = openSession(todo);
  if (session != null) {
    todo.time.splice(todo.time.indexOf(session), 1);
    touch(todo, now);
  }
}

export function openDescendants(workspace: Workspace, id: TodoId): Todo[] {
  return descendantsOf(workspace, id).filter(todo => todo.completed == null);
}

/**
 * Marks a todo done. A macrotask with open subtasks can only be completed together with them
 * (`withDescendants`), so a done todo never hides open work.
 */
export function completeTodo(workspace: Workspace, id: TodoId, now: Millis, withDescendants = false): void {
  const todo = getTodo(workspace, id);
  const open = openDescendants(workspace, id);
  if (open.length > 0 && !withDescendants) {
    throw new CoreError('open-descendants', `"${todo.name}" has ${open.length} open subtask(s)`);
  }
  const moment = toSeconds(now);
  for (const target of [...open, todo]) {
    pauseTodo(workspace, target.id, moment);
    if (target.completed == null) {
      target.completed = moment;
      touch(target, moment);
    }
  }
}

/** Reopens a done todo and all its done ancestors */
export function reopenTodo(workspace: Workspace, id: TodoId, now: Millis): void {
  for (const target of [getTodo(workspace, id), ...ancestorsOf(workspace, id)]) {
    if (target.completed != null) {
      target.completed = null;
      touch(target, now);
    }
  }
}

/**
 * Whether completing `id` leaves its parent with only done children; the UI then offers to complete
 * the parent too.
 */
export function parentReadyAfterCompleting(workspace: Workspace, id: TodoId): Todo | null {
  const todo = getTodo(workspace, id);
  if (todo.parentId == null) {
    return null;
  }
  const parent = getTodo(workspace, todo.parentId);
  const siblingsOpen = childrenOf(workspace, parent.id).some(child => child.id !== id && child.completed == null);
  return parent.completed == null && !siblingsOpen ? parent : null;
}

export type DeleteMode = 'subtree' | 'promote';

/**
 * Deletes a todo. `subtree` deletes its descendants too; `promote` moves its children up to its parent,
 * in its place.
 */
export function deleteTodo(workspace: Workspace, id: TodoId, mode: DeleteMode, now: Millis): void {
  const todo = getTodo(workspace, id);
  if (mode === 'subtree') {
    const doomed = new Set([todo, ...descendantsOf(workspace, id)]);
    workspace.todos = workspace.todos.filter(other => !doomed.has(other));
    return;
  }
  for (const child of childrenOf(workspace, id)) {
    child.parentId = todo.parentId;
    touch(child, now);
  }
  // Children keep the deleted todo's place: they follow it in document order already
  workspace.todos = workspace.todos.filter(other => other !== todo);
  normalizeOrder(workspace);
}

function touch(todo: Todo, now: Millis): void {
  todo.updated = toSeconds(now);
}

/**
 * Assigns `rev` to todos that changed between `before` and `after` and bumps the workspace revision
 * when anything changed (including deletions and reordering). Returns whether something changed.
 * `revision` forces the revision to stamp with (used to keep the archive in step with its workspace).
 */
export function stampRevisions(before: Workspace, after: Workspace, revision?: number): boolean {
  const timezone = after.timezone;
  const previous = new Map(before.todos.map(todo => [todo.id, todo]));
  const changed = after.todos.filter(todo => {
    const old = previous.get(todo.id);
    return old == null || hashTodo(old, before.timezone) !== hashTodo(todo, timezone);
  });
  const order = (workspace: Workspace) => workspace.todos.map(todo => todo.id).join(',');
  const metaChanged = before.name !== after.name || before.description !== after.description
    || before.timezone !== after.timezone || before.archiveAfterDays !== after.archiveAfterDays;
  if (changed.length === 0 && order(before) === order(after) && !metaChanged) {
    return false;
  }
  after.revision = revision ?? Math.max(before.revision, after.revision) + 1;
  for (const todo of changed) {
    todo.rev = after.revision;
  }
  for (const todo of after.todos) {
    todo.hash = hashTodo(todo, timezone);
  }
  if (metaChanged || after.metaRev == null) {
    after.metaRev = after.revision;
  }
  after.metaHash = hashMeta(after);
  return true;
}
