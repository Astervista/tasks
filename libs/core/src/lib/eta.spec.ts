import { estimateAccuracy, etas, minutesPerWeight, projectEta, todoEta, weightAccuracy } from './eta';
import { parseWorkspace, serializeWorkspace } from './markdown';
import { emptyWorkspace, findTodo, Workspace } from './model';
import { parseStamp } from './time';
import { addTodo, checkIn, completeTodo, editTodo, pauseTodo, pauseTodoAt, startTodo } from './transitions';

const ROME = 'Europe/Rome';
const at = (stamp: string) => parseStamp(stamp, ROME) as number;
const NOW = at('2026-10-30 12:00:00');

/** A todo that ran from 09:00 to `end` */
function worked(workspace: Workspace, id: number, end: string): void {
  startTodo(workspace, id, at('2026-10-30 09:00:00'));
  pauseTodo(workspace, id, at(end));
}

describe('todo ETA', () => {
  it('starts from the estimate and counts down', () => {
    const workspace = emptyWorkspace('u', 'p', ROME);
    const todo = addTodo(workspace, { name: 'A', weight: 1, desc: '', estimate: 240 }, NOW);
    worked(workspace, todo.id, '2026-10-30 10:00:00');
    expect(todoEta(todo, null, ROME, NOW)).toMatchObject({ total: 240, spent: 60, remaining: 180, source: 'estimate', over: false });
  });

  it('guesses from weight and the minutes per weight point of finished work', () => {
    const workspace = emptyWorkspace('u', 'p', ROME);
    const done = addTodo(workspace, { name: 'Done', weight: 2, desc: '' }, NOW);
    worked(workspace, done.id, '2026-10-30 10:00:00'); // 60 min for weight 2
    completeTodo(workspace, done.id, NOW);
    const next = addTodo(workspace, { name: 'Next', weight: 5, desc: '' }, NOW);
    const rate = minutesPerWeight(workspace.todos, NOW);
    expect(rate).toBe(30);
    expect(todoEta(next, rate, ROME, NOW)).toMatchObject({ total: 150, remaining: 150, source: 'weight' });
  });

  it('refines the guess with check-ins, trusting later ones more', () => {
    const workspace = emptyWorkspace('u', 'p', ROME);
    const todo = addTodo(workspace, { name: 'A', weight: 1, desc: '', estimate: 120 }, NOW);
    worked(workspace, todo.id, '2026-10-30 10:00:00');
    // 60 minutes in, "25% done": projects to 240; blended 0.75 × 120 + 0.25 × 240 = 150
    checkIn(workspace, todo.id, 0.25, 'slower than hoped', at('2026-10-30 10:00:00'));
    expect(todoEta(todo, null, ROME, NOW)).toMatchObject({ total: 150, remaining: 90, progress: 0.25, source: 'check-in' });
    // "80% done" at the same point: 0.2 × 120 + 0.8 × 75 = 84
    checkIn(workspace, todo.id, 0.8, '', at('2026-10-30 10:05:00'));
    expect(todoEta(todo, null, ROME, NOW).total).toBeCloseTo(0.2 * 120 + 0.8 * 75, 5);
  });

  it('ignores very early check-ins and marks overruns', () => {
    const workspace = emptyWorkspace('u', 'p', ROME);
    const todo = addTodo(workspace, { name: 'A', weight: 1, desc: '', estimate: 30 }, NOW);
    worked(workspace, todo.id, '2026-10-30 10:00:00');
    checkIn(workspace, todo.id, 0.01, '', at('2026-10-30 10:00:00'));
    expect(todoEta(todo, null, ROME, NOW)).toMatchObject({ total: 30, remaining: 0, over: true, source: 'estimate' });
  });

  it('knows nothing without estimate, history or check-ins', () => {
    const workspace = emptyWorkspace('u', 'p', ROME);
    const todo = addTodo(workspace, { name: 'A', weight: 1, desc: '' }, NOW);
    expect(todoEta(todo, null, ROME, NOW)).toMatchObject({ total: null, remaining: null, source: null });
  });
});

