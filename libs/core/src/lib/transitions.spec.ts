import { archiveDone, emptyArchive, restoreFromArchive } from './archive';
import { CoreError, emptyWorkspace, openSession, statusOf, Workspace } from './model';
import { summarize, dailySeries } from './stats';
import { parseStamp } from './time';
import {
  addTodo,
  completeTodo,
  deleteTodo,
  moveTodoTo,
  parentReadyAfterCompleting,
  pauseTodo,
  resetTimer,
  stampRevisions,
  startTodo,
} from './transitions';
import { canMoveTo, depthOf, rollups, subtreeStatus } from './tree';
import { cloneWorkspace } from './model';

const ROME = 'Europe/Rome';
const at = (stamp: string) => parseStamp(stamp, ROME) as number;
const NOW = at('2026-10-29 12:00:00');

function sample(): Workspace {
  const workspace = emptyWorkspace('uid', 'tasks', ROME);
  const testing = addTodo(workspace, { name: 'Testing', weight: 1, desc: '' }, NOW);
  addTodo(workspace, { name: 'Suite', weight: 8, desc: '', parentId: testing.id }, NOW);
  const test = addTodo(workspace, { name: 'Test the testing', weight: 13, desc: '', parentId: testing.id }, NOW);
  addTodo(workspace, { name: 'Edge cases', weight: 3, desc: '', parentId: test.id }, NOW);
  addTodo(workspace, { name: 'Be happy', weight: 2, desc: '' }, NOW);
  return workspace;
}
const ids = (workspace: Workspace) => workspace.todos.map(todo => todo.id);

describe('adding and moving', () => {
  it('keeps depth-first order and assigns ids', () => {
    const workspace = sample();
    expect(workspace.todos.map(todo => [todo.id, todo.parentId])).toEqual([
      [1, null],
      [2, 1],
      [3, 1],
      [4, 3],
      [5, null],
    ]);
    expect(workspace.nextId).toBe(6);
    expect(depthOf(workspace, 4)).toBe(3);
  });

  it('inserts at an index among siblings', () => {
    const workspace = sample();
    addTodo(workspace, { name: 'First', weight: 1, desc: '', parentId: 1, index: 0 }, NOW);
    expect(ids(workspace)).toEqual([1, 6, 2, 3, 4, 5]);
  });

  it('moves subtrees and rejects cycles and depth overflow', () => {
    const workspace = sample();
    moveTodoTo(workspace, 3, 5, undefined, NOW);
    expect(ids(workspace)).toEqual([1, 2, 5, 3, 4]);
    expect(() => moveTodoTo(workspace, 5, 4, undefined, NOW)).toThrow(CoreError);

    // Build a chain 5 deep and check the limit
    let parent = 5;
    for (let depth = 2; depth <= 5; depth++) {
      parent = addTodo(workspace, { name: `L${depth}`, weight: 1, desc: '', parentId: parent }, NOW).id;
    }
    expect(depthOf(workspace, parent)).toBe(5);
    expect(() => addTodo(workspace, { name: 'too deep', weight: 1, desc: '', parentId: parent }, NOW)).toThrow(/at most 5/);
    expect(canMoveTo(workspace, 3, parent)).toBe(false);
    expect(canMoveTo(workspace, 2, 4)).toBe(true);
  });
});

describe('timer', () => {
  it('runs one todo at a time', () => {
    const workspace = sample();
    startTodo(workspace, 2, at('2026-10-29 09:00:00'));
    startTodo(workspace, 4, at('2026-10-29 10:00:00'));
    expect(statusOf(workspace.todos[1])).toBe('paused');
    expect(workspace.todos[1].time).toEqual([{ start: at('2026-10-29 09:00:00'), end: at('2026-10-29 10:00:00') }]);
    expect(statusOf(workspace.todos[3])).toBe('running');
  });

  it('drops empty sessions and can discard the running one', () => {
    const workspace = sample();
    startTodo(workspace, 2, NOW);
    pauseTodo(workspace, 2, NOW + 400);
    expect(workspace.todos[1].time).toEqual([]);
    startTodo(workspace, 2, NOW);
    resetTimer(workspace, 2, NOW + 60000);
    expect(statusOf(workspace.todos[1])).toBe('new');
  });
});

