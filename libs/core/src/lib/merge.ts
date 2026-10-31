/**
 * Three-way merge of a pushed TODO.md into the server's copy, without the client keeping a base copy:
 * - "changed on the server" = the todo's rev is newer than the revision the file was synced at
 * - "changed in the file"   = the todo's content no longer matches the hash written at that sync
 * Everything else follows from those two facts.
 */
import { archiveDone } from './archive';
import { isEditedLocally, isMetaEditedLocally, serializeWorkspace } from './markdown';
import { isValidTimeZone } from './time';
import { CheckIn, cloneWorkspace, isSession, openSession, Session, TimeEntry, Todo, TodoId, Workspace } from './model';
import { Millis } from './time';
import { pauseTodo, stampRevisions, toSeconds } from './transitions';
import { normalizeOrder, repairTree } from './tree';

export interface MergeInput {
  server: Workspace;
  archive: Workspace;
  /** Parsed from the pushed file */
  local: Workspace;
  /** Last modification of the pushed file; decides conflicts where both sides edited the same todo */
  localModified: Millis;
  now: Millis;
}

export interface MergeResult {
  workspace: Workspace;
  archive: Workspace;
  /** Whether the server copy changed (revision bumped) */
  changed: boolean;
  /** Human-readable notes about conflicts and repairs */
  notes: string[];
}

export function mergeWorkspace({ server, archive: serverArchive, local, localModified, now }: MergeInput): MergeResult {
  const moment = toSeconds(now);
  const base = local.revision;
  const result = cloneWorkspace(server);
  const archive = cloneWorkspace(serverArchive);
  const notes: string[] = [];
  const serverById = new Map(result.todos.map(todo => [todo.id, todo]));
  const archivedIds = new Set(archive.todos.map(todo => todo.id));
  const serverParent = new Map(server.todos.map(todo => [todo.id, todo.parentId]));

  // Which local todos were edited by hand, and which ids need a (new) server id
  const edited = new Set<TodoId>();
  const remap = new Map<TodoId, TodoId>();
  const dropped = new Map<TodoId, TodoId | null>(); // dropped id -> its local parent
  for (const todo of local.todos) {
    const isNew = todo.id < 0;
    if (isNew || isEditedLocally(todo, local.timezone)) {
      edited.add(todo.id);
    }
    const known = serverById.has(todo.id) || archivedIds.has(todo.id);
    if (isNew) {
      remap.set(todo.id, result.nextId++);
    } else if (!known) {
      // Deleted on the server since the last sync
      if (edited.has(todo.id)) {
        const newId = result.nextId++;
        remap.set(todo.id, newId);
        notes.push(`"${todo.name}" was deleted on the server but edited in the file: it was kept as a new todo`);
      } else {
        dropped.set(todo.id, todo.parentId);
      }
    }
  }
  const mapParent = (parentId: TodoId | null): TodoId | null => {
    let current = parentId;
    while (current != null && dropped.has(current)) {
      current = dropped.get(current) ?? null;
    }
    return current == null ? null : (remap.get(current) ?? current);
  };

  // Project info (title, description, settings): same rules as a todo
  if (isMetaEditedLocally(local)) {
    const changedOnServer = (server.metaRev ?? 0) > base;
    if (changedOnServer) {
      notes.push('The project title/description changed both in the file and on the server: kept the file version');
    }
    result.name = local.name;
    result.description = local.description;
    result.archiveAfterDays = local.archiveAfterDays;
    if (isValidTimeZone(local.timezone)) result.timezone = local.timezone;
  }

  const localIds = new Set<TodoId>();
  const sequence: Todo[] = [];
  for (const original of local.todos) {
    if (dropped.has(original.id)) {
      continue;
    }
    const incoming: Todo = {
      ...original,
      id: remap.get(original.id) ?? original.id,
      parentId: mapParent(original.parentId),
      time: original.time.map(entry => ({ ...entry })),
    };
    localIds.add(incoming.id);
    const current = serverById.get(incoming.id);

    if (current == null) {
      // New todo, a resurrected one, or one brought back from the archive by hand
      if (archivedIds.has(incoming.id)) {
        archive.todos = archive.todos.filter(todo => todo.id !== incoming.id);
        for (const child of archive.todos) {
          if (child.parentId === incoming.id) {
            child.parentId = null;
          }
        }
        normalizeOrder(archive);
      }
      incoming.rev = null;
      incoming.updated = moment;
      sequence.push(incoming);
      continue;
    }

    if (!edited.has(original.id)) {
      sequence.push(current);
      continue;
    }
    const changedOnServer = (current.rev ?? 0) > base;
    if (!changedOnServer) {
      Object.assign(current, pickContent(incoming), { updated: moment });
    } else {
      const localWins = localModified >= (current.updated ?? 0);
      const winner = localWins ? incoming : current;
      notes.push(`"${current.name}" was changed both in the file and on the server: kept the ${localWins ? 'file' : 'server'} version`);
      Object.assign(current, pickContent(winner), {
        time: unionTime(current.time, incoming.time, localWins),
        checkins: unionCheckIns(current.checkins, incoming.checkins, localWins),
        updated: moment,
      });
    }
    sequence.push(current);
  }

  // Server todos missing from the file: deleted by hand, unless the server changed them since
  const kept: Todo[] = [];
  for (const todo of result.todos) {
    if (localIds.has(todo.id)) {
      continue;
    }
    if ((todo.rev ?? 0) > base) {
      kept.push(todo);
    }
  }
  const deletedIds = new Set(result.todos.filter(todo => !localIds.has(todo.id) && !kept.includes(todo)).map(todo => todo.id));
  // Children of deleted todos move up to the closest surviving ancestor (as the server knew it)
  const survivingParent = (parentId: TodoId | null): TodoId | null => {
    let current = parentId;
    while (current != null && deletedIds.has(current)) {
      current = serverParent.get(current) ?? null;
    }
    return current;
  };

  const pristine = edited.size === 0 && deletedIds.size === 0 && dropped.size === 0;
  if (pristine) {
    // The file is just behind: keep the server's order (it may contain reorders the file never saw)
    result.todos = result.todos.filter(todo => !deletedIds.has(todo.id));
  } else {
    // The file's order wins; todos only the server has stay next to their server predecessor
    const ordered = [...sequence];
    for (const todo of kept) {
      const serverIndex = server.todos.findIndex(other => other.id === todo.id);
      let anchor = -1;
      for (let i = serverIndex - 1; i >= 0 && anchor === -1; i--) {
        anchor = ordered.findIndex(other => other.id === server.todos[i].id);
      }
      ordered.splice(anchor + 1, 0, todo);
    }
    result.todos = ordered;
  }
  for (const todo of result.todos) {
    todo.parentId = survivingParent(todo.parentId);
  }
  notes.push(...repairTree(result));
  notes.push(...enforceSingleRunning(result, moment));
  archiveDone(result, archive, moment);

  const changed = stampRevisions(server, result);
  const archiveChanged = serializeWorkspace({ ...archive, revision: 0 }) !== serializeWorkspace({ ...serverArchive, revision: 0 });
  if (archiveChanged && !changed) {
    result.revision = server.revision + 1;
  }
  stampRevisions(serverArchive, archive, result.revision);
  archive.revision = result.revision;
  return { workspace: result, archive, changed: changed || archiveChanged, notes };
}

