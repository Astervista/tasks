import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
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
  private readonly base = `/${API_PREFIX}`;

  workspaces(): Promise<WorkspaceSummary[]> {
    return firstValueFrom(this.http.get<WorkspaceSummary[]>(`${this.base}/workspaces`));
  }

  workspace(uid: string): Promise<WorkspaceDocument> {
    return firstValueFrom(this.http.get<WorkspaceDocument>(`${this.base}/workspaces/${uid}`));
  }

  createWorkspace(request: CreateWorkspaceRequest): Promise<WorkspaceDocument> {
    return firstValueFrom(this.http.post<WorkspaceDocument>(`${this.base}/workspaces`, request));
  }

  updateWorkspace(uid: string, request: UpdateWorkspaceRequest): Promise<WorkspaceDocument> {
    return firstValueFrom(this.http.patch<WorkspaceDocument>(`${this.base}/workspaces/${uid}`, request));
  }

  addTodo(uid: string, request: CreateTodoRequest): Promise<MutationResult & { id: TodoId }> {
    return firstValueFrom(this.http.post<MutationResult & { id: TodoId }>(`${this.base}/workspaces/${uid}/todos`, request));
  }

  updateTodo(uid: string, id: TodoId, request: UpdateTodoRequest): Promise<MutationResult> {
    return firstValueFrom(this.http.patch<MutationResult>(`${this.base}/workspaces/${uid}/todos/${id}`, request));
  }

  deleteTodo(uid: string, id: TodoId, mode: DeleteMode): Promise<MutationResult> {
    return firstValueFrom(this.http.delete<MutationResult>(`${this.base}/workspaces/${uid}/todos/${id}`, { params: { mode } }));
  }

  checkIn(uid: string, id: TodoId, progress: number, note: string): Promise<MutationResult> {
    return firstValueFrom(this.http.post<MutationResult>(`${this.base}/workspaces/${uid}/todos/${id}/checkins`, { progress, note }));
  }

  resetTimer(uid: string, id: TodoId): Promise<MutationResult> {
    return firstValueFrom(this.http.delete<MutationResult>(`${this.base}/workspaces/${uid}/todos/${id}/timer`));
  }

  restore(uid: string, id: TodoId): Promise<MutationResult> {
    return firstValueFrom(this.http.post<MutationResult>(`${this.base}/workspaces/${uid}/archive/${id}/restore`, {}));
  }

  current(): Promise<CurrentTask | null> {
    return firstValueFrom(this.http.get<CurrentTask | null>(`${this.base}/current`));
  }

  stats(uid: string, days: number, parent: TodoId | null): Promise<{ summary: Summary; chart: ChartData }> {
    const params: Record<string, number> = { days };
    if (parent != null) params['parent'] = parent;
    return firstValueFrom(this.http.get<{ summary: Summary; chart: ChartData }>(`${this.base}/workspaces/${uid}/stats`, { params }));
  }
}
