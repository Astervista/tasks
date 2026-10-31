import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import {
  archiveName,
  cloneWorkspace,
  emptyArchive,
  parseWorkspace,
  serializeWorkspace,
  Workspace,
} from '@tasks/core';
import { APP_CONFIG, AppConfig } from '../config';

export const TODO_FILE = 'TODO.md';
export const ARCHIVE_FILE = 'TODO.archive.md';

export interface StoredWorkspace {
  workspace: Workspace;
  archive: Workspace;
  modified: number;
}

const UID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Workspaces on disk: <dataDir>/workspaces/<uid>/TODO.md and TODO.archive.md, the very same format as
 * the copies in the projects. Writes are atomic (temp file + rename) and serialized per workspace.
 */
@Injectable()
export class WorkspaceRepository {
  private readonly logger = new Logger(WorkspaceRepository.name);
  private readonly cache = new Map<string, StoredWorkspace>();
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  private get root(): string {
    return join(this.config.dataDir, 'workspaces');
  }

  private dir(uid: string): string {
    if (!UID_PATTERN.test(uid)) {
      throw new Error(`Invalid workspace uid ${uid}`);
    }
    return join(this.root, uid);
  }

  static isUid(uid: string): boolean {
    return UID_PATTERN.test(uid);
  }

  newUid(): string {
    return randomUUID();
  }

  async listUids(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.root, { withFileTypes: true });
      return entries.filter(entry => entry.isDirectory() && UID_PATTERN.test(entry.name)).map(entry => entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  /** A copy that callers may mutate freely */
  async find(uid: string): Promise<StoredWorkspace | null> {
    if (!WorkspaceRepository.isUid(uid)) {
      return null;
    }
    let stored = this.cache.get(uid);
    if (stored == null) {
      stored = (await this.load(uid)) ?? undefined;
      if (stored == null) {
        return null;
      }
      this.cache.set(uid, stored);
    }
    return { workspace: cloneWorkspace(stored.workspace), archive: cloneWorkspace(stored.archive), modified: stored.modified };
  }

  private async load(uid: string): Promise<StoredWorkspace | null> {
    const dir = this.dir(uid);
    let text: string;
    let modified: number;
    try {
      text = await fs.readFile(join(dir, TODO_FILE), 'utf8');
      modified = (await fs.stat(join(dir, TODO_FILE))).mtimeMs;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
    const parsed = parseWorkspace(text, { now: modified });
    for (const issue of parsed.issues) {
      this.logger.warn(`${uid}/${TODO_FILE}:${issue.line} ${issue.message}`);
    }
    const workspace = { ...parsed.workspace, uid };
    let archive = emptyArchive(workspace);
    try {
      const archived = parseWorkspace(await fs.readFile(join(dir, ARCHIVE_FILE), 'utf8'), { now: modified, timezone: workspace.timezone });
      archive = { ...archived.workspace, uid, timezone: workspace.timezone };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    return { workspace, archive, modified };
  }

  async save(workspace: Workspace, archive: Workspace): Promise<StoredWorkspace> {
    const dir = this.dir(workspace.uid);
    await fs.mkdir(dir, { recursive: true });
    const archiveCopy = { ...archive, uid: workspace.uid, name: archiveName(workspace.name), description: '', timezone: workspace.timezone };
    await writeAtomic(join(dir, ARCHIVE_FILE), serializeWorkspace(archiveCopy));
    await writeAtomic(join(dir, TODO_FILE), serializeWorkspace(workspace));
    const stored = { workspace: cloneWorkspace(workspace), archive: cloneWorkspace(archiveCopy), modified: Date.now() };
    this.cache.set(workspace.uid, stored);
    return { workspace: cloneWorkspace(workspace), archive: cloneWorkspace(archiveCopy), modified: stored.modified };
  }

  async files(uid: string): Promise<{ todo: string; archive: string } | null> {
    const stored = await this.find(uid);
    if (stored == null) {
      return null;
    }
    return { todo: serializeWorkspace(stored.workspace), archive: serializeWorkspace(stored.archive) };
  }

  /** Deleted workspaces are moved to <dataDir>/trash, never destroyed */
  async remove(uid: string): Promise<void> {
    const trash = join(this.config.dataDir, 'trash');
    await fs.mkdir(trash, { recursive: true });
    await fs.rename(this.dir(uid), join(trash, `${uid}-${Date.now()}`));
    this.cache.delete(uid);
  }

  /** Runs `task` exclusively for this workspace */
  async withLock<T>(uid: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(uid) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(task);
    this.locks.set(uid, run);
    try {
      return await run;
    } finally {
      if (this.locks.get(uid) === run) {
        this.locks.delete(uid);
      }
    }
  }
}

async function writeAtomic(file: string, content: string): Promise<void> {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, content, 'utf8');
  await fs.rename(temp, file);
}
