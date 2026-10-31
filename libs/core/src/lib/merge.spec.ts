import { emptyArchive } from './archive';
import { parseWorkspace, serializeWorkspace } from './markdown';
import { mergeWorkspace } from './merge';
import { cloneWorkspace, emptyWorkspace, findTodo, openSession, Workspace } from './model';
import { parseStamp } from './time';
import { addTodo, completeTodo, editTodo, moveTodoTo, pauseTodo, stampRevisions, startTodo } from './transitions';

const ROME = 'Europe/Rome';
const at = (stamp: string) => parseStamp(stamp, ROME) as number;
const T0 = at('2026-10-29 09:00:00');
const SYNCED = at('2026-10-29 09:01:00');
const LATER = at('2026-10-29 10:00:00');
const NOW = at('2026-10-29 11:00:00');

/** A server copy at revision 1 and the file the client got from it */
function setup() {
  const server = emptyWorkspace('uid', 'tasks', ROME);
  addTodo(server, { name: 'Testing', weight: 1, desc: '' }, T0);
  addTodo(server, { name: 'Suite', weight: 8, desc: '', parentId: 1 }, T0);
  addTodo(server, { name: 'Test the testing', weight: 13, desc: 'Original', parentId: 1 }, T0);
  addTodo(server, { name: 'Edge cases', weight: 3, desc: '', parentId: 3 }, T0);
  addTodo(server, { name: 'Be happy', weight: 2, desc: '' }, T0);
  stampRevisions(emptyWorkspace('uid', 'tasks', ROME), server);
  return { server, archive: emptyArchive(server), file: serializeWorkspace(server) };
}

/** Applies a server-side change the way the API does */
function serverChange(server: Workspace, change: (workspace: Workspace) => void): Workspace {
  const next = cloneWorkspace(server);
  change(next);
  stampRevisions(server, next);
  return next;
}

function merge(server: Workspace, archive: Workspace, file: string, modified = LATER) {
  const local = parseWorkspace(file, { now: NOW }).workspace;
  return mergeWorkspace({ server, archive, local, localModified: modified, now: NOW });
}

const names = (workspace: Workspace) => workspace.todos.map(todo => todo.name);

