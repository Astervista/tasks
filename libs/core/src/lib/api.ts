/**
 * REST contract shared by server, web app and CLI. Resources are the core model as JSON, so clients run
 * the same core functions (status, rollups, stats, move checks) on what they receive.
 */
import { ProjectEta, TodoEta } from './eta';
import { Status, Todo, TodoId, Workspace } from './model';
import { Summary } from './stats';
import { DeleteMode } from './transitions';
import { Millis } from './time';

export const API_PREFIX = 'api';

export interface WorkspaceSummary {
  uid: string;
  name: string;
  description: string;
  revision: number;
  counts: Record<Status, number>;
  /** Last time anything changed */
  modified: Millis;
  /** Time and weight statistics, archive included */
  summary: Summary;
  eta: ProjectEta;
  /** The todo running in this project, if any */
  running: { id: TodoId; name: string; since: Millis } | null;
}

/** GET /workspaces/:uid */
export interface WorkspaceDocument {
  workspace: Workspace;
  archive: Workspace;
  /**
   * Minutes per weight point across all projects: turns weight into time while a project has no
   * finished work of its own
   */
  velocity: number | null;
}

/** POST /workspaces */
export interface CreateWorkspaceRequest {
  /** For people; projects are identified only by their uid */
  name: string;
  description?: string;
  timezone: string;
}

/** PATCH /workspaces/:uid */
export interface UpdateWorkspaceRequest {
  name?: string;
  description?: string;
  timezone?: string;
  archiveAfterDays?: number;
}

/** POST /workspaces/:uid/todos */
export interface CreateTodoRequest {
  name: string;
  weight: number;
  /** Start guess of the total work, minutes */
  estimate?: number | null;
  desc?: string;
  parentId?: TodoId | null;
  index?: number;
}

export type TodoCommand = 'running' | 'paused' | 'done';

/** PATCH /workspaces/:uid/todos/:id */
export interface UpdateTodoRequest {
  name?: string;
  weight?: number;
  desc?: string;
  status?: TodoCommand;
  /** With status "paused": when the work actually stopped (unanswered check-in, computer asleep) */
  at?: Millis;
  /** Start guess of the total work, minutes; null removes it */
  estimate?: number | null;
  /** With status "done": also complete open subtasks */
  withDescendants?: boolean;
  /** Move: present (null = top level) to reparent */
  parentId?: TodoId | null;
  index?: number;
}

/** POST /workspaces/:uid/todos/:id/checkins */
export interface CheckInRequest {
  /** 0 … 1 */
  progress: number;
  note?: string;
}

export interface DeleteTodoQuery {
  mode?: DeleteMode;
}

/** Every todo mutation answers with the whole updated document plus what else changed */
export interface MutationResult extends WorkspaceDocument {
  /** Todos paused in other workspaces because this one started */
  pausedElsewhere: { uid: string; name: string; todo: string }[];
}

/** GET/PUT /workspaces/:uid/files */
export interface WorkspaceFiles {
  /** TODO.md */
  todo: string;
  /** TODO.archive.md */
  archive: string;
  revision: number;
}

export interface PushFilesRequest {
  todo: string;
  /** Modification time of the pushed TODO.md */
  modified: Millis;
}

export interface PushFilesResult extends WorkspaceFiles {
  changed: boolean;
  notes: string[];
  /** Problems found while reading the pushed file */
  issues: { line: number; message: string }[];
}

/** GET /current: the running todo, else the most recently paused one */
export interface CurrentTask {
  uid: string;
  workspace: string;
  todo: Todo;
  /** Ancestor names, top level first */
  path: string[];
  running: boolean;
  /** Logged so far, running session included */
  minutes: number;
  todayMinutes: number;
  eta: TodoEta;
}

/** GET /todos?open=true: candidates for "switch to" */
export interface OpenTodo {
  uid: string;
  workspace: string;
  id: TodoId;
  name: string;
  parentId: TodoId | null;
  depth: number;
  status: Status;
  /** Last session start, for "most recently worked" ordering */
  lastWorked: Millis | null;
}

export type ServerEvent =
  | { type: 'revision'; uid: string; revision: number }
  | { type: 'workspaces' }
  | { type: 'current'; current: CurrentTask | null };

export interface ApiError {
  statusCode: number;
  message: string;
  code?: string;
}
