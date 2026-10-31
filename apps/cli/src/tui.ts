import { existsSync, readFileSync, statSync, watch } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  ancestorsOf,
  childrenOf,
  dailySeries,
  dayKeyToLabel,
  emptyArchive,
  etas,
  minutesPerWeight,
  projectEta,
  weightAccuracy,
  formatClock,
  formatDuration,
  formatStamp,
  isSession,
  openSession,
  parseWorkspace,
  rollups,
  Status,
  statusOf,
  subtreeStatus,
  summarize,
  Todo,
  TodoId,
  Workspace,
} from '@tasks/core';
import { ARCHIVE_FILE, TODO_FILE } from './project';

// --- Styling ---------------------------------------------------------------------------------------

const useColor = process.stdout.isTTY && process.env['NO_COLOR'] == null && process.stdout.hasColors?.(256) !== false;

/** The web app's nesting palette (the carnival chips) */
const LEVEL_COLORS = ['#ff2222', '#ff4500', '#ffa500', '#20b2aa', '#4169e1', '#cc44ff', '#ff1493'];
const STATUS_STYLE: Record<Status, { icon: string; color: string }> = {
  done: { icon: '✔', color: '#22c55e' },
  running: { icon: '▶', color: '#c6ff00' },
  paused: { icon: '⏸', color: '#ffc107' },
  new: { icon: '■', color: '#f44336' },
};
const DIM = '#9e9e9e';

function fg(hex: string, text: string): string {
  if (!useColor) return text;
  const [r, g, b] = [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16));
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}
const bold = (text: string) => (useColor ? `\x1b[1m${text}\x1b[22m` : text);
const inverse = (text: string) => (useColor ? `\x1b[7m${text}\x1b[27m` : `> ${text}`);
const dim = (text: string) => fg(DIM, text);

/** Visible width (ANSI codes stripped); good enough for the BMP characters used here */
function width(text: string): number {
  return text.replace(/\x1b\[[0-9;]*m/g, '').length;
}

function clip(text: string, max: number): string {
  if (max <= 0) return '';
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

function pad(text: string, size: number): string {
  return text + ' '.repeat(Math.max(0, size - width(text)));
}

function wrap(text: string, max: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      if (line !== '' && line.length + word.length + 1 > max) {
        lines.push(line);
        line = '';
      }
      line = line === '' ? word : `${line} ${word}`;
    }
    lines.push(line);
  }
  return lines;
}

