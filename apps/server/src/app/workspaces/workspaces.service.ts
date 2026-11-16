import { Injectable, Logger, NotFoundException, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import {
  addTodo,
  ancestorsOf,
  archiveDone,
  archiveTodo,
  dueForArchive,
  CoreError,
  CreateTodoRequest,
  CreateWorkspaceRequest,
  CurrentTask,
  dailySeries,
  DeleteMode,
  deleteTodo,
  depthOf,
  editTodo,
  importWorkspace,
  isSession,
  isValidTimeZone,
  mergeWorkspace,
  MutationResult,
  moveTodoTo,
  OpenTodo,
  openSession,
  ownMinutes,
  parseWorkspace,
  pauseAll,
  pauseTodo,
  PushFilesRequest,
  PushFilesResult,
  resetTimer,
  pauseTodoAt,
  checkIn,
  projectEta,
  todoEta,
  minutesPerWeight,
  finishedWork,
  restoreFromArchive,
  reopenTodo,
  completeTodo,
  serializeWorkspace,
  stampRevisions,
  startTodo,
  statusOf,
  summarize,
  Todo,
  TodoId,
  UpdateTodoRequest,
  UpdateWorkspaceRequest,
  Workspace,
  WorkspaceDocument,
  WorkspaceFiles,
  WorkspaceSummary,
  cleanName,
  cleanDescription,
  getTodo,
  minutesByDay,
  dayKeyOf,
} from '@tasks/core';
import { EventsService } from '../events/events.service';
import { StoredWorkspace, WorkspaceRepository } from '../storage/workspace.repository';

/** How often done work is checked for archiving, besides on every change */
const ARCHIVE_SWEEP_MS = 60 * 60 * 1000;

@Injectable()
export class WorkspacesService implements OnApplicationBootstrap, OnApplicationShutdown {
  /** Per user: the last current task they were told about */
  private readonly lastCurrent = new Map<string, string>();
  private sweep?: ReturnType<typeof setInterval>;
  private readonly logger = new Logger(WorkspacesService.name);

  constructor(
    private readonly repository: WorkspaceRepository,
    private readonly events: EventsService,
  ) {}

  onApplicationBootstrap(): void {
    void this.repository.listUnowned().then(unowned => {
      if (unowned.length > 0) {
        this.logger.warn(`${unowned.length} project(s) in workspaces/ are from before users and belong to nobody: nobody sees them. `
          + 'Register their folders again with "tasks init" (see DEPLOY.md).');
      }
    });
    // Done work leaves on time even in a project nobody touches
    const run = () => this.archiveDue().catch(error => this.logger.error(`Archiving failed: ${error}`));
    void run();
    this.sweep = setInterval(run, ARCHIVE_SWEEP_MS);
    this.sweep.unref?.();
  }

  onApplicationShutdown(): void {
    clearInterval(this.sweep);
  }

  /** Archives the done work that is due in every project of every user */
  async archiveDue(): Promise<void> {
    const now = Date.now();
    for (const owner of await this.repository.listOwners()) {
      for (const uid of await this.repository.listUids(owner)) {
        const stored = await this.repository.find(owner, uid);
        if (stored != null && dueForArchive(stored.workspace, now).length > 0) {
          await this.mutate(owner, uid, () => undefined);
        }
      }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Workspaces

  async list(owner: string): Promise<WorkspaceSummary[]> {
    const result: WorkspaceSummary[] = [];
    for (const uid of await this.repository.listUids(owner)) {
      const stored = await this.repository.find(owner, uid);
      if (stored != null) {
        const now = Date.now();
        const running = stored.workspace.todos.find(todo => openSession(todo) != null);
        result.push({
          uid,
          name: stored.workspace.name,
          description: stored.workspace.description,
          revision: stored.workspace.revision,
          counts: summarize(stored.workspace, null, now).counts,
          modified: stored.modified,
          summary: summarize(stored.workspace, stored.archive, now),
          eta: projectEta(stored.workspace, stored.archive, now, await this.velocity(owner)),
          running: running == null ? null : { id: running.id, name: running.name, since: openSession(running)!.start },
        });
      }
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  }

  async create(owner: string, request: CreateWorkspaceRequest): Promise<WorkspaceDocument> {
    if (!isValidTimeZone(request.timezone)) {
      throw new CoreError('invalid', `Unknown timezone ${request.timezone}`);
    }
    const uid = this.repository.newUid();
    // From a project folder's files (registering it again), or empty
    const { workspace, archive } = importWorkspace(uid, cleanName(request.name), cleanDescription(request.description ?? ''), request.timezone,
      { todo: request.todo, archive: request.archive }, Date.now());
    // Only one todo runs at a time: a file with a running todo takes over from the other projects
    if (workspace.todos.some(todo => openSession(todo) != null)) {
      await this.pauseOtherWorkspaces(owner, uid);
    }
    const stored = await this.repository.save(owner, workspace, archive);
    this.events.emit(owner, { type: 'workspaces' });
    await this.publishCurrent(owner);
    return this.document(owner, stored);
  }

  async get(owner: string, uid: string): Promise<WorkspaceDocument> {
    return this.document(owner, await this.load(owner, uid));
  }

  async update(owner: string, uid: string, request: UpdateWorkspaceRequest): Promise<WorkspaceDocument> {
    if (request.timezone !== undefined && !isValidTimeZone(request.timezone)) {
      throw new CoreError('invalid', `Unknown timezone ${request.timezone}`);
    }
    const result = await this.mutate(owner, uid, workspace => {
      if (request.name !== undefined) workspace.name = cleanName(request.name);
      if (request.description !== undefined) workspace.description = cleanDescription(request.description);
      if (request.timezone !== undefined) workspace.timezone = request.timezone;
      if (request.archiveAfterDays !== undefined) workspace.archiveAfterDays = request.archiveAfterDays;
    });
    this.events.emit(owner, { type: 'workspaces' });
    return result;
  }

  async remove(owner: string, uid: string): Promise<void> {
    await this.repository.withLock(owner, uid, async () => {
      await this.load(owner, uid);
      await this.repository.remove(owner, uid);
    });
    this.events.emit(owner, { type: 'workspaces' });
    await this.publishCurrent(owner);
  }

  // ---------------------------------------------------------------------------------------------
  // Todos

  async addTodo(owner: string, uid: string, request: CreateTodoRequest): Promise<MutationResult & { id: TodoId }> {
    let id = 0;
    const result = await this.mutate(owner, uid, (workspace, now) => {
      id = addTodo(workspace, { name: request.name, weight: request.weight, desc: request.desc ?? '', estimate: request.estimate, parentId: request.parentId, index: request.index }, now).id;
    });
    return { ...result, id };
  }

  async updateTodo(owner: string, uid: string, id: TodoId, request: UpdateTodoRequest): Promise<MutationResult> {
    let pausedElsewhere: MutationResult['pausedElsewhere'] = [];
    if (request.status === 'running') {
      // Only one todo runs at a time across the user's workspaces (other users' run on their own)
      pausedElsewhere = await this.pauseOtherWorkspaces(owner, uid);
    }
    const result = await this.mutate(owner, uid, (workspace, now) => {
      getTodo(workspace, id);
      if (request.name !== undefined || request.weight !== undefined || request.desc !== undefined || request.estimate !== undefined) {
        editTodo(workspace, id, { name: request.name, weight: request.weight, desc: request.desc, estimate: request.estimate }, now);
      }
      if (request.parentId !== undefined || request.index !== undefined) {
        const parentId = request.parentId !== undefined ? request.parentId : getTodo(workspace, id).parentId;
        moveTodoTo(workspace, id, parentId, request.index, now);
      }
      switch (request.status) {
        case 'running':
          startTodo(workspace, id, now);
          break;
        case 'paused':
          if (request.at != null) pauseTodoAt(workspace, id, request.at, now);
          else pauseTodo(workspace, id, now);
          reopenTodo(workspace, id, now);
          break;
        case 'done':
          completeTodo(workspace, id, now, request.withDescendants ?? false);
          break;
      }
    });
    return { ...result, pausedElsewhere };
  }

  async checkIn(owner: string, uid: string, id: TodoId, progress: number, note: string): Promise<MutationResult> {
    return this.mutate(owner, uid, (workspace, now) => checkIn(workspace, id, progress, note, now));
  }

  async resetTimer(owner: string, uid: string, id: TodoId): Promise<MutationResult> {
    return this.mutate(owner, uid, (workspace, now) => resetTimer(workspace, id, now));
  }

  async deleteTodo(owner: string, uid: string, id: TodoId, mode: DeleteMode): Promise<MutationResult> {
    return this.mutate(owner, uid, (workspace, now) => deleteTodo(workspace, id, mode, now));
  }

  /** Archives a todo that isn't running, done or not, with its subtree */
  async archive(owner: string, uid: string, id: TodoId): Promise<MutationResult> {
    return this.mutate(owner, uid, (workspace, _now, archive) => archiveTodo(workspace, archive, id));
  }

  async restore(owner: string, uid: string, id: TodoId): Promise<MutationResult> {
    // Restored work is reopened, otherwise the next save would archive it right away
    return this.mutate(owner, uid, (workspace, now, archive) => {
      restoreFromArchive(workspace, archive, id);
      reopenTodo(workspace, id, now);
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Files (sync)

  async files(owner: string, uid: string): Promise<WorkspaceFiles> {
    const stored = await this.load(owner, uid);
    return filesOf(stored);
  }

  async pushFiles(owner: string, uid: string, request: PushFilesRequest): Promise<PushFilesResult> {
    const result = await this.repository.withLock(owner, uid, async () => {
      const stored = await this.load(owner, uid);
      const parsed = parseWorkspace(request.todo, { now: request.modified, timezone: stored.workspace.timezone });
      if (parsed.workspace.uid !== '' && parsed.workspace.uid !== uid) {
        throw new CoreError('invalid', `The file belongs to workspace ${parsed.workspace.uid}, not ${uid}`);
      }
      const merged = mergeWorkspace({
        server: stored.workspace,
        archive: stored.archive,
        local: parsed.workspace,
        localModified: request.modified,
        now: Date.now(),
      });
      const saved = merged.changed ? await this.repository.save(owner, merged.workspace, merged.archive) : stored;
      return { saved, merged, issues: parsed.issues };
    });
    if (result.merged.changed) {
      this.events.emit(owner, { type: 'revision', uid, revision: result.saved.workspace.revision });
      await this.publishCurrent(owner);
    }
    return { ...filesOf(result.saved), changed: result.merged.changed, notes: result.merged.notes, issues: result.issues };
  }

  // ---------------------------------------------------------------------------------------------
  // Across workspaces

  async current(owner: string): Promise<CurrentTask | null> {
    const now = Date.now();
    let best: { stored: StoredWorkspace; todo: Todo; running: boolean; at: number } | null = null;
    for (const uid of await this.repository.listUids(owner)) {
      const stored = await this.repository.find(owner, uid);
      if (stored == null) continue;
      for (const todo of stored.workspace.todos) {
        if (todo.completed != null) continue;
        const running = openSession(todo) != null;
        const at = Math.max(0, ...todo.time.filter(isSession).map(entry => entry.end ?? now));
        if (at === 0) continue;
        if (best == null || (running && !best.running) || (running === best.running && at > best.at)) {
          best = { stored, todo, running, at };
        }
      }
    }
    if (best == null) {
      return null;
    }
    const { workspace } = best.stored;
    const today = dayKeyOf(now, workspace.timezone);
    return {
      uid: workspace.uid,
      workspace: workspace.name,
      todo: best.todo,
      path: ancestorsOf(workspace, best.todo.id).reverse().map(todo => todo.name),
      running: best.running,
      minutes: ownMinutes(best.todo, now),
      eta: todoEta(best.todo, minutesPerWeight([...workspace.todos, ...best.stored.archive.todos], now) ?? (await this.velocity(owner)), workspace.timezone, now),
      todayMinutes: [...(minutesByDay(workspace.todos, workspace.timezone, now).get(today)?.values() ?? [])]
        .reduce((sum, value) => sum + value, 0),
    };
  }

  async openTodos(owner: string): Promise<OpenTodo[]> {
    const result: OpenTodo[] = [];
    for (const uid of await this.repository.listUids(owner)) {
      const stored = await this.repository.find(owner, uid);
      if (stored == null) continue;
      for (const todo of stored.workspace.todos) {
        if (todo.completed != null) continue;
        const starts = todo.time.filter(isSession).map(entry => entry.start);
        result.push({
          uid,
          workspace: stored.workspace.name,
          id: todo.id,
          name: todo.name,
          parentId: todo.parentId,
          depth: depthOf(stored.workspace, todo.id),
          status: statusOf(todo),
          lastWorked: starts.length > 0 ? Math.max(...starts) : null,
        });
      }
    }
    return result;
  }

  async stats(owner: string, uid: string, days: number, parentId: TodoId | null) {
    const { workspace, archive } = await this.load(owner, uid);
    const now = Date.now();
    return {
      summary: summarize(workspace, archive, now),
      chart: dailySeries(workspace, archive, parentId, days, now),
    };
  }

  // ---------------------------------------------------------------------------------------------

  private async document(owner: string, stored: StoredWorkspace): Promise<WorkspaceDocument> {
    return { workspace: stored.workspace, archive: stored.archive, velocity: await this.velocity(owner) };
  }

  /** Minutes per weight point of all finished work in all of the user's projects */
  async velocity(owner: string): Promise<number | null> {
    const now = Date.now();
    // Ids repeat across projects, so every project's finished work is taken separately
    let minutes = 0;
    let weight = 0;
    for (const uid of await this.repository.listUids(owner)) {
      const stored = await this.repository.find(owner, uid);
      if (stored == null) continue;
      for (const source of [stored.workspace, stored.archive]) {
        for (const item of finishedWork(source.todos, now)) {
          minutes += item.minutes;
          weight += item.todo.weight;
        }
      }
    }
    return weight > 0 ? minutes / weight : null;
  }

  private async load(owner: string, uid: string): Promise<StoredWorkspace> {
    const stored = await this.repository.find(owner, uid);
    if (stored == null) {
      throw new NotFoundException(`No workspace ${uid}`);
    }
    return stored;
  }

  /** Applies a change under the workspace lock, archives, stamps revisions, saves and notifies */
  private async mutate(
    owner: string,
    uid: string,
    change: (workspace: Workspace, now: number, archive: Workspace) => void,
  ): Promise<MutationResult> {
    const { stored, changed } = await this.repository.withLock(owner, uid, async () => {
      const current = await this.load(owner, uid);
      const workspace = structuredClone(current.workspace);
      const archive = structuredClone(current.archive);
      const now = Date.now();
      change(workspace, now, archive);
      archiveDone(workspace, archive, now);
      const archiveChanged = serializeWorkspace(archive) !== serializeWorkspace(current.archive);
      let changed = stampRevisions(current.workspace, workspace);
      if (archiveChanged && !changed) {
        workspace.revision++;
        changed = true;
      }
      if (!changed) {
        return { stored: current, changed };
      }
      stampRevisions(current.archive, archive, workspace.revision);
      archive.revision = workspace.revision;
      return { stored: await this.repository.save(owner, workspace, archive), changed };
    });
    if (changed) {
      this.events.emit(owner, { type: 'revision', uid, revision: stored.workspace.revision });
      await this.publishCurrent(owner);
    }
    return { ...(await this.document(owner, stored)), pausedElsewhere: [] };
  }

  private async pauseOtherWorkspaces(owner: string, exceptUid: string): Promise<MutationResult['pausedElsewhere']> {
    const paused: MutationResult['pausedElsewhere'] = [];
    for (const uid of await this.repository.listUids(owner)) {
      if (uid === exceptUid) continue;
      const stored = await this.repository.find(owner, uid);
      if (stored == null || !stored.workspace.todos.some(todo => openSession(todo) != null)) continue;
      await this.mutate(owner, uid, (workspace, now) => {
        for (const todo of pauseAll(workspace, now)) {
          paused.push({ uid, name: workspace.name, todo: todo.name });
        }
      });
    }
    return paused;
  }

  private async publishCurrent(owner: string): Promise<void> {
    const current = await this.current(owner);
    // Only "what" and "since when" matter to listeners; the minutes tick on their side
    const key = JSON.stringify(current && [current.uid, current.todo.id, current.todo.name, current.running, current.path, current.todo.time]);
    if (key !== this.lastCurrent.get(owner)) {
      this.lastCurrent.set(owner, key);
      this.events.emit(owner, { type: 'current', current });
    }
  }
}



function filesOf(stored: StoredWorkspace): WorkspaceFiles {
  return {
    todo: serializeWorkspace(stored.workspace),
    archive: serializeWorkspace(stored.archive),
    revision: stored.workspace.revision,
  };
}

