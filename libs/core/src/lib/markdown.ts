/**
 * TODO.md format: front matter, an H1 with the workspace name, then one heading per todo where the
 * heading level is the nesting depth (## = top level … ###### = depth 5). Under each heading:
 * metadata bullets, a free Markdown description, and an optional **Time** list. The text between the
 * title and the first todo is the project description.
 *
 * ---
 * uid: 9b2e6c1e-…
 * timezone: Europe/Rome
 * revision: 42
 * nextId: 7
 * archiveAfterDays: 14
 * ---
 * # tasks
 *
 * What the project is about (free Markdown, no headings).
 *
 * ## Test the testing <!-- id:2 rev:41 h:1a2b3c4d -->
 * - weight: 13
 * - created: 2021-11-24 17:37:44
 *
 * Description…
 *
 * **Time**
 * - 2026-10-29 09:37:58 → running
 * - 2021-11-25 05:00:00 → 07:20:00
 * - 2021-11-24: 2h 20m
 *
 * serialize(parse(serialize(x))) is byte-identical to serialize(x), so syncing never ping-pongs.
 */
import {
  CheckIn,
  DayTotal,
  DEFAULT_ARCHIVE_AFTER_DAYS,
  isSession,
  MAX_DEPTH,
  TimeEntry,
  Todo,
  TodoId,
  Workspace,
} from './model';
import {
  dayKeyOf,
  formatClock,
  formatDuration,
  formatStamp,
  isValidTimeZone,
  Millis,
  parseClock,
  parseDayKey,
  parseDuration,
  parseStamp,
  startOfDay,
} from './time';

export interface ParseIssue {
  line: number;
  message: string;
}

export interface ParseResult {
  workspace: Workspace;
  issues: ParseIssue[];
}

export interface ParseOptions {
  /** Used for missing `created` values */
  now?: Millis;
  /** Used when the front matter has no valid timezone */
  timezone?: string;
}

const TIME_LABEL = '**Time**';
const CHECKIN_LABEL = '**Check-ins**';

// ---------------------------------------------------------------------------------------------------
// Serialization

export function serializeWorkspace(workspace: Workspace): string {
  const lines: string[] = [
    '---',
    `uid: ${workspace.uid}`,
    `timezone: ${workspace.timezone}`,
    `revision: ${workspace.revision}`,
    `nextId: ${workspace.nextId}`,
    `archiveAfterDays: ${workspace.archiveAfterDays}`,
    '---',
    `# ${cleanName(workspace.name)} <!-- ${workspace.metaRev == null ? '' : `rev:${workspace.metaRev} `}h:${hashMeta(workspace)} -->`,
  ];
  const description = cleanDescription(workspace.description);
  if (description !== '') {
    lines.push('', description);
  }
  const depths = depthMap(workspace);
  for (const todo of workspace.todos) {
    lines.push('', headingLine(todo, depths.get(todo.id) ?? 1, workspace.timezone), todoBody(todo, workspace.timezone));
  }
  return lines.join('\n') + '\n';
}

function headingLine(todo: Todo, depth: number, timezone: string): string {
  const level = '#'.repeat(Math.min(depth, MAX_DEPTH) + 1);
  if (todo.id < 0) {
    return `${level} ${cleanName(todo.name)}`;
  }
  const rev = todo.rev == null ? '' : ` rev:${todo.rev}`;
  return `${level} ${cleanName(todo.name)} <!-- id:${todo.id}${rev} h:${hashTodo(todo, timezone)} -->`;
}