describe('project ETA', () => {
  it('adds up macrotasks and spreads the remaining work over the daily pace', () => {
    const workspace = emptyWorkspace('u', 'p', ROME);
    // Weight 0: no work expected on the macrotask itself
    const macro = addTodo(workspace, { name: 'Macro', weight: 0, desc: '' }, NOW);
    const a = addTodo(workspace, { name: 'A', weight: 1, desc: '', estimate: 300, parentId: macro.id }, NOW);
    addTodo(workspace, { name: 'B', weight: 1, desc: '', estimate: 120, parentId: macro.id }, NOW);
    // Work since Oct 17 (14 days to today): 840 minutes = 60 a day, days off included
    a.time.push({ day: '2026-10-17', minutes: 400 }, { day: '2026-10-20', minutes: 380 });
    worked(workspace, a.id, '2026-10-30 10:00:00');
    const tree = etas(workspace, NOW);
    expect(tree.get(macro.id)).toMatchObject({ remaining: 0 + 120, unknown: 0 });
    const eta = projectEta(workspace, null, NOW);
    expect(eta.pace).toBe(60);
    expect(eta.remaining).toBe(120);
    expect(eta.finish).toBe('2026-10-31');
  });

  it('measures the pace from the first day worked, and only with enough history', () => {
    const workspace = emptyWorkspace('u', 'p', ROME);
    const a = addTodo(workspace, { name: 'A', weight: 1, desc: '', estimate: 600 }, NOW);
    // One short session ever: no pace, no date (it used to project weeks away)
    a.time.push({ start: at('2026-10-30 09:00:00'), end: at('2026-10-30 09:14:00') });
    expect(projectEta(workspace, null, NOW)).toMatchObject({ pace: null, activeDays: 1, finish: null });
    // Three days of work since Oct 28: 360 minutes over 3 calendar days = 120 a day
    a.time.push({ day: '2026-10-28', minutes: 200 }, { day: '2026-10-29', minutes: 146 });
    const eta = projectEta(workspace, null, NOW);
    expect(eta.pace).toBe(120);
    expect(eta.remaining).toBe(240);
    expect(eta.finish).toBe('2026-10-31');
  });

  it('treats a macrotask\'s own fields as an implicit leaf next to its subtasks', () => {
    const workspace = emptyWorkspace('u', 'p', ROME);
    const macro = addTodo(workspace, { name: 'Macro', weight: 2, desc: '', estimate: 60 }, NOW);
    addTodo(workspace, { name: 'A', weight: 1, desc: '', estimate: 120, parentId: macro.id }, NOW);
    // 20 minutes of general work on the macrotask itself: they count against its own 60
    startTodo(workspace, macro.id, at('2026-10-30 09:00:00'));
    pauseTodo(workspace, macro.id, at('2026-10-30 09:20:00'));
    const eta = etas(workspace, NOW).get(macro.id)!;
    expect(eta.own).toMatchObject({ total: 60, spent: 20, remaining: 40, source: 'estimate' });
    expect(eta).toMatchObject({ remaining: 40 + 120, unknown: 0 });
    expect(eta.progress).toBeCloseTo(20 / (20 + 160), 10);
    // Without an estimate, weight 2 needs a rate; weight 0 means nothing to do
    editTodo(workspace, macro.id, { estimate: null }, NOW);
    expect(etas(workspace, NOW).get(macro.id)).toMatchObject({ remaining: 120, unknown: 1 });
    editTodo(workspace, macro.id, { weight: 0 }, NOW);
    expect(etas(workspace, NOW).get(macro.id)).toMatchObject({ remaining: 120, unknown: 0, own: { over: true } });
  });

  it('learns from finished macrotasks as implicit leaves', () => {
    const workspace = emptyWorkspace('u', 'p', ROME);
    const macro = addTodo(workspace, { name: 'Macro', weight: 2, desc: '' }, NOW);
    const leaf = addTodo(workspace, { name: 'A', weight: 1, desc: '', parentId: macro.id }, NOW);
    macro.time.push({ day: '2026-10-01', minutes: 60 });
    leaf.time.push({ day: '2026-10-01', minutes: 30 });
    completeTodo(workspace, macro.id, NOW, true);
    // (60 + 30) minutes for (2 + 1) points
    expect(minutesPerWeight(workspace.todos, NOW)).toBe(30);
  });

  it('has no finish day while some open work cannot be guessed', () => {
    const workspace = emptyWorkspace('u', 'p', ROME);
    const a = addTodo(workspace, { name: 'A', weight: 1, desc: '', estimate: 60 }, NOW);
    addTodo(workspace, { name: 'Unknown', weight: 1, desc: '' }, NOW);
    worked(workspace, a.id, '2026-10-30 09:30:00');
    expect(projectEta(workspace, null, NOW)).toMatchObject({ remaining: 30, unknown: 1, finish: null });
  });
});