describe('mergeWorkspace', () => {
  it('changes nothing when the file is the server copy', () => {
    const { server, archive, file } = setup();
    const result = merge(server, archive, file);
    expect(result.changed).toBe(false);
    expect(result.workspace.revision).toBe(1);
    expect(serializeWorkspace(result.workspace)).toBe(file);
  });

  it('keeps server changes when the file is just behind', () => {
    const { server, archive, file } = setup();
    const updated = serverChange(server, workspace => {
      editTodo(workspace, 3, { desc: 'Changed on the server' }, LATER);
      moveTodoTo(workspace, 5, null, 0, LATER); // reorder only
      addTodo(workspace, { name: 'From the UI', weight: 1, desc: '', parentId: 1 }, LATER);
    });
    const result = merge(updated, archive, file);
    expect(result.changed).toBe(false);
    expect(serializeWorkspace(result.workspace)).toBe(serializeWorkspace(updated));
  });

  it('takes hand edits of todos the server did not touch', () => {
    const { server, archive, file } = setup();
    const result = merge(server, archive, file.replace('- weight: 13', '- weight: 21').replace('Original', 'Edited by hand'));
    expect(result.changed).toBe(true);
    expect(result.workspace.revision).toBe(2);
    const todo = findTodo(result.workspace, 3);
    expect(todo).toMatchObject({ weight: 21, desc: 'Edited by hand', rev: 2 });
    expect(findTodo(result.workspace, 2)?.rev).toBe(1);
  });

  it('merges edits of different todos from both sides', () => {
    const { server, archive, file } = setup();
    const updated = serverChange(server, workspace => editTodo(workspace, 2, { name: 'Suite (server)' }, LATER));
    const result = merge(updated, archive, file.replace('## Be happy', '## Be very happy'));
    expect(names(result.workspace)).toEqual(['Testing', 'Suite (server)', 'Test the testing', 'Edge cases', 'Be very happy']);
    expect(result.notes).toEqual([]);
  });

  it('resolves a todo edited on both sides by modification time, keeping all time', () => {
    const { server, archive, file } = setup();
    const updated = serverChange(server, workspace => {
      startTodo(workspace, 3, at('2026-10-29 09:30:00'));
      pauseTodo(workspace, 3, at('2026-10-29 09:45:00'));
      editTodo(workspace, 3, { desc: 'Server text' }, at('2026-10-29 09:50:00'));
    });
    const edited = file
      .replace('Original', 'File text')
      .replace(/(### Test the testing[^\n]*\n(?:- .*\n)+\nFile text)/, '$1\n\n**Time**\n- 2026-10-29 08:00:00 → 08:30:00');

    const fileNewer = merge(updated, archive, edited, at('2026-10-29 09:55:00'));
    const todo = findTodo(fileNewer.workspace, 3)!;
    expect(todo.desc).toBe('File text');
    expect(todo.time).toHaveLength(2);
    expect(fileNewer.notes[0]).toMatch(/kept the file version/);

    const serverNewer = merge(updated, archive, edited, at('2026-10-29 09:40:00'));
    expect(findTodo(serverNewer.workspace, 3)!.desc).toBe('Server text');
    expect(findTodo(serverNewer.workspace, 3)!.time).toHaveLength(2);
  });

  it('adds hand-written todos, nested ones included, with fresh ids', () => {
    const { server, archive, file } = setup();
    const result = merge(server, archive, file + '\n## Written by hand\n\n### Its child\n- weight: 5\n');
    expect(result.workspace.todos.slice(-2).map(todo => [todo.id, todo.parentId, todo.name, todo.weight])).toEqual([
      [6, null, 'Written by hand', 1],
      [7, 6, 'Its child', 5],
    ]);
    expect(result.workspace.nextId).toBe(8);
    expect(serializeWorkspace(result.workspace)).toContain('### Its child <!-- id:7 rev:2 h:');
  });

  it('deletes todos removed from the file, moving surviving children up', () => {
    const { server, archive, file } = setup();
    const withoutParent = file.replace(/### Test the testing[^]*?(?=#### Edge cases)/, '');
    const result = merge(server, archive, withoutParent);
    // The file's own structure already attached "Edge cases" to the previous heading's parent
    expect(result.workspace.todos.map(todo => [todo.id, todo.parentId])).toEqual([
      [1, null],
      [2, 1],
      [4, 2],
      [5, null],
    ]);
  });

  it('keeps todos the server changed even if the file deleted them', () => {
    const { server, archive, file } = setup();
    const updated = serverChange(server, workspace => editTodo(workspace, 5, { weight: 3 }, LATER));
    const result = merge(updated, archive, file.replace(/## Be happy[^]*$/, '').trimEnd() + '\n');
    expect(findTodo(result.workspace, 5)?.weight).toBe(3);
  });

  it('drops todos deleted on the server unless they were edited in the file', () => {
    const { server, archive, file } = setup();
    const updated = serverChange(server, workspace => {
      workspace.todos = workspace.todos.filter(todo => todo.id !== 5 && todo.id !== 2);
    });
    const result = merge(updated, archive, file.replace('## Be happy', '## Be happy, edited'));
    expect(findTodo(result.workspace, 2)).toBeUndefined();
    const resurrected = result.workspace.todos.find(todo => todo.name === 'Be happy, edited');
    expect(resurrected?.id).toBe(6);
    expect(result.notes[0]).toMatch(/kept as a new todo/);
  });

  it('applies concurrent moves without cycles or excess depth', () => {
    const { server, archive, file } = setup();
    // Server: Testing under Be happy. File: Be happy under Edge cases (a cycle once combined)
    const updated = serverChange(server, workspace => moveTodoTo(workspace, 1, 5, undefined, LATER));
    const local = file.replace(/\n## Be happy([^\n]*)/, '\n##### Be happy$1');
    const result = merge(updated, archive, local);
    const ids = new Set(result.workspace.todos.map(todo => todo.id));
    expect(ids.size).toBe(5);
    for (const todo of result.workspace.todos) {
      let depth = 1;
      let current = todo;
      while (current.parentId != null) {
        current = findTodo(result.workspace, current.parentId)!;
        expect(++depth).toBeLessThanOrEqual(5);
      }
    }
    expect(result.notes.some(note => /cycle|too deep/.test(note))).toBe(true);
  });

  it('takes the project title and description edited in the file', () => {
    const { server, archive, file } = setup();
    const edited = file.replace(/# tasks <!--[^\n]*-->\n/, '# Tasks v2 <!-- $& -->\n'.replace('$&', file.match(/# tasks <!-- (.*) -->/)![1]) + '\nNow with **macrotasks**.\n');
    const result = merge(server, archive, edited);
    expect(result.workspace).toMatchObject({ name: 'Tasks v2', description: 'Now with **macrotasks**.' });
    expect(result.changed).toBe(true);
    expect(result.workspace.metaRev).toBe(result.workspace.revision);
  });

  it('keeps a project title changed on the server when the file is just behind', () => {
    const { server, archive, file } = setup();
    const updated = serverChange(server, workspace => {
      workspace.name = 'Renamed in the web app';
    });
    const result = merge(updated, archive, file);
    expect(result.changed).toBe(false);
    expect(result.workspace.name).toBe('Renamed in the web app');
  });

  it('keeps a single running todo', () => {
    const { server, archive, file } = setup();
    const updated = serverChange(server, workspace => startTodo(workspace, 2, at('2026-10-29 10:30:00')));
    const local = file.replace(/(## Be happy[^\n]*\n(?:- .*\n)+)/, '$1\n**Time**\n- 2026-10-29 10:45:00 → running\n');
    const result = merge(updated, archive, local);
    expect(result.workspace.todos.filter(todo => openSession(todo) != null).map(todo => todo.id)).toEqual([5]);
  });

  it('archives old done work and lets the file bring it back', () => {
    const { server, archive, file } = setup();
    const updated = serverChange(server, workspace => completeTodo(workspace, 5, at('2026-10-01 10:00:00')));
    const first = merge(updated, archive, serializeWorkspace(updated).replace('# tasks', '# tasks!'));
    expect(first.archive.todos.map(todo => todo.id)).toEqual([5]);
    expect(first.workspace.todos.map(todo => todo.id)).toEqual([1, 2, 3, 4]);
    expect(first.archive.revision).toBe(first.workspace.revision);

    // Pasting the archived block back (and reopening it) restores it
    const block = '\n## Be happy <!-- id:5 -->\n- weight: 2\n';
    const second = merge(first.workspace, first.archive, serializeWorkspace(first.workspace) + block);
    expect(second.archive.todos).toEqual([]);
    expect(findTodo(second.workspace, 5)?.completed).toBeNull();
    void file;
  });
});
