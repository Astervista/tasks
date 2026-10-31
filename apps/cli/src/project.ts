import { createHash } from 'node:crypto';
import { existsSync, promises as fs, statSync } from 'node:fs';
import { join } from 'node:path';
import { isEditedLocally, parseWorkspace } from '@tasks/core';
import { Client } from './client';

export const TODO_FILE = 'TODO.md';
export const ARCHIVE_FILE = 'TODO.archive.md';

export function todoPath(dir: string): string {
  return join(dir, TODO_FILE);
}

export function hashText(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

/** Workspace uid written in a TODO.md, if the folder has one */
export async function readUid(dir: string): Promise<string | null> {
  try {
    const uid = parseWorkspace(await fs.readFile(todoPath(dir), 'utf8')).workspace.uid;
    return uid === '' ? null : uid;
  } catch {
    return null;
  }
}

export interface SyncOutcome {
  /** The file was rewritten from the server */
  pulled: boolean;
  /** The server took changes from the file */
  pushed: boolean;
  notes: string[];
  issues: { line: number; message: string }[];
  revision: number;
  /** Hash of TODO.md as written, so watchers can ignore their own writes */
  writtenHash: string;
}

/**
 * Pushes the folder's TODO.md (the server merges it) and writes back the merged result. A missing file
 * is downloaded instead: deleting TODO.md never deletes todos on the server.
 */
export async function syncProject(client: Client, uid: string, dir: string): Promise<SyncOutcome> {
  if (!existsSync(dir)) {
    throw new Error(`Folder ${dir} does not exist (run "tasks forget" if it moved for good)`);
  }
  const file = todoPath(dir);
  let local: string | null = null;
  let modified = Date.now();
  try {
    local = await fs.readFile(file, 'utf8');
    modified = statSync(file).mtimeMs;
  } catch {
    local = null;
  }

  if (local == null || local.trim() === '') {
    const files = await client.files(uid);
    await writeFiles(dir, files.todo, files.archive);
    return { pulled: true, pushed: false, notes: [], issues: [], revision: files.revision, writtenHash: hashText(files.todo) };
  }

  const result = await client.pushFiles(uid, { todo: local, modified });
  const pulled = result.todo !== local;
  // Only rewrite the file if nobody touched it while we were talking to the server
  if (pulled) {
    const now = await fs.readFile(file, 'utf8').catch(() => null);
    if (now !== local) {
      return { pulled: false, pushed: result.changed, notes: [...result.notes, 'The file changed during the sync; it will be synced again'], issues: result.issues, revision: result.revision, writtenHash: '' };
    }
  }
  await writeFiles(dir, pulled ? result.todo : null, result.archive);
  return { pulled, pushed: result.changed, notes: result.notes, issues: result.issues, revision: result.revision, writtenHash: hashText(result.todo) };
}

async function writeFiles(dir: string, todo: string | null, archive: string): Promise<void> {
  if (todo != null) {
    await writeAtomic(todoPath(dir), todo);
  }
  const archiveFile = join(dir, ARCHIVE_FILE);
  const currentArchive = await fs.readFile(archiveFile, 'utf8').catch(() => null);
  // An empty archive is not worth a file
  const hasArchivedTodos = /\n##+ /.test(archive);
  if (currentArchive !== archive && (hasArchivedTodos || currentArchive != null)) {
    await writeAtomic(archiveFile, archive);
  }
}

export async function writeAtomic(file: string, content: string): Promise<void> {
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, content, 'utf8');
  await fs.rename(temp, file);
}

/** Local state of a TODO.md compared to what it was synced at */
export async function localState(dir: string): Promise<{ exists: boolean; revision: number; editedTodos: number }> {
  try {
    const text = await fs.readFile(todoPath(dir), 'utf8');
    const { workspace } = parseWorkspace(text);
    return {
      exists: true,
      revision: workspace.revision,
      editedTodos: workspace.todos.filter(todo => isEditedLocally(todo, workspace.timezone)).length,
    };
  } catch {
    return { exists: false, revision: 0, editedTodos: 0 };
  }
}
