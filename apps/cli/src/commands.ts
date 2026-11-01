import { existsSync, promises as fs } from 'node:fs';
import { basename, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseWorkspace, serializeWorkspace } from '@tasks/core';
import { Client, NOT_LOGGED_IN, RemoteError } from './client';
import { clearSession, readConfig, readSession, uidForPath, updateConfig } from './config';
import { login, loginSite } from './login';
import { localState, readUid, syncProject, SyncOutcome, todoPath, TODO_FILE, writeAtomic } from './project';

export async function remoteSet(url: string): Promise<void> {
  const remote = url.replace(/\/+$/, '');
  if (!/^https?:\/\//.test(remote)) {
    throw new Error('The remote must be an http(s) URL, e.g. https://tasks.example.com');
  }
  await loginSite(remote); // Fails when the remote can't be reached
  const changed = readConfig().remote !== remote;
  updateConfig(next => {
    next.remote = remote;
  });
  // The session is a secret of the old remote's login: the new one must not receive it
  if (changed) clearSession();
  console.log(`Remote set to ${remote}`);
  await new Client(remote).workspaces().then(
    workspaces => console.log(`${workspaces.length} workspace(s) there`),
    (error: unknown) => {
      if (!(error instanceof RemoteError && error.status === NOT_LOGGED_IN)) throw error;
      if (process.stdin.isTTY) return login();
      console.log('Run "tasks login" to log in');
    },
  );
}

export function remoteShow(): void {
  const config = readConfig();
  if (config.remote == null) {
    console.log('(no remote; run tasks remote set <url>)');
    return;
  }
  console.log(config.remote);
  console.log(readSession() == null ? 'Not logged in' : 'Logged in');
}

/** Asks on the terminal; returns the default when not interactive or left empty */
async function ask(question: string, fallback: string): Promise<string> {
  if (!process.stdin.isTTY) return fallback;
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await prompt.question(fallback === '' ? `${question}: ` : `${question} (${fallback}): `)).trim();
    return answer === '' ? fallback : answer;
  } finally {
    prompt.close();
  }
}

function localTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * Links the current folder to a workspace on the remote, like `git init` + `git remote add`:
 * - already registered here: nothing to do
 * - TODO.md of a workspace the remote knows (new machine, moved folder): just register it
 * - TODO.md of a workspace the remote does not know: refuse, unless --new (re-creates it from the file)
 * - no TODO.md: create a workspace and write the file
 */
export async function init(
  dirArg: string | undefined,
  options: { name?: string; description?: string; createNew: boolean },
): Promise<void> {
  const { createNew } = options;
  const dir = resolve(dirArg ?? '.');
  const config = readConfig();
  const client = Client.fromConfig(config);
  const fileUid = await readUid(dir);

  if (fileUid != null) {
    if (config.projects[fileUid] != null && resolve(config.projects[fileUid]) === dir) {
      console.log(`Already registered: ${dir} -> workspace ${fileUid}`);
      return;
    }
    if ((await client.findWorkspace(fileUid)) != null) {
      const previous = config.projects[fileUid];
      register(fileUid, dir);
      if (previous != null) {
        console.log(`Workspace ${fileUid} moved from ${previous}`);
      }
      report(dir, await syncProject(client, fileUid, dir));
      console.log(`Registered ${dir} -> existing workspace ${fileUid}`);
      return;
    }
    if (!createNew) {
      throw new Error(`${TODO_FILE} belongs to workspace ${fileUid}, which ${config.remote} does not know.\n`
        + 'Run "tasks init --new" to create a new workspace from this file.');
    }
  } else {
    const otherUid = uidForPath(config, dir);
    if (otherUid != null) {
      throw new Error(`${dir} is registered to workspace ${otherUid} but has no ${TODO_FILE}; run "tasks sync" to download it`);
    }
  }

  // A hand-written file without a timezone gets this machine's
  const existing = existsSync(todoPath(dir))
    ? parseWorkspace(await fs.readFile(todoPath(dir), 'utf8'), { timezone: localTimezone() }).workspace
    : null;
  // A new workspace needs a name (only the uid identifies it) and a description
  const name = options.name ?? (await ask('Project name', existing?.name ?? basename(dir)));
  const description = options.description ?? (await ask('Description', existing?.description ?? ''));
  const created = await client.createWorkspace({
    name,
    description,
    timezone: existing?.timezone ?? localTimezone(),
  });
  const uid = created.workspace.uid;
  if (existing != null && existing.todos.length > 0) {
    // Re-create from the file: every todo is new to this workspace, so ids are dropped (kept as structure)
    const ids = new Map(existing.todos.map((todo, index) => [todo.id, -(index + 1)]));
    const fresh = {
      ...existing,
      uid,
      revision: 0,
      todos: existing.todos.map(todo => ({
        ...todo,
        id: ids.get(todo.id) as number,
        parentId: todo.parentId == null ? null : (ids.get(todo.parentId) ?? null),
        rev: null,
        hash: null,
      })),
    };
    await writeAtomic(todoPath(dir), serializeWorkspace(fresh));
  } else {
    await fs.rm(todoPath(dir), { force: true });
  }
  register(uid, dir);
  report(dir, await syncProject(client, uid, dir));
  console.log(`Created workspace "${created.workspace.name}" (${uid}) for ${dir}`);
}