function clock(minutes: number): string {
  const seconds = Math.floor(minutes * 60);
  const h = Math.floor(seconds / 3600);
  const m = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
  const s = String(seconds % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function bar(ratio: number, size: number, color: string): string {
  const filled = Math.round(Math.max(0, Math.min(1, ratio)) * size);
  return fg(color, '█'.repeat(filled)) + dim('░'.repeat(size - filled));
}

// --- Data ------------------------------------------------------------------------------------------

/** The TODO.md of `dir` or of the closest parent folder, like git finds its repository */
export function findTodoFile(dir: string): string | null {
  let current = resolve(dir);
  for (;;) {
    const file = join(current, TODO_FILE);
    if (existsSync(file)) return file;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

interface Loaded {
  workspace: Workspace;
  archive: Workspace;
  modified: number;
  issues: number;
}

function load(file: string): Loaded {
  const parsed = parseWorkspace(readFileSync(file, 'utf8'));
  const archiveFile = join(dirname(file), ARCHIVE_FILE);
  const archive = existsSync(archiveFile)
    ? parseWorkspace(readFileSync(archiveFile, 'utf8'), { timezone: parsed.workspace.timezone }).workspace
    : emptyArchive(parsed.workspace);
  return { workspace: parsed.workspace, archive, modified: statSync(file).mtimeMs, issues: parsed.issues.length };
}

// --- Views -----------------------------------------------------------------------------------------

interface State {
  file: string;
  data: Loaded;
  history: boolean;
  selected: number;
  scroll: number;
  collapsed: Set<TodoId>;
  details: TodoId | null;
}

interface Row {
  todo: Todo;
  depth: number;
  hasChildren: boolean;
}

function visibleRows(state: State): Row[] {
  const { workspace } = state.data;
  const rows: Row[] = [];
  const visit = (parentId: TodoId | null, depth: number) => {
    for (const todo of childrenOf(workspace, parentId)) {
      const hasChildren = childrenOf(workspace, todo.id).length > 0;
      rows.push({ todo, depth, hasChildren });
      if (hasChildren && !state.collapsed.has(todo.id)) visit(todo.id, depth + 1);
    }
  };
  visit(null, 1);
  return rows;
}

function header(state: State, columns: number, now: number): string[] {
  const { workspace, archive, modified, issues } = state.data;
  const lines: string[] = [];
  const title = `${fg(LEVEL_COLORS[0], '▌')}${bold(fg('#ffffff', ` ${workspace.name} `))}`;
  const meta = dim(`rev ${workspace.revision} · ${workspace.timezone} · saved ${formatStamp(modified, workspace.timezone)}`);
  lines.push(`${title}  ${meta}`);
  if (workspace.description !== '') {
    for (const line of wrap(workspace.description, columns - 2).slice(0, 3)) lines.push(` ${dim(line)}`);
  }
  if (issues > 0) lines.push(` ${fg('#ff3c63', `⚠ ${issues} problem(s) reading ${TODO_FILE}; run "tasks sync" for details`)}`);
  lines.push('');

  const summary = summarize(workspace, archive, now);
  const ratio = summary.weight.total === 0 ? 0 : summary.weight.done / summary.weight.total;
  lines.push(
    ` Today ${bold(formatDuration(Math.floor(summary.today)))}   Week ${bold(formatDuration(Math.floor(summary.week)))}   ` +
      `All time ${bold(formatDuration(Math.floor(summary.total)))}   Done ${bar(ratio, 16, '#cd5c5c')} ${Math.round(ratio * 100)}%` +
      dim(` (${round(summary.weight.done)}/${round(summary.weight.total)})`),
  );
  const eta = projectEta(workspace, archive, now);
  if (workspace.todos.some(todo => todo.completed == null)) {
    const finish = eta.finish != null ? `ETA ${bold(dayKeyToLabel(eta.finish, 'medium'))} · ` : '';
    const unknown = eta.unknown > 0 ? dim(` + ${eta.unknown} without a guess`) : '';
    const pace = eta.pace != null ? dim(` · pace ${formatDuration(Math.floor(eta.pace))}/day`) : dim(` · no date yet (needs 3 days of work, ${eta.activeDays} so far)`);
    lines.push(` ${fg('#ffd700', '⏱')} ${finish}~${formatDuration(Math.floor(eta.remaining))} left${unknown}${pace}`);
  }
  const running = workspace.todos.find(todo => openSession(todo) != null);
  if (running != null) {
    const session = openSession(running)!;
    const path = [...ancestorsOf(workspace, running.id).reverse().map(todo => todo.name), running.name].join(' › ');
    lines.push(` ${fg(STATUS_STYLE.running.color, `▶ ${clip(path, columns - 20)}`)}  ${bold(clock((now - session.start) / 60000))}`);
  }
  lines.push(dim('─'.repeat(columns)));
  return lines;
}

function todoLines(state: State, columns: number, now: number): { lines: string[]; selectedLine: number } {
  const { workspace } = state.data;
  const rows = visibleRows(state);
  const rollup = rollups(workspace, now);
  const eta = etas(workspace, now, state.data.archive.todos);
  const lines: string[] = [];
  let selectedLine = 0;
  if (rows.length === 0) {
    lines.push(dim(' No todos yet. Add a "## Something to do" heading to TODO.md, or use the web app.'));
  }
  rows.forEach((row, index) => {
    const { todo, depth, hasChildren } = row;
    const status = subtreeStatus(workspace, todo.id);
    const style = STATUS_STYLE[status];
    const info = rollup.get(todo.id)!;
    const weight = round(info.weight);
    const time = info.totalMinutes > 0 ? formatDuration(Math.floor(info.totalMinutes)) : '–';
    const left = status === 'done' ? '' : eta.get(todo.id)!.unknown > 0 && !hasChildren ? '?' : `~${formatDuration(Math.floor(eta.get(todo.id)!.remaining))}`;
    const right = `${weight.padStart(7)}  ${time.padStart(9)}  ${left.padStart(8)}`;
    const fold = hasChildren ? (state.collapsed.has(todo.id) ? '▸' : '▾') : ' ';
    const indent = '  '.repeat(depth - 1);
    const nameRoom = columns - right.length - indent.length - 8;
    const name = clip(todo.name, nameRoom);
    let line =
      ` ${indent}${fg(LEVEL_COLORS[(depth - 1) % LEVEL_COLORS.length], '▌')}${fold} ${fg(style.color, style.icon)} ` +
      `${status === 'running' ? bold(name) : status === 'done' ? dim(name) : name}`;
    line = pad(line, columns - right.length - 1) + dim(right);
    if (index === state.selected) {
      selectedLine = lines.length;
      line = inverse(pad(line, columns));
    }
    lines.push(line);
    if (hasChildren && !state.collapsed.has(todo.id)) {
      // The implicit leaf: the work on the macrotask itself (its own fields); not selectable
      const ownStatus = statusOf(todo);
      const ownEta = eta.get(todo.id)!.own;
      const ownStyle = STATUS_STYLE[ownStatus];
      const ownTime = info.ownMinutes > 0 ? formatDuration(Math.floor(info.ownMinutes)) : '–';
      const ownLeft = ownStatus === 'done' ? '' : ownEta.remaining == null ? '?' : `~${formatDuration(Math.floor(ownEta.remaining))}`;
      const ownRight = `${round(todo.weight).padStart(7)}  ${ownTime.padStart(9)}  ${ownLeft.padStart(8)}`;
      const ownIndent = '  '.repeat(depth);
      const ownLine = ` ${ownIndent}${fg(LEVEL_COLORS[depth % LEVEL_COLORS.length], '┊')}  ${fg(ownStyle.color, ownStyle.icon)} ${dim('⋯')}`;
      lines.push(pad(ownLine, columns - ownRight.length - 1) + dim(ownRight));
    }
    if (state.details === todo.id) {
      const box = ' '.repeat(indent.length + 6);
      const created = `created ${formatStamp(todo.created, workspace.timezone)}` +
        (todo.completed != null ? ` · completed ${formatStamp(todo.completed, workspace.timezone)}` : '');
      lines.push(box + dim(created));
      const own = eta.get(todo.id)!.own;
      if (todo.completed == null) {
        lines.push(box + fg('#ffd700', (hasChildren ? 'Own: ' : '') + (own.total == null
          ? 'No estimate yet'
          : `Estimate ${formatDuration(Math.floor(own.total))}${own.source === 'check-in' ? ' (refined by check-ins)' : own.source === 'weight' ? ' (from weight)' : ''}` +
            ` · ${own.over ? `over by ${formatDuration(Math.floor(own.spent - own.total))}` : `~${formatDuration(Math.floor(own.remaining ?? 0))} left`}`)));
      }
      for (const checkin of [...todo.checkins].sort((a, b) => b.at - a.at).slice(0, 3)) {
        lines.push(box + dim(`check-in ${formatStamp(checkin.at, workspace.timezone)} · ${Math.round(checkin.progress * 100)}%${checkin.note ? ` · ${checkin.note}` : ''}`));
      }
      for (const text of todo.desc === '' ? [] : wrap(todo.desc, columns - box.length - 1)) lines.push(box + text);
      const sessions = todo.time.filter(isSession).sort((a, b) => b.start - a.start).slice(0, 5);
      for (const session of sessions) {
        const end = session.end == null ? fg(STATUS_STYLE.running.color, 'running') : formatClock(session.end, workspace.timezone);
        const minutes = ((session.end ?? now) - session.start) / 60000;
        lines.push(box + dim(`${formatStamp(session.start, workspace.timezone)} → ${end}  ${formatDuration(Math.floor(minutes))}`));
      }
    }
  });
  return { lines, selectedLine };
}

function historyLines(state: State, columns: number, now: number): string[] {
  const { workspace, archive } = state.data;
  const timezone = workspace.timezone;
  const lines: string[] = [bold(' Last 14 days')];
  const chart = dailySeries(workspace, archive, null, 14, now);
  const colors = new Map(chart.series.map((series, index) => [series.id, LEVEL_COLORS[index % LEVEL_COLORS.length]]));
  const totals = chart.days.map((_, day) => chart.series.reduce((sum, series) => sum + series.values[day], 0));
  const max = Math.max(1, ...totals);
  const room = Math.max(10, columns - 24);
  chart.days.forEach((day, index) => {
    let segment = '';
    for (const series of chart.series) {
      const cells = Math.round((series.values[index] / max) * room);
      segment += fg(colors.get(series.id)!, '█'.repeat(cells));
    }
    lines.push(` ${pad(dayKeyToLabel(day, 'short'), 7)} ${pad(segment, room)} ${totals[index] > 0 ? formatDuration(Math.floor(totals[index])) : dim('–')}`);
  });
  if (chart.series.length > 0) {
    lines.push(' ' + chart.series.map(series => `${fg(colors.get(series.id)!, '█')} ${series.name}`).join('   '));
  }

  const finished = [...workspace.todos, ...archive.todos];
  const rate = minutesPerWeight(finished, now);
  if (rate != null) {
    const accuracy = weightAccuracy(finished, rate, now);
    const error = accuracy.typicalError == null ? '' : ` · typically off by ±${Math.round(accuracy.typicalError * 100)}%`;
    const range = accuracy.low == null || accuracy.high == null ? '' : ` · usually ${accuracy.low.toFixed(2)}× – ${accuracy.high.toFixed(2)}× of the guess`;
    lines.push('', ` ${fg('#ffd700', '⚖')} 1 weight point ≈ ${bold(formatDuration(Math.round(rate)))}${error}${range}` + dim(` (${accuracy.samples.length} finished)`));
  }

  lines.push('', bold(' Sessions'));
  const sessions = [workspace, archive].flatMap(source =>
    source.todos.flatMap(todo => todo.time.filter(isSession).map(session => ({ source, todo, session }))),
  ).sort((a, b) => b.session.start - a.session.start);
  if (sessions.length === 0) lines.push(dim(' No sessions logged yet.'));
  for (const { source, todo, session } of sessions.slice(0, 200)) {
    const minutes = ((session.end ?? now) - session.start) / 60000;
    const end = session.end == null ? fg(STATUS_STYLE.running.color, 'running ') : formatClock(session.end, timezone);
    const path = [...ancestorsOf(source, todo.id).reverse().map(item => item.name), todo.name].join(' › ');
    lines.push(` ${dim(formatStamp(session.start, timezone))} → ${end}  ${formatDuration(Math.floor(minutes)).padStart(7)}  ${clip(path, columns - 48)}`);
  }

  lines.push('', bold(' Completed'));
  const done = [...workspace.todos.map(todo => ({ todo, archived: false })), ...archive.todos.map(todo => ({ todo, archived: true }))]
    .filter(item => item.todo.completed != null)
    .sort((a, b) => b.todo.completed! - a.todo.completed!);
  if (done.length === 0) lines.push(dim(' Nothing completed yet.'));
  for (const { todo, archived } of done) {
    lines.push(` ${fg(STATUS_STYLE.done.color, '✔')} ${dim(formatStamp(todo.completed!, timezone).slice(0, 16))}  ${clip(todo.name, columns - 34)}${archived ? dim('  (archived)') : ''}`);
  }
  return lines;
}

function render(state: State, columns: number, rows: number, now: number): string[] {
  const top = header(state, columns, now);
  const footer = dim(state.history
    ? ' ↑↓ scroll   h back to todos   q quit'
    : ' ↑↓ move   ←→ fold   ⏎ details   h history   q quit');
  const room = Math.max(3, rows - top.length - 1);
  let body: string[];
  if (state.history) {
    body = historyLines(state, columns, now);
    state.scroll = Math.max(0, Math.min(state.scroll, body.length - room));
  } else {
    const { lines, selectedLine } = todoLines(state, columns, now);
    body = lines;
    // Keep the selection on screen
    if (selectedLine < state.scroll) state.scroll = selectedLine;
    if (selectedLine >= state.scroll + room) state.scroll = selectedLine - room + 1;
    state.scroll = Math.max(0, Math.min(state.scroll, Math.max(0, body.length - room)));
  }
  const visible = body.slice(state.scroll, state.scroll + room);
  while (visible.length < room) visible.push('');
  return [...top, ...visible, footer];
}

// --- Command ---------------------------------------------------------------------------------------

/** `tasks show`: browse the TODO.md of the current project in the terminal */
export async function show(dirArg: string | undefined, history: boolean): Promise<void> {
  const file = findTodoFile(dirArg ?? '.');
  if (file == null) {
    throw new Error(`No ${TODO_FILE} here or in any parent folder. Run "tasks init" to create one.`);
  }
  const state: State = { file, data: load(file), history, selected: 0, scroll: 0, collapsed: new Set(), details: null };

  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    // Not a terminal (piped, redirected): print everything once, nothing selected
    const columns = 100;
    state.selected = -1;
    const lines = [...header(state, columns, Date.now()), ...(history ? historyLines(state, columns, Date.now()) : todoLines(state, columns, Date.now()).lines)];
    console.log(lines.map(line => line.trimEnd()).join('\n'));
    return;
  }

  const out = process.stdout;
  const draw = () => {
    const lines = render(state, out.columns ?? 100, out.rows ?? 30, Date.now());
    out.write('\x1b[H' + lines.map(line => `${line}\x1b[K`).join('\r\n') + '\x1b[J');
  };
  const reload = () => {
    try {
      state.data = load(file);
      state.selected = Math.min(state.selected, Math.max(0, visibleRows(state).length - 1));
      draw();
    } catch {
      // half-written file: the next change event redraws
    }
  };

  out.write('\x1b[?1049h\x1b[?25l');
  const ticker = setInterval(draw, 1000);
  let debounce: NodeJS.Timeout | null = null;
  // The daemon rewrites the file atomically: watch the folder
  const watcher = watch(dirname(file), (_event, name) => {
    if (name?.toString() !== TODO_FILE && name?.toString() !== ARCHIVE_FILE) return;
    if (debounce != null) clearTimeout(debounce);
    debounce = setTimeout(reload, 150);
  });
  out.on('resize', draw);
  process.stdin.setRawMode(true);
  process.stdin.resume();

  await new Promise<void>(done => {
    const quit = () => {
      clearInterval(ticker);
      watcher.close();
      process.stdin.setRawMode(false);
      process.stdin.pause();
      out.write('\x1b[?25h\x1b[?1049l');
      done();
    };
    process.stdin.on('data', (chunk: Buffer) => {
      const key = chunk.toString();
      const rows = visibleRows(state);
      const current = rows[state.selected];
      switch (key) {
        case 'q':
        case '\x03':
        case '\x1b':
          quit();
          return;
        case 'h':
          state.history = !state.history;
          state.scroll = 0;
          break;
        case '\x1b[A':
        case 'k':
          if (state.history) state.scroll--;
          else state.selected = Math.max(0, state.selected - 1);
          break;
        case '\x1b[B':
        case 'j':
          if (state.history) state.scroll++;
          else state.selected = Math.min(rows.length - 1, state.selected + 1);
          break;
        case '\x1b[5~':
          if (state.history) state.scroll -= (out.rows ?? 30) - 10;
          else state.selected = Math.max(0, state.selected - ((out.rows ?? 30) - 10));
          break;
        case '\x1b[6~':
          if (state.history) state.scroll += (out.rows ?? 30) - 10;
          else state.selected = Math.min(rows.length - 1, state.selected + ((out.rows ?? 30) - 10));
          break;
        case '\x1b[D':
          if (current?.hasChildren && !state.collapsed.has(current.todo.id)) {
            state.collapsed.add(current.todo.id);
          } else if (current?.todo.parentId != null) {
            // Jump to the parent, like a file tree
            state.selected = rows.findIndex(row => row.todo.id === current.todo.parentId);
          }
          break;
        case '\x1b[C':
          if (current?.hasChildren) state.collapsed.delete(current.todo.id);
          break;
        case '\r':
        case ' ':
          if (current != null) state.details = state.details === current.todo.id ? null : current.todo.id;
          break;
      }
      draw();
    });
    draw();
  });
}

function round(value: number): string {
  return String(Number(value.toFixed(2)));
}
