import { emptyWorkspace } from './model';
import { parseStamp } from './time';
import { timeline, todoTimeline } from './timeline';
import { addTodo, completeTodo, pauseTodo, startTodo } from './transitions';

const ROME = 'Europe/Rome';
const at = (stamp: string) => parseStamp(stamp, ROME) as number;

describe('timeline', () => {
  it('splits a todo\'s life into not started, active, on a subtask and paused', () => {
    const workspace = emptyWorkspace('u', 'p', ROME);
    const macro = addTodo(workspace, { name: 'Macro', weight: 1, desc: '' }, at('2026-10-30 08:00:00'));
    const child = addTodo(workspace, { name: 'Child', weight: 1, desc: '', parentId: macro.id }, at('2026-10-30 08:00:00'));
    startTodo(workspace, macro.id, at('2026-10-30 09:00:00'));
    pauseTodo(workspace, macro.id, at('2026-10-30 10:00:00'));
    startTodo(workspace, child.id, at('2026-10-30 11:00:00'));
    pauseTodo(workspace, child.id, at('2026-10-30 12:00:00'));
    completeTodo(workspace, macro.id, at('2026-10-30 13:00:00'), true);
    const [row] = timeline(workspace, at('2026-10-30 18:00:00'));
    expect(row.phases.map(phase => [phase.kind, phase.start, phase.end])).toEqual([
      ['new', at('2026-10-30 08:00:00'), at('2026-10-30 09:00:00')],
      ['active', at('2026-10-30 09:00:00'), at('2026-10-30 10:00:00')],
      ['paused', at('2026-10-30 10:00:00'), at('2026-10-30 11:00:00')],
      ['subtask', at('2026-10-30 11:00:00'), at('2026-10-30 12:00:00')],
      ['paused', at('2026-10-30 12:00:00'), at('2026-10-30 13:00:00')],
    ]);
    expect(row).toMatchObject({ depth: 1, end: at('2026-10-30 13:00:00') });
  });

  it('runs open todos until now and places day totals around noon', () => {
    const workspace = emptyWorkspace('u', 'p', ROME);
    const todo = addTodo(workspace, { name: 'A', weight: 1, desc: '' }, at('2026-10-29 08:00:00'));
    todo.time.push({ day: '2026-10-29', minutes: 120 });
    startTodo(workspace, todo.id, at('2026-10-30 09:00:00'));
    const [row] = timeline(workspace, at('2026-10-30 10:00:00'));
    expect(row.phases.map(phase => phase.kind)).toEqual(['new', 'active', 'paused', 'active']);
    expect(row.phases[1]).toMatchObject({ start: at('2026-10-29 11:00:00'), end: at('2026-10-29 13:00:00'), approximate: true });
    expect(row.phases[3].end).toBe(at('2026-10-30 10:00:00'));
  });
});

describe('implicit leaf timeline', () => {
  it('shows only the macrotask\'s own work, subtask work counting as paused', () => {
    const workspace = emptyWorkspace('u', 'p', ROME);
    const macro = addTodo(workspace, { name: 'Macro', weight: 1, desc: '' }, at('2026-10-30 08:00:00'));
    const child = addTodo(workspace, { name: 'Child', weight: 1, desc: '', parentId: macro.id }, at('2026-10-30 08:00:00'));
    startTodo(workspace, macro.id, at('2026-10-30 09:00:00'));
    pauseTodo(workspace, macro.id, at('2026-10-30 10:00:00'));
    startTodo(workspace, child.id, at('2026-10-30 11:00:00'));
    pauseTodo(workspace, child.id, at('2026-10-30 12:00:00'));
    const row = todoTimeline(workspace, macro, at('2026-10-30 13:00:00'), false);
    expect(row.phases.map(phase => phase.kind)).toEqual(['new', 'active', 'paused']);
  });
});