/** Everything under the heading, without the trailing newline */
function todoBody(todo: Todo, timezone: string): string {
  const lines = [`- weight: ${formatNumber(todo.weight)}`, `- created: ${formatStamp(todo.created, timezone)}`];
  if (todo.updated != null) {
    lines.push(`- updated: ${formatStamp(todo.updated, timezone)}`);
  }
  if (todo.completed != null) {
    lines.push(`- completed: ${formatStamp(todo.completed, timezone)}`);
  }
  if (todo.estimate != null) {
    lines.push(`- estimate: ${formatDuration(todo.estimate)}`);
  }
  const desc = cleanDescription(todo.desc);
  if (desc !== '') {
    lines.push('', desc);
  }
  if (todo.time.length > 0) {
    lines.push('', TIME_LABEL);
    for (const entry of sortTime(todo.time, timezone)) {
      lines.push(`- ${formatTimeEntry(entry, timezone)}`);
    }
  }
  if (todo.checkins.length > 0) {
    lines.push('', CHECKIN_LABEL);
    for (const checkin of [...todo.checkins].sort((a, b) => b.at - a.at)) {
      const note = cleanNote(checkin.note) === '' ? '' : ` · ${cleanNote(checkin.note)}`;
      lines.push(`- ${formatStamp(checkin.at, timezone)} · ${formatNumber(Math.round(checkin.progress * 1000) / 10)}%${note}`);
    }
  }
  return lines.join('\n');
}

function formatTimeEntry(entry: TimeEntry, timezone: string): string {
  if (!isSession(entry)) {
    return `${entry.day}: ${formatDuration(entry.minutes)}`;
  }
  const start = formatStamp(entry.start, timezone);
  if (entry.end == null) {
    return `${start} → running`;
  }
  const sameDay = dayKeyOf(entry.start, timezone) === dayKeyOf(entry.end, timezone);
  return `${start} → ${sameDay ? formatClock(entry.end, timezone) : formatStamp(entry.end, timezone)}`;
}

/** Newest first; a day total sorts at the start of its day */
export function sortTime(time: TimeEntry[], timezone: string): TimeEntry[] {
  const key = (entry: TimeEntry) => (isSession(entry) ? entry.start : startOfDay(entry.day, timezone));
  return [...time].sort((a, b) => key(b) - key(a) || Number(isSession(a)) - Number(isSession(b)));
}

function depthMap(workspace: Workspace): Map<TodoId, number> {
  const depths = new Map<TodoId, number>();
  for (const todo of workspace.todos) {
    depths.set(todo.id, todo.parentId == null ? 1 : (depths.get(todo.parentId) ?? 0) + 1);
  }
  return depths;
}

function formatNumber(value: number): string {
  return String(Number(value.toFixed(6)));
}

/** Todo names are single-line and cannot contain HTML comments (they would hide the sync metadata) */
export function cleanName(name: string): string {
  const cleaned = name.replace(/\s+/g, ' ').replace(/<!--|-->/g, '').trim();
  return cleaned === '' ? 'Untitled' : cleaned;
}

/** Check-in notes are one line, without HTML comments */
export function cleanNote(note: string): string {
  return note.replace(/\s+/g, ' ').replace(/<!--|-->/g, '').trim();
}

/**
 * Normalizes a description the way the file stores it: no leading/trailing blank lines, and lines that
 * would read as headings or as the Time label are escaped so they stay part of the description.
 */
