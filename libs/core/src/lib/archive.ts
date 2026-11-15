import { CoreError, getTodo, openSession, Todo, TodoId, Workspace } from './model';
import { Millis } from './time';
import { descendantsOf, normalizeOrder } from './tree';

const DAY = 24 * 60 * 60 * 1000;

/** The archive file is a workspace of its own, holding whole done subtrees */
export function emptyArchive(workspace: Workspace): Workspace {
  return { ...workspace, name: archiveName(workspace.name), description: '', todos: [] };
}

export function archiveName(name: string): string {
  return `${name} (archive)`;
}

/**
 * Moves top-level todos completed more than `archiveAfterDays` ago, with their subtree, to the archive.
 * Done subtasks of open macrotasks stay, because they count toward their parent's progress.
 * Returns the archived roots.
 */
export function archiveDone(workspace: Workspace, archive: Workspace, now: Millis): Todo[] {
  const roots = dueForArchive(workspace, now);
  for (const root of roots) {
    moveSubtree(workspace, archive, root.id);
  }
  return roots;
}

/**
 * Archives a todo and its subtree by hand, done or not; running work has to be paused first.
 * A subtask lands in the archive as a top-level todo.
 */
export function archiveTodo(workspace: Workspace, archive: Workspace, id: TodoId): void {
  const todo = getTodo(workspace, id);
  const running = [todo, ...descendantsOf(workspace, id)].find(item => openSession(item) != null);
  if (running != null) {
    throw new CoreError('invalid', running === todo
      ? `"${todo.name}" is running: pause it before archiving it`
      : `"${running.name}", a subtask of "${todo.name}", is running: pause it before archiving`);
  }
  moveSubtree(workspace, archive, id);
}

/** Top-level todos done for `archiveAfterDays` or longer */
export function dueForArchive(workspace: Workspace, now: Millis): Todo[] {
  const limit = now - workspace.archiveAfterDays * DAY;
  return workspace.todos.filter(todo => todo.parentId == null && todo.completed != null && todo.completed <= limit);
}

/** Brings an archived subtree back to the end of the workspace */
export function restoreFromArchive(workspace: Workspace, archive: Workspace, id: TodoId): void {
  let root = getTodo(archive, id);
  while (root.parentId != null) {
    root = getTodo(archive, root.parentId);
  }
  moveSubtree(archive, workspace, root.id);
}

function moveSubtree(from: Workspace, to: Workspace, id: TodoId): void {
  const moving = new Set([getTodo(from, id), ...descendantsOf(from, id)]);
  const ordered = from.todos.filter(todo => moving.has(todo));
  from.todos = from.todos.filter(todo => !moving.has(todo));
  ordered[0].parentId = null;
  to.todos.push(...ordered);
  normalizeOrder(to);
}
