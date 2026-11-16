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
/** User ids come from the login service; this keeps them safe as folder names */
const OWNER_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Workspaces on disk: <dataDir>/users/<user id>/workspaces/<uid>/TODO.md and TODO.archive.md, the very
 * same format as the copies in the projects. Each user only ever reaches their own folder. Writes are
 * atomic (temp file + rename) and serialized per workspace.
 *
 * <dataDir>/workspaces/ holds the projects from before there were users: they belong to nobody, and
 * nothing reads them.
 */
@Injectable()
export class WorkspaceRepository {
  private readonly logger = new Logger(WorkspaceRepository.name);
  private readonly cache = new Map<string, StoredWorkspace>();
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  private get users(): string {
    return join(this.config.dataDir, 'users');
  }

  private userDir(owner: string): string {
    if (!WorkspaceRepository.isOwner(owner)) {
      throw new Error(`Invalid user id ${owner}`);
    }
    return join(this.users, owner);
  }

  private root(owner: string): string {
    return join(this.userDir(owner), 'workspaces');
  }

  private dir(owner: string, uid: string): string {
    if (!UID_PATTERN.test(uid)) {
      throw new Error(`Invalid workspace uid ${uid}`);
    }
    return join(this.root(owner), uid);
  }

  private key(owner: string, uid: string): string {
    return `${owner}/${uid}`;
  }

  static isUid(uid: string): boolean {
    return UID_PATTERN.test(uid);
  }

  static isOwner(owner: string): boolean {
    return OWNER_PATTERN.test(owner);
  }

  /** Every user with a folder */
  async listOwners(): Promise<string[]> {
    return (await subfolders(this.users)).filter(name => OWNER_PATTERN.test(name));
  }

  /** Projects from before there were users, which nobody owns */
  async listUnowned(): Promise<string[]> {
    return (await subfolders(join(this.config.dataDir, 'workspaces'))).filter(name => UID_PATTERN.test(name));
  }

  newUid(): string {
    return randomUUID();
  }

  async listUids(owner: string): Promise<string[]> {
    return (await subfolders(this.root(owner))).filter(name => UID_PATTERN.test(name));
  }

  /** A copy that callers may mutate freely; null for a workspace this user doesn't have */
  async find(owner: string, uid: string): Promise<StoredWorkspace | null> {
    if (!WorkspaceRepository.isUid(uid)) {
      return null;
    }
    const key = this.key(owner, uid);
    let stored = this.cache.get(key);
    if (stored == null) {
      stored = (await this.load(owner, uid)) ?? undefined;
      if (stored == null) {
        return null;
      }
      this.cache.set(key, stored);
    }
    return { workspace: cloneWorkspace(stored.workspace), archive: cloneWorkspace(stored.archive), modified: stored.modified };
  }

  private async load(owner: string, uid: string): Promise<StoredWorkspace | null> {
    const dir = this.dir(owner, uid);
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

  async save(owner: string, workspace: Workspace, archive: Workspace): Promise<StoredWorkspace> {
    const dir = this.dir(owner, workspace.uid);
    await fs.mkdir(dir, { recursive: true });
    const archiveCopy = { ...archive, uid: workspace.uid, name: archiveName(workspace.name), description: '', timezone: workspace.timezone };
    await writeAtomic(join(dir, ARCHIVE_FILE), serializeWorkspace(archiveCopy));
    await writeAtomic(join(dir, TODO_FILE), serializeWorkspace(workspace));
    const stored = { workspace: cloneWorkspace(workspace), archive: cloneWorkspace(archiveCopy), modified: Date.now() };
    this.cache.set(this.key(owner, workspace.uid), stored);
    return { workspace: cloneWorkspace(workspace), archive: cloneWorkspace(archiveCopy), modified: stored.modified };
  }

  async files(owner: string, uid: string): Promise<{ todo: string; archive: string } | null> {
    const stored = await this.find(owner, uid);
    if (stored == null) {
      return null;
    }
    return { todo: serializeWorkspace(stored.workspace), archive: serializeWorkspace(stored.archive) };
  }

  /** Deleted workspaces are moved to the user's trash folder, never destroyed */
  async remove(owner: string, uid: string): Promise<void> {
    const trash = join(this.userDir(owner), 'trash');
    await fs.mkdir(trash, { recursive: true });
    await fs.rename(this.dir(owner, uid), join(trash, `${uid}-${Date.now()}`));
    this.cache.delete(this.key(owner, uid));
  }

  /** Runs `task` exclusively for this workspace */
  async withLock<T>(owner: string, uid: string, task: () => Promise<T>): Promise<T> {
    const key = this.key(owner, uid);
    const previous = this.locks.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(task);
    this.locks.set(key, run);
    try {
      return await run;
    } finally {
      if (this.locks.get(key) === run) {
        this.locks.delete(key);
      }
    }
  }
}

async function writeAtomic(file: string, content: string): Promise<void> {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, content, 'utf8');
  await fs.rename(temp, file);
}

async function subfolders(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter(entry => entry.isDirectory()).map(entry => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}
