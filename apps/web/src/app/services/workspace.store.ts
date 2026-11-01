import { computed, inject, Injectable, signal } from '@angular/core';
import {
  CurrentTask,
  DeleteMode,
  MutationResult,
  TodoCommand,
  TodoFields,
  TodoId,
  WorkspaceDocument,
  WorkspaceSummary,
} from '@tasks/core';
import { ApiService, describeError } from './api.service';
import { EventsService } from './events.service';

const RECENT_KEY = 'tasks-recent';

/** State of the app: the workspace list, the open workspace and the globally running task */
@Injectable({ providedIn: 'root' })
export class WorkspaceStore {
  private readonly api = inject(ApiService);

  readonly workspaces = signal<WorkspaceSummary[] | null>(null);
  readonly document = signal<WorkspaceDocument | null>(null);
  readonly current = signal<CurrentTask | null>(null);
  /** offline = the server cannot be reached (shows the error screen) */
  readonly connection = signal<'loading' | 'ready' | 'offline'>('loading');
  /** Last failed action, shown in a dialog */
  readonly failure = signal<string | null>(null);
  readonly recent = signal<string[]>(readRecent());

  readonly workspace = computed(() => this.document()?.workspace ?? null);
  readonly uid = computed(() => this.workspace()?.uid ?? null);

  constructor() {
    inject(EventsService).events.subscribe(event => {
      switch (event.type) {
        case 'revision':
          if (event.uid === this.uid() && event.revision > (this.workspace()?.revision ?? 0)) {
            void this.refresh();
          }
          break;
        case 'workspaces':
          void this.loadWorkspaces();
          break;
        case 'current':
          this.current.set(event.current);
          break;
      }
    });
  }

  /** Loads what the app needs; true when the server answered */
  async start(): Promise<boolean> {
    this.connection.set('loading');
    try {
      const [workspaces, current] = await Promise.all([this.api.workspaces(), this.api.current()]);
      this.workspaces.set(workspaces);
      this.current.set(current);
      this.connection.set('ready');
      return true;
    } catch (error) {
      this.handle(error, false);
      return false;
    }
  }

  async loadWorkspaces(): Promise<void> {
    try {
      this.workspaces.set(await this.api.workspaces());
    } catch (error) {
      this.handle(error, false);
    }
  }

  async open(uid: string): Promise<boolean> {
    try {
      this.document.set(await this.api.workspace(uid));
      this.remember(uid);
      return true;
    } catch (error) {
      this.handle(error);
      return false;
    }
  }

  close(): void {
    this.document.set(null);
  }

  async refresh(): Promise<void> {
    const uid = this.uid();
    if (uid == null) return;
    try {
      this.document.set(await this.api.workspace(uid));
    } catch (error) {
      this.handle(error, false);
    }
  }

  async createWorkspace(name: string, description: string): Promise<string | null> {
    try {
      const created = await this.api.createWorkspace({
        name,
        description,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      await this.loadWorkspaces();
      return created.workspace.uid;
    } catch (error) {
      this.handle(error);
      return null;
    }
  }

  /** Renames / describes the open project */
  async updateWorkspace(name: string, description: string): Promise<boolean> {
    const uid = this.uid();
    if (uid == null) return false;
    try {
      this.document.set(await this.api.updateWorkspace(uid, { name, description }));
      await this.loadWorkspaces();
      return true;
    } catch (error) {
      this.handle(error);
      return false;
    }
  }

  // Todo actions: each answers with the whole updated document ---------------------------------

  add(fields: TodoFields, parentId: TodoId | null): Promise<boolean> {
    return this.mutate(uid => this.api.addTodo(uid, { ...fields, parentId }));
  }

  edit(id: TodoId, fields: Partial<TodoFields> & { parentId?: TodoId | null }): Promise<boolean> {
    return this.mutate(uid => this.api.updateTodo(uid, id, fields));
  }

  move(id: TodoId, parentId: TodoId | null, index: number): Promise<boolean> {
    return this.mutate(uid => this.api.updateTodo(uid, id, { parentId, index }));
  }

  /**
   * Changes the status. Returns 'open-descendants' when a macrotask with open subtasks needs
   * `withDescendants` (the caller asks the user first).
   */
  async setStatus(id: TodoId, status: TodoCommand, withDescendants = false): Promise<'ok' | 'open-descendants' | 'failed'> {
    const uid = this.uid();
    if (uid == null) return 'failed';
    try {
      this.apply(await this.api.updateTodo(uid, id, { status, withDescendants }));
      return 'ok';
    } catch (error) {
      if (describeError(error).code === 'open-descendants') {
        return 'open-descendants';
      }
      this.handle(error);
      return 'failed';
    }
  }

  checkIn(id: TodoId, progress: number, note: string): Promise<boolean> {
    return this.mutate(uid => this.api.checkIn(uid, id, progress, note));
  }

  resetTimer(id: TodoId): Promise<boolean> {
    return this.mutate(uid => this.api.resetTimer(uid, id));
  }

  delete(id: TodoId, mode: DeleteMode): Promise<boolean> {
    return this.mutate(uid => this.api.deleteTodo(uid, id, mode));
  }

  restore(id: TodoId): Promise<boolean> {
    return this.mutate(uid => this.api.restore(uid, id));
  }

  private async mutate(action: (uid: string) => Promise<MutationResult>): Promise<boolean> {
    const uid = this.uid();
    if (uid == null) return false;
    try {
      this.apply(await action(uid));
      return true;
    } catch (error) {
      this.handle(error);
      return false;
    }
  }

  private apply(result: MutationResult): void {
    // Ignore answers that arrive after a newer state (e.g. an event-triggered refresh)
    const current = this.workspace();
    if (current == null || result.workspace.uid !== current.uid || result.workspace.revision >= current.revision) {
      this.document.set({ workspace: result.workspace, archive: result.archive, velocity: result.velocity });
    }
  }

  private handle(error: unknown, report = true): void {
    const { status, message } = describeError(error);
    if (status === 0) {
      this.connection.set('offline');
    } else if (report) {
      this.failure.set(message);
    }
  }

  private remember(uid: string): void {
    const recent = [uid, ...this.recent().filter(other => other !== uid)].slice(0, 6);
    this.recent.set(recent);
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
    } catch {
      // not persisted in private mode
    }
  }
}

function readRecent(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
  } catch {
    return [];
  }
}