export function cleanDescription(desc: string): string {
  let fence: string | null = null;
  const lines = desc.replace(/\r\n?/g, '\n').split('\n').map(line => {
    const fenceMatch = /^\s*(```|~~~)/.exec(line);
    if (fenceMatch != null) {
      fence = fence == null ? fenceMatch[1] : fence === fenceMatch[1] ? null : fence;
      return line.trimEnd();
    }
    if (fence == null && (/^#+\s/.test(line) || TIME_LABEL_LINE.test(line) || CHECKIN_LABEL_LINE.test(line))) {
      return `\\${line.trimEnd()}`;
    }
    return line.trimEnd();
  });
  while (lines.length > 0 && lines[0].trim() === '') {
    lines.shift();
  }
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }
  return lines.join('\n');
}

/**
 * Short content hash of a todo, written into its heading comment. On the next push, a todo whose
 * current hash differs from the stored one was edited by hand. It covers what the file shows for the
 * todo (body + name + parent), not ids, revisions or sibling order.
 */
export function hashTodo(todo: Todo, timezone: string): string {
  return fnv(`${todo.parentId ?? ''}\n${cleanName(todo.name)}\n${todoBody(todo, timezone)}`);
}

/** FNV-1a, 32 bit */
function fnv(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Like hashTodo, for the project info: title, description and settings */
export function hashMeta(workspace: Workspace): string {
  return fnv(`${cleanName(workspace.name)}\n${cleanDescription(workspace.description)}\n${workspace.timezone}\n${workspace.archiveAfterDays}`);
}

export function isMetaEditedLocally(workspace: Workspace): boolean {
  return workspace.metaHash == null || workspace.metaHash !== hashMeta(workspace);
}

export function isEditedLocally(todo: Todo, timezone: string): boolean {
  return todo.hash == null || todo.hash !== hashTodo(todo, timezone);
}

// ---------------------------------------------------------------------------------------------------
// Parsing

interface RawTodo {
  line: number;
  depth: number;
  name: string;
  meta: Record<string, string>;
  body: { line: number; text: string }[];
}

export function parseWorkspace(text: string, options: ParseOptions = {}): ParseResult {
  const issues: ParseIssue[] = [];
  const now = options.now ?? Date.now();
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let index = 0;

  // Front matter
  const front: Record<string, string> = {};
  if (lines[0]?.trim() === '---') {
    index = 1;
    while (index < lines.length && lines[index].trim() !== '---') {
      const match = /^\s*([A-Za-z][\w-]*)\s*:\s*(.*?)\s*$/.exec(lines[index]);
      if (match != null) {
        front[match[1]] = match[2];
      } else if (lines[index].trim() !== '') {
        issues.push({ line: index + 1, message: `Unrecognized front matter line "${lines[index].trim()}"` });
      }
      index++;
    }
    if (index >= lines.length) {
      issues.push({ line: 1, message: 'Front matter is never closed with ---' });
    }
    index++;
  }

  let timezone = front['timezone'] ?? '';
  if (!isValidTimeZone(timezone)) {
    if (timezone !== '') {
      issues.push({ line: 1, message: `Unknown timezone "${timezone}"` });
    }
    timezone = options.timezone ?? 'UTC';
  }

  // Headings
  let name: string | null = null;
  let titleMeta: Record<string, string> = {};
  const raws: RawTodo[] = [];
  const projectLines: string[] = [];
  let fence: string | null = null;
  for (; index < lines.length; index++) {
    const line = lines[index];
    const fenceMatch = /^\s*(```|~~~)/.exec(line);
    if (fenceMatch != null) {
      fence = fence == null ? fenceMatch[1] : fence === fenceMatch[1] ? null : fence;
    }
    const heading = fence == null && fenceMatch == null ? /^(#{1,})\s+(.*?)\s*$/.exec(line) : null;
    if (heading != null && heading[1].length === 1) {
      if (name == null && raws.length === 0) {
        const { title, meta } = splitHeading(heading[2]);
        name = title;
        titleMeta = meta;
      } else {
        issues.push({ line: index + 1, message: 'Only one # title is allowed; this line was kept as description' });
        raws[raws.length - 1]?.body.push({ line: index + 1, text: `\\${line}` });
      }
      continue;
    }
    if (heading != null) {
      const { title, meta } = splitHeading(heading[2]);
      raws.push({ line: index + 1, depth: heading[1].length - 1, name: title, meta, body: [] });
      continue;
    }
    if (raws.length === 0) {
      // Between the title and the first todo: the project description
      projectLines.push(line);
      continue;
    }
    raws[raws.length - 1].body.push({ line: index + 1, text: line });
  }

  // Build the tree
  const todos: Todo[] = [];
  const stack: Todo[] = [];
  const usedIds = new Set<TodoId>();
  let temporaryId = -1;
  for (const raw of raws) {
    const depth = Math.min(raw.depth, MAX_DEPTH, stack.length + 1);
    if (raw.depth > MAX_DEPTH) {
      issues.push({ line: raw.line, message: `Todos can be nested at most ${MAX_DEPTH} levels deep (###### headings)` });
    } else if (raw.depth > depth) {
      issues.push({ line: raw.line, message: `Heading skips a level; "${raw.name}" was attached to the closest parent` });
    }
    stack.length = depth - 1;

    let id = Number(raw.meta['id']);
    if (!Number.isInteger(id) || id <= 0) {
      id = temporaryId--;
    } else if (usedIds.has(id)) {
      issues.push({ line: raw.line, message: `Duplicate id ${id}; "${raw.name}" is treated as a new todo` });
      id = temporaryId--;
    }
    usedIds.add(id);
    const rev = Number(raw.meta['rev']);

    const todo: Todo = {
      id,
      rev: Number.isInteger(rev) && id > 0 ? rev : null,
      hash: id > 0 ? (raw.meta['h'] ?? null) : null,
      name: cleanName(raw.name),
      parentId: stack.length > 0 ? stack[stack.length - 1].id : null,
      weight: 1,
      created: now,
      updated: null,
      completed: null,
      desc: '',
      time: [],
      estimate: null,
      checkins: [],
    };
    parseBody(todo, raw, timezone, issues);
    todos.push(todo);
    stack.push(todo);
  }

  const maxId = Math.max(0, ...todos.map(todo => todo.id));
  const nextId = Number(front['nextId']);
  const revision = Number(front['revision']);
  const archiveAfterDays = Number(front['archiveAfterDays']);
  return {
    workspace: {
      uid: front['uid'] ?? '',
      name: cleanName(name ?? 'Untitled'),
      description: cleanDescription(projectLines.join('\n')),
      timezone,
      revision: Number.isInteger(revision) && revision >= 0 ? revision : 0,
      nextId: Math.max(Number.isInteger(nextId) ? nextId : 1, maxId + 1),
      archiveAfterDays: Number.isFinite(archiveAfterDays) && archiveAfterDays >= 0 ? archiveAfterDays : DEFAULT_ARCHIVE_AFTER_DAYS,
      metaRev: Number.isInteger(Number(titleMeta['rev'])) && titleMeta['rev'] != null ? Number(titleMeta['rev']) : null,
      metaHash: titleMeta['h'] ?? null,
      todos,
    },
    issues,
  };
}

function splitHeading(text: string): { title: string; meta: Record<string, string> } {
  const match = /^(.*?)\s*<!--(.*?)-->\s*$/.exec(text);
  if (match == null) {
    return { title: text, meta: {} };
  }
  const meta: Record<string, string> = {};
  for (const pair of match[2].trim().split(/\s+/)) {
    const [key, value] = pair.split(':');
    if (key && value) {
      meta[key] = value;
    }
  }
  return { title: match[1], meta };
}

const META_LINE = /^\s*[-*]\s+(weight|created|updated|completed|estimate)\s*:\s*(.*?)\s*$/i;
const TIME_LABEL_LINE = /^\s*\*\*time\*\*\s*:?\s*$/i;
const CHECKIN_LABEL_LINE = /^\s*\*\*check-?ins?\*\*\s*:?\s*$/i;

function parseBody(todo: Todo, raw: RawTodo, timezone: string, issues: ParseIssue[]): void {
  const body = raw.body;
  let i = 0;
  while (i < body.length && body[i].text.trim() === '') {
    i++;
  }
  for (; i < body.length; i++) {
    const match = META_LINE.exec(body[i].text);
    if (match == null) {
      break;
    }
    const key = match[1].toLowerCase();
    const value = match[2];
    if (key === 'estimate') {
      const minutes = value === '' ? null : parseDuration(value);
      if (value !== '' && (minutes == null || minutes <= 0)) {
        issues.push({ line: body[i].line, message: `Invalid estimate "${value}" (e.g. 4h, 90m, 1h 30m)` });
      } else {
        todo.estimate = minutes;
      }
    } else if (key === 'weight') {
      const weight = Number(value);
      if (Number.isFinite(weight) && weight >= 0) {
        todo.weight = weight;
      } else {
        issues.push({ line: body[i].line, message: `Invalid weight "${value}"` });
      }
    } else if (value !== '') {
      const moment = parseStamp(value, timezone);
      if (moment == null) {
        issues.push({ line: body[i].line, message: `Invalid date "${value}" (expected YYYY-MM-DD HH:mm:ss)` });
      } else {
        todo[key as 'created' | 'updated' | 'completed'] = moment;
      }
    }
  }

  const descLines: string[] = [];
  let fence: string | null = null;
  let section: 'desc' | 'time' | 'checkins' = 'desc';
  for (; i < body.length; i++) {
    const { line, text } = body[i];
    const fenceMatch = /^\s*(```|~~~)/.exec(text);
    if (fenceMatch != null) {
      fence = fence == null ? fenceMatch[1] : fence === fenceMatch[1] ? null : fence;
    }
    if (fence == null && TIME_LABEL_LINE.test(text)) {
      section = 'time';
      continue;
    }
    if (fence == null && CHECKIN_LABEL_LINE.test(text)) {
      section = 'checkins';
      continue;
    }
    if (section !== 'desc') {
      if (text.trim() === '') {
        continue;
      }
      const entryMatch = /^\s*[-*]\s+(.*?)\s*$/.exec(text);
      if (section === 'time') {
        const entry = entryMatch == null ? null : parseTimeEntry(entryMatch[1], timezone);
        if (entry != null) {
          todo.time.push(entry);
          continue;
        }
        issues.push({ line, message: `Unrecognized time entry "${text.trim()}"; it was kept in the description` });
      } else {
        const checkin = entryMatch == null ? null : parseCheckIn(entryMatch[1], timezone);
        if (checkin != null) {
          todo.checkins.push(checkin);
          continue;
        }
        issues.push({ line, message: `Unrecognized check-in "${text.trim()}" (expected: YYYY-MM-DD HH:mm · 40%); it was kept in the description` });
      }
    }
    descLines.push(text);
  }
  todo.desc = cleanDescription(descLines.join('\n'));
}

/** "2026-10-30 10:00:00 · 40% · optional note" */
export function parseCheckIn(text: string, timezone: string): CheckIn | null {
  const match = /^(\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}(?::\d{2})?)\s*[·|-]\s*(\d+(?:\.\d+)?)\s*%\s*(?:[·|-]\s*(.*))?$/.exec(text);
  if (match == null) return null;
  const at = parseStamp(match[1], timezone);
  const percent = Number(match[2]);
  if (at == null || percent > 100) return null;
  return { at, progress: percent / 100, note: (match[3] ?? '').trim() };
}

export function parseTimeEntry(text: string, timezone: string): TimeEntry | null {
  const dayTotal = /^(\d{4}-\d{2}-\d{2})\s*:\s*(.+)$/.exec(text);
  if (dayTotal != null) {
    const minutes = parseDuration(dayTotal[2]);
    if (parseDayKey(dayTotal[1]) == null || minutes == null) {
      return null;
    }
    return { day: dayTotal[1], minutes } satisfies DayTotal;
  }
  const session = /^(.+?)\s*(?:→|->)\s*(.+)$/.exec(text);
  if (session == null) {
    return null;
  }
  const start = parseStamp(session[1], timezone);
  if (start == null) {
    return null;
  }
  const endText = session[2].trim();
  if (endText.toLowerCase() === 'running') {
    return { start, end: null };
  }
  const end = parseStamp(endText, timezone) ?? parseClock(endText, start, timezone);
  if (end == null || end < start) {
    return null;
  }
  return { start, end };
}
