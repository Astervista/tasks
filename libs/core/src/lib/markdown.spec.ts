import { hashTodo, isEditedLocally, parseWorkspace, serializeWorkspace } from './markdown';
import { statusOf } from './model';
import { parseStamp } from './time';

const ROME = 'Europe/Rome';
const NOW = parseStamp('2026-10-29 12:00:00', ROME) as number;

export const SAMPLE = `---
uid: 9b2e6c1e-4f0a-4c5e-9a57-0d3f2a1b7c44
timezone: Europe/Rome
revision: 42
nextId: 7
archiveAfterDays: 14
---
# tasks

Todos with **timers** and statistics.

## Testing <!-- id:5 rev:40 -->
- weight: 1
- created: 2021-11-24 14:30:00

### Create testing suite <!-- id:1 rev:12 -->
- weight: 8
- created: 2021-11-24 14:34:24
- completed: 2021-11-25 07:37:44

### Test the testing <!-- id:2 rev:41 -->
- weight: 13
- created: 2021-11-24 17:37:44
- updated: 2026-10-29 10:12:03

Free markdown description with **bold** and a list:

- one
- two

\`\`\`
## not a heading inside a fence
\`\`\`

**Time**
- 2026-10-29 09:37:58 → running
- 2021-11-25 05:00:00 → 07:20:00
- 2021-11-24: 2h 20m

#### Edge cases <!-- id:6 rev:41 -->
- weight: 3
- created: 2021-11-24 17:40:00

## Be happy all has ended <!-- id:3 rev:7 -->
- weight: 2
- created: 2021-11-24 18:00:00
`;

describe('parseWorkspace', () => {
  const { workspace, issues } = parseWorkspace(SAMPLE, { now: NOW });

  it('reads the front matter and title', () => {
    expect(issues).toEqual([]);
    expect(workspace).toMatchObject({
      uid: '9b2e6c1e-4f0a-4c5e-9a57-0d3f2a1b7c44',
      name: 'tasks',
      description: 'Todos with **timers** and statistics.',
      timezone: ROME,
      revision: 42,
      nextId: 7,
      archiveAfterDays: 14,
    });
  });

  it('builds the hierarchy from heading levels', () => {
    expect(workspace.todos.map(todo => [todo.id, todo.parentId, todo.name])).toEqual([
      [5, null, 'Testing'],
      [1, 5, 'Create testing suite'],
      [2, 5, 'Test the testing'],
      [6, 2, 'Edge cases'],
      [3, null, 'Be happy all has ended'],
    ]);
  });

  it('reads metadata, description and time', () => {
    const todo = workspace.todos[2];
    expect(todo.weight).toBe(13);
    expect(todo.rev).toBe(41);
    expect(todo.desc).toContain('## not a heading inside a fence');
    expect(todo.desc.endsWith('```')).toBe(true);
    expect(todo.time).toEqual([
      { start: parseStamp('2026-10-29 09:37:58', ROME), end: null },
      { start: parseStamp('2021-11-25 05:00:00', ROME), end: parseStamp('2021-11-25 07:20:00', ROME) },
      { day: '2021-11-24', minutes: 140 },
    ]);
    expect(statusOf(todo)).toBe('running');
    expect(statusOf(workspace.todos[1])).toBe('done');
    expect(statusOf(workspace.todos[4])).toBe('new');
  });
});