describe('completing', () => {
  it('requires a choice for macrotasks with open subtasks', () => {
    const workspace = sample();
    expect(() => completeTodo(workspace, 1, NOW)).toThrow(/open subtask/);
    startTodo(workspace, 4, NOW - 60000);
    completeTodo(workspace, 1, NOW, true);
    expect([1, 2, 3, 4].map(id => statusOf(workspace.todos.find(todo => todo.id === id)!))).toEqual(['done', 'done', 'done', 'done']);
    expect(openSession(workspace.todos[3])).toBeNull();
  });

  it('tells when the parent becomes completable', () => {
    const workspace = sample();
    expect(parentReadyAfterCompleting(workspace, 3)).toBeNull(); // sibling 2 is still open
    completeTodo(workspace, 2, NOW);
    expect(parentReadyAfterCompleting(workspace, 3)?.id).toBe(1);
    expect(parentReadyAfterCompleting(workspace, 1)).toBeNull(); // top level
  });

  it('reopens done ancestors when a subtask starts or is added', () => {
    const workspace = sample();
    completeTodo(workspace, 1, NOW, true);
    startTodo(workspace, 4, NOW);
    expect(workspace.todos.filter(todo => todo.completed == null).map(todo => todo.id)).toEqual([1, 3, 4, 5]);
    completeTodo(workspace, 1, NOW, true);
    addTodo(workspace, { name: 'More', weight: 1, desc: '', parentId: 2 }, NOW);
    expect(workspace.todos.find(todo => todo.id === 1)?.completed).toBeNull();
  });
});

describe('deleting', () => {
  it('deletes subtrees or promotes children', () => {
    const subtree = sample();
    deleteTodo(subtree, 3, 'subtree', NOW);
    expect(ids(subtree)).toEqual([1, 2, 5]);
    const promote = sample();
    deleteTodo(promote, 1, 'promote', NOW);
    expect(promote.todos.map(todo => [todo.id, todo.parentId])).toEqual([
      [2, null],
      [3, null],
      [4, 3],
      [5, null],
    ]);
  });
});

describe('revisions', () => {
  it('stamps only what changed', () => {
    const before = sample();
    stampRevisions(emptyWorkspace('uid', 'tasks', ROME), before);
    expect(before.revision).toBe(1);
    const after = cloneWorkspace(before);
    startTodo(after, 2, NOW);
    expect(stampRevisions(before, after)).toBe(true);
    expect(after.revision).toBe(2);
    expect(after.todos.map(todo => todo.rev)).toEqual([1, 2, 1, 1, 1]);
    expect(stampRevisions(after, cloneWorkspace(after))).toBe(false);
  });
});

describe('rollups and stats', () => {
  it('sums own and subtree weights and time (a macrotask\'s own data is its implicit leaf)', () => {
    const workspace = sample();
    startTodo(workspace, 4, at('2026-10-29 10:00:00'));
    completeTodo(workspace, 2, at('2026-10-29 10:30:00'));
    const rollup = rollups(workspace, at('2026-10-29 11:00:00'));
    expect(rollup.get(1)).toMatchObject({ weight: 1 + 8 + 13 + 3, doneWeight: 8, totalMinutes: 60, leaf: false });
    expect(rollup.get(4)).toMatchObject({ weight: 3, totalMinutes: 60, leaf: true });
    expect(subtreeStatus(workspace, 1)).toBe('running');
    expect(subtreeStatus(workspace, 5)).toBe('new');
  });

  it('summarizes days, weeks and statuses including the running session', () => {
    const workspace = sample();
    workspace.todos[4].time.push({ day: '2026-10-26', minutes: 30 }); // Monday
    workspace.todos[4].time.push({ day: '2026-10-20', minutes: 15 }); // last week
    startTodo(workspace, 2, at('2026-10-29 11:00:00'));
    const summary = summarize(workspace, null, NOW);
    expect(summary).toMatchObject({ today: 60, week: 90, total: 105 });
    expect(summary.counts).toEqual({ new: 3, paused: 1, running: 1, done: 0 });
    expect(summary.weight).toEqual({ done: 0, total: 1 + 8 + 13 + 3 + 2 });
  });

  it('groups daily series by the children of a parent', () => {
    const workspace = sample();
    workspace.todos[3].time.push({ day: '2026-10-28', minutes: 20 });
    workspace.todos[1].time.push({ day: '2026-10-29', minutes: 10 });
    workspace.todos[4].time.push({ day: '2026-10-29', minutes: 5 });
    const top = dailySeries(workspace, null, null, 3, NOW);
    expect(top.days).toEqual(['2026-10-27', '2026-10-28', '2026-10-29']);
    expect(top.series).toEqual([
      { id: 1, name: 'Testing', values: [0, 20, 10] },
      { id: 5, name: 'Be happy', values: [0, 0, 5] },
    ]);
    const drill = dailySeries(workspace, null, 1, 3, NOW);
    expect(drill.series.map(series => series.name)).toEqual(['Test the testing', 'Suite']);
  });
});

describe('archive', () => {
  it('archives old done top-level subtrees and restores them', () => {
    const workspace = sample();
    const archive = emptyArchive(workspace);
    completeTodo(workspace, 1, at('2026-10-01 10:00:00'), true);
    completeTodo(workspace, 5, at('2026-10-28 10:00:00'));
    archiveDone(workspace, archive, NOW);
    expect(ids(workspace)).toEqual([5]);
    expect(ids(archive)).toEqual([1, 2, 3, 4]);
    restoreFromArchive(workspace, archive, 4);
    expect(ids(workspace)).toEqual([5, 1, 2, 3, 4]);
    expect(archive.todos).toEqual([]);
  });
});
