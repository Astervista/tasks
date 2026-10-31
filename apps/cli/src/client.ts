import {
  API_PREFIX,
  ApiError,
  CreateWorkspaceRequest,
  CurrentTask,
  TodoCommand,
  PushFilesRequest,
  PushFilesResult,
  ServerEvent,
  WorkspaceDocument,
  WorkspaceFiles,
  WorkspaceSummary,
} from '@tasks/core';
import { CliConfig } from './config';

export class RemoteError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** REST client for the tasks server */
export class Client {
  private readonly base: string;

  constructor(
    remote: string,
    private readonly token: string,
  ) {
    this.base = `${remote.replace(/\/+$/, '')}/${API_PREFIX}`;
  }

  static fromConfig(config: CliConfig): Client {
    if (config.remote == null || config.token == null) {
      throw new Error('No remote configured. Run: tasks remote set <url> --token <token>');
    }
    return new Client(config.remote, config.token);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new RemoteError(0, `Cannot reach ${this.base}: ${(error as Error).message}`);
    }
    if (!response.ok) {
      const error = (await response.json().catch(() => null)) as ApiError | null;
      throw new RemoteError(response.status, error?.message ?? `${method} ${path} failed with ${response.status}`);
    }
    return (response.status === 204 ? undefined : await response.json()) as T;
  }

  workspaces(): Promise<WorkspaceSummary[]> {
    return this.request('GET', '/workspaces');
  }

  workspace(uid: string): Promise<WorkspaceDocument> {
    return this.request('GET', `/workspaces/${uid}`);
  }

  /** null when the server has no such workspace */
  async findWorkspace(uid: string): Promise<WorkspaceDocument | null> {
    try {
      return await this.workspace(uid);
    } catch (error) {
      if (error instanceof RemoteError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  createWorkspace(request: CreateWorkspaceRequest): Promise<WorkspaceDocument> {
    return this.request('POST', '/workspaces', request);
  }

  current(): Promise<CurrentTask | null> {
    return this.request('GET', '/current');
  }

  /** `at`: with "paused", when the work actually stopped */
  setStatus(uid: string, id: number, status: TodoCommand, at?: number): Promise<unknown> {
    return this.request('PATCH', `/workspaces/${uid}/todos/${id}`, { status, ...(at == null ? {} : { at }) });
  }

  files(uid: string): Promise<WorkspaceFiles> {
    return this.request('GET', `/workspaces/${uid}/files`);
  }

  pushFiles(uid: string, request: PushFilesRequest): Promise<PushFilesResult> {
    return this.request('PUT', `/workspaces/${uid}/files`, request);
  }

  /**
   * Streams server events until `signal` aborts; reconnects with backoff. `onState` reports
   * connection changes.
   */
  async listen(onEvent: (event: ServerEvent) => void, onState: (connected: boolean, error?: string) => void, signal: AbortSignal): Promise<void> {
    let delay = 1000;
    while (!signal.aborted) {
      try {
        const response = await fetch(`${this.base}/events`, {
          headers: { Authorization: `Bearer ${this.token}`, Accept: 'text/event-stream' },
          signal,
        });
        if (!response.ok || response.body == null) {
          throw new RemoteError(response.status, `Event stream refused with ${response.status}`);
        }
        onState(true);
        delay = 1000;
        await readEvents(response.body, onEvent);
        onState(false, 'stream closed');
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        onState(false, (error as Error).message);
      }
      await new Promise(resolve => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 60_000);
    }
  }
}

/** Minimal text/event-stream reader: only `data:` lines of default events matter here */
async function readEvents(body: ReadableStream<Uint8Array>, onEvent: (event: ServerEvent) => void): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = '';
  let type = 'message';
  let data: string[] = [];
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      if (line === '') {
        if (type === 'message' && data.length > 0) {
          try {
            onEvent(JSON.parse(data.join('\n')) as ServerEvent);
          } catch {
            // ignore malformed events
          }
        }
        type = 'message';
        data = [];
      } else if (line.startsWith('data:')) {
        data.push(line.slice(5).trimStart());
      } else if (line.startsWith('event:')) {
        type = line.slice(6).trim();
      }
    }
  }
}
