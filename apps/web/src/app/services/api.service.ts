import { HttpClient, HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject, Injectable, signal } from '@angular/core';
import {
  API_PREFIX,
  ChartData,
  CreateTodoRequest,
  CreateWorkspaceRequest,
  CurrentTask,
  DeleteMode,
  MutationResult,
  Summary,
  TodoId,
  UpdateTodoRequest,
  UpdateWorkspaceRequest,
  WorkspaceDocument,
  WorkspaceSummary,
} from '@tasks/core';
import { firstValueFrom } from 'rxjs';

const TOKEN_KEY = 'tasks-token';

/** The server token, kept in this browser */
@Injectable({ providedIn: 'root' })
export class AuthService {
  readonly token = signal<string | null>(read());
  /**
   * Set only when the server answers 401: behind a login service (AUTH_MODE=proxy) the web app
   * needs no token at all
   */
  readonly needed = signal(false);

  set(token: string): void {
    try {
      localStorage.setItem(TOKEN_KEY, token);
    } catch {
      // private mode: keep it for this session only
    }
    this.token.set(token);
    this.needed.set(false);
  }

  reject(): void {
    this.needed.set(true);
  }
}

function read(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export const authInterceptor: HttpInterceptorFn = (request, next) => {
  const auth = inject(AuthService);
  const token = auth.token();
  return next(token == null ? request : request.clone({ setHeaders: { Authorization: `Bearer ${token}` } }));
};

/** Message and domain code of a failed call */
export function describeError(error: unknown): { status: number; message: string; code?: string } {
  if (error instanceof HttpErrorResponse) {
    const body = error.error as { message?: string | string[]; code?: string } | null;
    const message = Array.isArray(body?.message) ? body.message.join(', ') : body?.message;
    return { status: error.status, message: message ?? error.message, code: body?.code };
  }
  return { status: -1, message: String(error) };
}

@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private readonly base = `/${API_PREFIX}`;

  private async call<T>(request: () => Promise<T>): Promise<T> {
    try {
      return await request();
    } catch (error) {
      if (error instanceof HttpErrorResponse && error.status === 401) {
        this.auth.reject();
      }
      throw error;
    }
  }

  workspaces(): Promise<WorkspaceSummary[]> {
    return this.call(() => firstValueFrom(this.http.get<WorkspaceSummary[]>(`${this.base}/workspaces`)));
  }

  workspace(uid: string): Promise<WorkspaceDocument> {
    return this.call(() => firstValueFrom(this.http.get<WorkspaceDocument>(`${this.base}/workspaces/${uid}`)));
  }

  createWorkspace(request: CreateWorkspaceRequest): Promise<WorkspaceDocument> {
    return this.call(() => firstValueFrom(this.http.post<WorkspaceDocument>(`${this.base}/workspaces`, request)));
  }

  updateWorkspace(uid: string, request: UpdateWorkspaceRequest): Promise<WorkspaceDocument> {
    return this.call(() => firstValueFrom(this.http.patch<WorkspaceDocument>(`${this.base}/workspaces/${uid}`, request)));
  }

  addTodo(uid: string, request: CreateTodoRequest): Promise<MutationResult & { id: TodoId }> {
    return this.call(() => firstValueFrom(this.http.post<MutationResult & { id: TodoId }>(`${this.base}/workspaces/${uid}/todos`, request)));
  }

  updateTodo(uid: string, id: TodoId, request: UpdateTodoRequest): Promise<MutationResult> {
    return this.call(() => firstValueFrom(this.http.patch<MutationResult>(`${this.base}/workspaces/${uid}/todos/${id}`, request)));
  }

  deleteTodo(uid: string, id: TodoId, mode: DeleteMode): Promise<MutationResult> {
    return this.call(() => firstValueFrom(this.http.delete<MutationResult>(`${this.base}/workspaces/${uid}/todos/${id}`, { params: { mode } })));
  }

  checkIn(uid: string, id: TodoId, progress: number, note: string): Promise<MutationResult> {
    return this.call(() => firstValueFrom(this.http.post<MutationResult>(`${this.base}/workspaces/${uid}/todos/${id}/checkins`, { progress, note })));
  }

  resetTimer(uid: string, id: TodoId): Promise<MutationResult> {
    return this.call(() => firstValueFrom(this.http.delete<MutationResult>(`${this.base}/workspaces/${uid}/todos/${id}/timer`)));
  }

  restore(uid: string, id: TodoId): Promise<MutationResult> {
    return this.call(() => firstValueFrom(this.http.post<MutationResult>(`${this.base}/workspaces/${uid}/archive/${id}/restore`, {})));
  }

  current(): Promise<CurrentTask | null> {
    return this.call(() => firstValueFrom(this.http.get<CurrentTask | null>(`${this.base}/current`)));
  }

  stats(uid: string, days: number, parent: TodoId | null): Promise<{ summary: Summary; chart: ChartData }> {
    const params: Record<string, number> = { days };
    if (parent != null) params['parent'] = parent;
    return this.call(() => firstValueFrom(this.http.get<{ summary: Summary; chart: ChartData }>(`${this.base}/workspaces/${uid}/stats`, { params })));
  }
}
