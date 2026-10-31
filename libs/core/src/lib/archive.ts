import { getTodo, Todo, TodoId, Workspace } from './model';
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
  const limit = now - workspace.archiveAfterDays * DAY;
  const roots = workspace.todos.filter(todo => todo.parentId == null && todo.completed != null && todo.completed <= limit);
  for (const root of roots) {
    moveSubtree(workspace, archive, root.id);
  }
  return roots;
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