describe('serializeWorkspace', () => {
  it('is byte-stable across round-trips', () => {
    const once = serializeWorkspace(parseWorkspace(SAMPLE, { now: NOW }).workspace);
    const twice = serializeWorkspace(parseWorkspace(once, { now: NOW }).workspace);
    expect(twice).toBe(once);
  });

  it('writes hashes that match unchanged todos and catch edits', () => {
    const written = serializeWorkspace(parseWorkspace(SAMPLE, { now: NOW }).workspace);
    const reread = parseWorkspace(written, { now: NOW }).workspace;
    expect(reread.todos.every(todo => !isEditedLocally(todo, ROME))).toBe(true);

    const edited = parseWorkspace(written.replace('- weight: 13', '- weight: 21'), { now: NOW }).workspace;
    expect(edited.todos.filter(todo => isEditedLocally(todo, ROME)).map(todo => todo.id)).toEqual([2]);

    // Moving a block under another parent counts as an edit of that todo only
    const moved = parseWorkspace(written.replace('#### Edge cases', '### Edge cases'), { now: NOW }).workspace;
    expect(moved.todos.filter(todo => isEditedLocally(todo, ROME)).map(todo => todo.id)).toEqual([6]);
  });

  it('omits sync metadata for todos that are not synced yet', () => {
    const { workspace } = parseWorkspace('# x\n\n## Hand written\n\n### Child\n', { now: NOW, timezone: ROME });
    expect(workspace.todos.map(todo => [todo.id, todo.parentId])).toEqual([
      [-1, null],
      [-2, -1],
    ]);
    const text = serializeWorkspace(workspace);
    expect(text).toContain('## Hand written\n- weight: 1');
    expect(text).not.toMatch(/^##+ .*<!--/m);
    expect(hashTodo(workspace.todos[0], ROME)).toMatch(/^[0-9a-f]{8}$/);
  });

  it('escapes description lines that would read as structure', () => {
    const { workspace } = parseWorkspace('# x\n\n## A\n- weight: 1\n', { now: NOW, timezone: ROME });
    workspace.todos[0].desc = '## sneaky\n**Time**\nok';
    const reread = parseWorkspace(serializeWorkspace(workspace), { now: NOW }).workspace;
    expect(reread.todos).toHaveLength(1);
    expect(reread.todos[0].time).toEqual([]);
  });
});

describe('tolerant parsing', () => {
  it('attaches skipped levels to the closest parent and clamps the depth', () => {
    const { workspace, issues } = parseWorkspace(
      '# x\n\n## A\n\n#### B\n\n###### C\n\n####### D\n',
      { now: NOW, timezone: ROME },
    );
    expect(workspace.todos.map(todo => [todo.name, todo.parentId])).toEqual([
      ['A', null],
      ['B', -1],
      ['C', -2],
      ['D', -3],
    ]);
    expect(issues.map(issue => issue.line)).toEqual([5, 7, 9]);
  });

  it('reports bad values with line numbers and keeps unknown time lines as text', () => {
    const { workspace, issues } = parseWorkspace(
      '# x\n\n## A\n- weight: lots\n- created: someday\n\n**Time**\n- whenever\n',
      { now: NOW, timezone: ROME },
    );
    expect(issues.map(issue => issue.line)).toEqual([4, 5, 8]);
    expect(workspace.todos[0].weight).toBe(1);
    expect(workspace.todos[0].created).toBe(NOW);
    expect(workspace.todos[0].desc).toBe('- whenever');
  });

  it('treats duplicate ids as new todos and keeps nextId ahead of all ids', () => {
    const { workspace, issues } = parseWorkspace(
      '---\nnextId: 2\ntimezone: UTC\n---\n# x\n\n## A <!-- id:9 -->\n\n## B <!-- id:9 -->\n',
      { now: NOW },
    );
    expect(workspace.todos.map(todo => todo.id)).toEqual([9, -1]);
    expect(workspace.nextId).toBe(10);
    expect(issues).toHaveLength(1);
  });

  it('accepts CRLF, ASCII arrows and clock-only ends', () => {
    const { workspace } = parseWorkspace(
      '# x\r\n\r\n## A\r\n- weight: 2\r\n\r\n**Time**\r\n- 2026-10-29 09:00 -> 10:30\r\n',
      { now: NOW, timezone: ROME },
    );
    expect(workspace.todos[0].time).toEqual([
      { start: parseStamp('2026-10-29 09:00:00', ROME), end: parseStamp('2026-10-29 10:30:00', ROME) },
    ]);
  });
});