function pickContent(todo: Todo): Partial<Todo> {
  return {
    name: todo.name,
    parentId: todo.parentId,
    weight: todo.weight,
    created: todo.created,
    completed: todo.completed,
    desc: todo.desc,
    time: todo.time,
    estimate: todo.estimate,
    checkins: todo.checkins,
  };
}

/** Sessions are matched by start, day totals by day; a closed session beats a still-open one */
export function unionTime(server: TimeEntry[], local: TimeEntry[], preferLocal: boolean): TimeEntry[] {
  const key = (entry: TimeEntry) => (isSession(entry) ? `s${entry.start}` : `d${entry.day}`);
  const result = new Map<string, TimeEntry>();
  const [first, second] = preferLocal ? [server, local] : [local, server];
  for (const entry of [...first, ...second]) {
    const existing = result.get(key(entry));
    if (existing != null && isSession(existing) && isSession(entry) && existing.end != null && entry.end == null) {
      continue;
    }
    result.set(key(entry), { ...entry });
  }
  return [...result.values()];
}

/** Check-ins are matched by moment */
function unionCheckIns(server: CheckIn[], local: CheckIn[], preferLocal: boolean): CheckIn[] {
  const result = new Map<number, CheckIn>();
  for (const checkin of preferLocal ? [...server, ...local] : [...local, ...server]) {
    result.set(checkin.at, { ...checkin });
  }
  return [...result.values()];
}

/** Only one todo runs at a time: if a merge produced more, the most recently started one keeps running */
function enforceSingleRunning(workspace: Workspace, now: Millis): string[] {
  const running = workspace.todos
    .map(todo => ({ todo, session: openSession(todo) }))
    .filter((item): item is { todo: Todo; session: Session } => item.session != null)
    .sort((a, b) => b.session.start - a.session.start);
  return running.slice(1).map(({ todo }) => {
    pauseTodo(workspace, todo.id, now);
    return `"${todo.name}" was paused because "${running[0].todo.name}" is running`;
  });
}
