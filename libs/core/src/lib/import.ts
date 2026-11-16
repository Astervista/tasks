import { emptyArchive } from './archive';
import { parseWorkspace, ParseIssue } from './markdown';
import { emptyWorkspace, Todo, TodoId, Workspace } from './model';
import { Millis } from './time';
import { stampRevisions } from './transitions';

/** A project folder's files, as `tasks init` finds them */
export interface ImportedFiles {
  todo?: string;
  archive?: string;
}

/**
 * A new workspace made from a project folder's files, for a folder whose workspace the server doesn't
 * have (or doesn't let this user see). Todos keep their ids, time, check-ins and archive, so the folder's
 * history survives; todos written by hand, and archived ids the open todos already use, get new ids.
 * Name, description and timezone come from the request: the file's are only the defaults offered.
 */
export function importWorkspace(
  uid: string,
  name: string,
  description: string,
  timezone: string,
  files: ImportedFiles,
  now: Millis,
): { workspace: Workspace; archive: Workspace; issues: ParseIssue[] } {
  const base = emptyWorkspace(uid, name, timezone, description);
  const parsed = files.todo == null || files.todo.trim() === '' ? null : parseWorkspace(files.todo, { now, timezone });
  const archived = files.archive == null || files.archive.trim() === '' ? null : parseWorkspace(files.archive, { now, timezone });
  const workspace: Workspace = {
    ...base,
    archiveAfterDays: parsed?.workspace.archiveAfterDays ?? base.archiveAfterDays,
    todos: parsed?.workspace.todos ?? [],
  };
  const archive: Workspace = { ...emptyArchive(base), todos: archived?.workspace.todos ?? [] };

  const positive = [...workspace.todos, ...archive.todos].map(todo => todo.id).filter(id => id > 0);
  let nextId = Math.max(parsed?.workspace.nextId ?? 1, archived?.workspace.nextId ?? 1, ...positive.map(id => id + 1));
  const renumber = (todos: Todo[], needsNew: (id: TodoId) => boolean) => {
    const ids = new Map<TodoId, TodoId>();
    for (const todo of todos) {
      if (needsNew(todo.id)) ids.set(todo.id, nextId++);
    }
    for (const todo of todos) {
      todo.id = ids.get(todo.id) ?? todo.id;
      todo.parentId = todo.parentId == null ? null : (ids.get(todo.parentId) ?? todo.parentId);
    }
  };
  renumber(workspace.todos, id => id <= 0);
  const open = new Set(workspace.todos.map(todo => todo.id));
  renumber(archive.todos, id => id <= 0 || open.has(id));
  workspace.nextId = nextId;
  archive.nextId = nextId;

  for (const todo of [...workspace.todos, ...archive.todos]) {
    todo.rev = null;
    todo.hash = null;
  }
  // Every todo is new to this workspace: all of them get revision 1
  stampRevisions(base, workspace);
  if (workspace.revision === 0) {
    workspace.revision = 1;
    workspace.metaRev = 1;
  }
  stampRevisions(emptyArchive(base), archive, workspace.revision);
  archive.revision = workspace.revision;
  return { workspace, archive, issues: [...(parsed?.issues ?? []), ...(archived?.issues ?? [])] };
}