describe('estimates and check-ins in TODO.md', () => {
  it('round-trips and pauses at a past moment', () => {
    const workspace = emptyWorkspace('u', 'p', ROME);
    const todo = addTodo(workspace, { name: 'A', weight: 1, desc: 'notes', estimate: 90 }, NOW);
    startTodo(workspace, todo.id, at('2026-10-30 09:00:00'));
    checkIn(workspace, todo.id, 0.4, 'parser done · tests next', at('2026-10-30 09:45:00'));
    // Nobody answered the next check-in at 10:30: the timer stops there, not at noon
    pauseTodoAt(workspace, todo.id, at('2026-10-30 10:30:00'), NOW);
    const text = serializeWorkspace(workspace);
    expect(text).toContain('- estimate: 1h 30m');
    expect(text).toContain('**Check-ins**\n- 2026-10-30 09:45:00 · 40% · parser done · tests next');
    expect(text).toContain('- 2026-10-30 09:00:00 → 10:30:00');
    const reread = parseWorkspace(text).workspace;
    expect(findTodo(reread, todo.id)).toMatchObject({ estimate: 90, desc: 'notes', checkins: [{ progress: 0.4, note: 'parser done · tests next' }] });
    expect(serializeWorkspace(reread)).toBe(text);
  });
});

describe('weight as an estimate', () => {
  /** Finished todos: [weight, minutes, estimate?] */
  function history(items: [number, number, number?][]): Workspace {
    const workspace = emptyWorkspace('u', 'p', ROME);
    for (const [weight, minutes, estimate] of items) {
      const todo = addTodo(workspace, { name: `w${weight}`, weight, desc: '', estimate: estimate ?? null }, NOW);
      todo.time.push({ day: '2026-10-01', minutes });
      completeTodo(workspace, todo.id, NOW);
    }
    return workspace;
  }

  it('measures minutes per weight point and how far off it typically is', () => {
    // 1 → 30, 2 → 60, 2 → 120, 5 → 90: 300 minutes for 10 points = 30 per point
    const workspace = history([[1, 30], [2, 60], [2, 120], [5, 90]]);
    const rate = minutesPerWeight(workspace.todos, NOW);
    expect(rate).toBe(30);
    const accuracy = weightAccuracy(workspace.todos, rate, NOW);
    // ratios: 1, 1, 2, 0.6 → errors 0, 0, 1, 0.4 → median 0.2
    expect(accuracy.samples.map(sample => sample.ratio)).toEqual([1, 1, 2, 0.6]);
    expect(accuracy.typicalError).toBeCloseTo(0.2, 10);
    expect(accuracy.low).toBeCloseTo(0.9, 10);
    expect(accuracy.high).toBeCloseTo(1.25, 10);
  });

  it('measures explicit estimates separately', () => {
    const workspace = history([[1, 90, 60], [1, 30, 60], [1, 45]]);
    const accuracy = estimateAccuracy(workspace.todos, NOW);
    expect(accuracy.samples.map(sample => sample.ratio)).toEqual([1.5, 0.5]);
    expect(accuracy.typicalError).toBe(0.5);
  });

  it('borrows the rate of all projects while a project has no finished work', () => {
    const workspace = emptyWorkspace('u', 'p', ROME);
    const todo = addTodo(workspace, { name: 'A', weight: 4, desc: '' }, NOW);
    expect(etas(workspace, NOW).get(todo.id)?.unknown).toBe(1);
    expect(etas(workspace, NOW, [], 25).get(todo.id)).toMatchObject({ remaining: 100, unknown: 0, own: { source: 'weight' } });
    expect(projectEta(workspace, null, NOW, 25)).toMatchObject({ remaining: 100, unknown: 0 });
  });
});