/** Links a folder to an existing project (e.g. one created in the web app) by its uid, like `git clone` */
export async function clone(uid: string, dirArg: string | undefined): Promise<void> {
  const dir = resolve(dirArg ?? '.');
  const config = readConfig();
  const client = Client.fromConfig(config);
  const found = await client.findWorkspace(uid);
  if (found == null) {
    throw new Error(`No project ${uid} on ${config.remote}. Run "tasks list --remote" to see the uids.`);
  }
  const fileUid = await readUid(dir);
  if (fileUid != null && fileUid !== uid) {
    throw new Error(`${dir} already has a ${TODO_FILE} for workspace ${fileUid}`);
  }
  await fs.mkdir(dir, { recursive: true });
  register(uid, dir);
  report(dir, await syncProject(client, uid, dir));
  console.log(`Cloned "${found.workspace.name}" (${uid}) into ${dir}`);
}

export async function sync(dirArg: string | undefined): Promise<void> {
  const config = readConfig();
  const client = Client.fromConfig(config);
  const targets = dirArg == null
    ? Object.entries(config.projects)
    : [[uidForPath(config, dirArg) ?? fail(`${resolve(dirArg)} is not registered; run "tasks init" there`), resolve(dirArg)]];
  let failed = 0;
  for (const [uid, dir] of targets) {
    try {
      report(dir, await syncProject(client, uid, dir));
    } catch (error) {
      failed++;
      console.error(`✗ ${dir}: ${(error as Error).message}`);
    }
  }
  if (failed > 0) {
    process.exitCode = 1;
  }
}

export async function status(): Promise<void> {
  const config = readConfig();
  console.log(`Remote: ${config.remote ?? '(none)'}`);
  const entries = Object.entries(config.projects);
  if (entries.length === 0) {
    console.log('No registered projects. Run "tasks init" in a project folder.');
    return;
  }
  const remote = config.remote == null ? null : await Client.fromConfig(config).workspaces().catch((error: Error) => {
    console.log(error.message);
    return null;
  });
  for (const [uid, dir] of entries) {
    const local = await localState(dir);
    const server = remote?.find(item => item.uid === uid);
    let state: string;
    if (!existsSync(dir)) state = 'folder missing';
    else if (!local.exists) state = `no ${TODO_FILE} (will be downloaded)`;
    else if (remote == null) state = 'remote unreachable';
    else if (server == null) state = 'workspace deleted on the remote';
    else if (local.editedTodos > 0) state = `${local.editedTodos} todo(s) edited locally`;
    else if (server.revision > local.revision) state = `behind (${local.revision} -> ${server.revision})`;
    else state = 'up to date';
    console.log(`  ${dir}\n    ${server?.name ?? uid}: ${state}`);
  }
}

export async function list(remoteToo: boolean): Promise<void> {
  const config = readConfig();
  if (!remoteToo) {
    for (const [uid, dir] of Object.entries(config.projects)) {
      console.log(`${uid}  ${dir}`);
    }
    return;
  }
  const local = new Map(Object.entries(config.projects));
  for (const item of await Client.fromConfig(config).workspaces()) {
    console.log(`${item.uid}  ${item.name.padEnd(30)}  ${local.get(item.uid) ?? '(not cloned here)'}`);
    if (item.description !== '') console.log(`${' '.repeat(38)}${item.description.split('\n')[0]}`);
  }
}

export function forget(dirArg: string | undefined): void {
  const dir = resolve(dirArg ?? '.');
  const config = readConfig();
  const uid = uidForPath(config, dir) ?? fail(`${dir} is not registered`);
  updateConfig(next => {
    delete next.projects[uid];
  });
  console.log(`Forgot ${dir}; its ${TODO_FILE} stays, and the workspace stays on the remote`);
}

function register(uid: string, dir: string): void {
  updateConfig(config => {
    config.projects[uid] = dir;
  });
}

export function report(dir: string, outcome: SyncOutcome): void {
  const what = outcome.pushed && outcome.pulled ? 'merged' : outcome.pushed ? 'pushed' : outcome.pulled ? 'pulled' : 'up to date';
  console.log(`✓ ${dir}: ${what} (revision ${outcome.revision})`);
  for (const issue of outcome.issues) {
    console.log(`  ${TODO_FILE}:${issue.line} ${issue.message}`);
  }
  for (const note of outcome.notes) {
    console.log(`  ${note}`);
  }
}

function fail(message: string): never {
  throw new Error(message);
}
