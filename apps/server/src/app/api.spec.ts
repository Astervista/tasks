import { INestApplication } from '@nestjs/common';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { MutationResult, parseWorkspace, PushFilesResult, statusOf, WorkspaceDocument } from '@tasks/core';
import { createApp } from './create-app';
import { WorkspacesService } from './workspaces/workspaces.service';

/**
 * Stands in for the login service's permission check: the cookie `session=<user>` is that user's session,
 * and every user but "guest" has the "tasks" permission. Each check is recorded.
 */
function fakeLoginService(checks: Record<string, string | undefined>[]): Server {
  return createServer((req, res) => {
    checks.push({ cookie: req.headers.cookie, permission: req.headers['x-permission'] as string | undefined, domain: req.headers['x-domain'] as string | undefined });
    const user = /session=([\w-]+)/.exec(req.headers.cookie ?? '')?.[1];
    if (user == null) {
      res.writeHead(401, { 'X-Redirect-URL': '/login' }).end();
    } else if (user === 'guest' || req.headers['x-permission'] !== 'tasks') {
      res.writeHead(403, { 'X-Redirect-URL': '/user-page' }).end();
    } else {
      const renewal = user === 'renewed' ? { 'Set-Cookie': 'session=renewed; Domain=.example.com' } : {};
      res.writeHead(200, { 'X-Auth-User-Id': user, ...renewal }).end();
    }
  });
}

describe('API', () => {
  let app: INestApplication;
  let dataDir: string;
  let login: Server;
  let checks: Record<string, string | undefined>[];

  /** Requests with `user`'s session (alice by default) */
  const api = (user: string | null = 'alice') => {
    const server = request(app.getHttpServer());
    const as = (test: request.Test) => (user == null ? test : test.set('Cookie', `session=${user}`));
    return {
      get: (url: string) => as(server.get(url)),
      post: (url: string) => as(server.post(url)),
      put: (url: string) => as(server.put(url)),
      patch: (url: string) => as(server.patch(url)),
      delete: (url: string) => as(server.delete(url)),
    };
  };
  const userDir = (user = 'alice') => join(dataDir, 'users', user, 'workspaces');

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'tasks-'));
    checks = [];
    login = fakeLoginService(checks);
    await new Promise<void>(resolve => login.listen(0, '127.0.0.1', resolve));
    const authUrl = `http://127.0.0.1:${(login.address() as AddressInfo).port}/permission`;
    app = await createApp({ dataDir, webDir: null, authUrl, authPermission: 'tasks', devUser: null });
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    await new Promise(resolve => login.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function createWorkspace(name = 'tasks', user = 'alice'): Promise<string> {
    const response = await api(user).post('/api/workspaces').send({ name, description: `About ${name}`, timezone: 'Europe/Rome' }).expect(201);
    return (response.body as WorkspaceDocument).workspace.uid;
  }

  async function addTodo(uid: string, body: object, user = 'alice'): Promise<MutationResult & { id: number }> {
    return (await api(user).post(`/api/workspaces/${uid}/todos`).send(body).expect(201)).body;
  }

  it('identifies projects by uid only: names may repeat, rename and describe freely', async () => {
    const uid = await createWorkspace('tasks');
    const twin = await createWorkspace('tasks');
    expect(twin).not.toBe(uid);
    const renamed = await api().patch(`/api/workspaces/${uid}`).send({ name: 'Tasks v2', description: 'New *text*' }).expect(200);
    expect(renamed.body.workspace).toMatchObject({ name: 'Tasks v2', description: 'New *text*' });
  });

  it('creates workspaces and stores them as Markdown', async () => {
    const uid = await createWorkspace();
    const parent = await addTodo(uid, { name: 'Testing', weight: 1 });
    await addTodo(uid, { name: 'Suite', weight: 8, desc: 'With *details*', parentId: parent.id });

    const file = readFileSync(join(userDir(), uid, 'TODO.md'), 'utf8');
    expect(file).toMatch(/\n# tasks <!-- rev:1 h:[0-9a-f]{8} -->\n\nAbout tasks\n/);
    expect(file).toMatch(/\n### Suite <!-- id:2 rev:3 h:[0-9a-f]{8} -->\n- weight: 8\n/);
    expect(file).toContain('With *details*');

    const list = await api().get('/api/workspaces').expect(200);
    expect(list.body).toEqual([expect.objectContaining({ uid, name: 'tasks', description: 'About tasks', revision: 3 })]);
  });

  it('validates input and maps domain errors', async () => {
    const uid = await createWorkspace();
    await api().post(`/api/workspaces/${uid}/todos`).send({ name: '', weight: 1 }).expect(400);
    await api().post(`/api/workspaces/${uid}/todos`).send({ name: 'x', weight: 1, extra: true }).expect(400);
    await api().post('/api/workspaces').send({ name: 'x', timezone: 'Mars/Olympus' }).expect(400);
    await api().patch(`/api/workspaces/${uid}/todos/99`).send({ status: 'running' }).expect(404);
    await api().get('/api/workspaces/not-a-uid').expect(404);

    const parent = await addTodo(uid, { name: 'Macro', weight: 1 });
    await addTodo(uid, { name: 'Sub', weight: 1, parentId: parent.id });
    const refused = await api().patch(`/api/workspaces/${uid}/todos/${parent.id}`).send({ status: 'done' }).expect(409);
    expect(refused.body.code).toBe('open-descendants');
    const done = await api().patch(`/api/workspaces/${uid}/todos/${parent.id}`).send({ status: 'done', withDescendants: true }).expect(200);
    expect((done.body as MutationResult).workspace.todos.map(statusOf)).toEqual(['done', 'done']);
  });

  it('runs a single todo across all workspaces and reports the current task', async () => {
    const first = await createWorkspace('first');
    const second = await createWorkspace('second');
    const a = await addTodo(first, { name: 'A', weight: 1 });
    const b = await addTodo(second, { name: 'B', weight: 1 });

    await api().patch(`/api/workspaces/${first}/todos/${a.id}`).send({ status: 'running' }).expect(200);
    const started = await api().patch(`/api/workspaces/${second}/todos/${b.id}`).send({ status: 'running' }).expect(200);
    expect(started.body.pausedElsewhere).toEqual([{ uid: first, name: 'first', todo: 'A' }]);

    const firstDoc = (await api().get(`/api/workspaces/${first}`).expect(200)).body as WorkspaceDocument;
    expect(statusOf(firstDoc.workspace.todos[0])).not.toBe('running');

    const current = await api().get('/api/current').expect(200);
    expect(current.body).toMatchObject({ uid: second, workspace: 'second', running: true, path: [] });
    expect(current.body.todo.name).toBe('B');

    const open = await api().get('/api/todos').expect(200);
    expect(open.body.map((todo: { name: string }) => todo.name).sort()).toEqual(['A', 'B']);
  });

  it('syncs files: hand edits are merged and written back with ids', async () => {
    const uid = await createWorkspace();
    await addTodo(uid, { name: 'Existing', weight: 2 });
    const files = (await api().get(`/api/workspaces/${uid}/files`).expect(200)).body;

    const edited = files.todo.replace('- weight: 2', '- weight: 5') + '\n## Added by hand\n\n### With a child\n';
    const pushed = (await api().put(`/api/workspaces/${uid}/files`).send({ todo: edited, modified: Date.now() }).expect(200)).body as PushFilesResult;
    expect(pushed.changed).toBe(true);
    const merged = parseWorkspace(pushed.todo).workspace;
    expect(merged.todos.map(todo => [todo.id, todo.parentId, todo.name, todo.weight])).toEqual([
      [1, null, 'Existing', 5],
      [2, null, 'Added by hand', 1],
      [3, 2, 'With a child', 1],
    ]);

    // Pushing the result back is a no-op: no ping-pong
    const again = (await api().put(`/api/workspaces/${uid}/files`).send({ todo: pushed.todo, modified: Date.now() }).expect(200)).body as PushFilesResult;
    expect(again.changed).toBe(false);
    expect(again.todo).toBe(pushed.todo);

    // A file of another workspace is refused
    const foreign = pushed.todo.replace(`uid: ${uid}`, 'uid: 00000000-0000-4000-8000-000000000000');
    await api().put(`/api/workspaces/${uid}/files`).send({ todo: foreign, modified: Date.now() }).expect(400);
  });

  it('takes estimates and check-ins, pauses as of a past moment and reports the ETA', async () => {
    const uid = await createWorkspace();
    const todo = await addTodo(uid, { name: 'A', weight: 1, estimate: 120 });
    const start = Date.now() - 30 * 60_000;
    await api().patch(`/api/workspaces/${uid}/todos/${todo.id}`).send({ status: 'running' }).expect(200);
    const checked = await api().post(`/api/workspaces/${uid}/todos/${todo.id}/checkins`).send({ progress: 0.5, note: 'half' }).expect(201);
    expect(checked.body.workspace.todos[0].checkins).toEqual([expect.objectContaining({ progress: 0.5, note: 'half' })]);
    await api().post(`/api/workspaces/${uid}/todos/${todo.id}/checkins`).send({ progress: 2 }).expect(400);

    const current = await api().get('/api/current').expect(200);
    // No time logged yet at the check-in: nothing to project from, the estimate stands
    expect(current.body.eta).toMatchObject({ source: 'estimate', progress: 0.5, total: 120 });

    // A pause "as of" before the session started is clamped to the start: no negative work
    const paused = await api().patch(`/api/workspaces/${uid}/todos/${todo.id}`).send({ status: 'paused', at: start }).expect(200);
    expect(paused.body.workspace.todos[0].time).toEqual([]);

    await api().patch(`/api/workspaces/${uid}/todos/${todo.id}`).send({ estimate: null }).expect(200);
    const list = await api().get('/api/workspaces').expect(200);
    // No estimate, no history, nothing logged: this todo cannot be guessed yet
    expect(list.body[0]).toMatchObject({ running: null, eta: { unknown: 1, finish: null }, summary: { counts: { new: 1 } } });
  });

  it('serves statistics', async () => {
    const uid = await createWorkspace();
    const todo = await addTodo(uid, { name: 'A', weight: 3 });
    await api().patch(`/api/workspaces/${uid}/todos/${todo.id}`).send({ status: 'done' }).expect(200);
    const stats = await api().get(`/api/workspaces/${uid}/stats?days=7`).expect(200);
    expect(stats.body.summary.weight).toEqual({ done: 3, total: 3 });
    expect(stats.body.chart.days).toHaveLength(7);
  });

  it('archives by hand anything not running, archives done work after a week and restores', async () => {
    const uid = await createWorkspace();
    const open = await addTodo(uid, { name: 'Someday', weight: 1 });
    await addTodo(uid, { name: 'Its subtask', weight: 1, parentId: open.id });
    const running = await addTodo(uid, { name: 'Now', weight: 1 });
    const done = await addTodo(uid, { name: 'Finished', weight: 1 });
    await api().patch(`/api/workspaces/${uid}/todos/${running.id}`).send({ status: 'running' }).expect(200);
    await api().patch(`/api/workspaces/${uid}/todos/${done.id}`).send({ status: 'done' }).expect(200);

    const refused = await api().post(`/api/workspaces/${uid}/todos/${running.id}/archive`).expect(400);
    expect(refused.body.message).toContain('pause it');
    const archived = (await api().post(`/api/workspaces/${uid}/todos/${open.id}/archive`).expect(201)).body as MutationResult;
    expect(archived.workspace.todos.map(todo => todo.name)).toEqual(['Now', 'Finished']);
    expect(archived.archive.todos.map(todo => todo.name)).toEqual(['Someday', 'Its subtask']);
    expect(readFileSync(join(userDir(), uid, 'TODO.archive.md'), 'utf8')).toContain('## Someday');

    // The hourly sweep: nothing is due yet, then a week later the done todo goes
    const service = app.get(WorkspacesService);
    await service.archiveDue();
    expect((await api().get(`/api/workspaces/${uid}`).expect(200)).body.archive.todos).toHaveLength(2);
    const now = Date.now;
    Date.now = () => now() + 7 * 24 * 60 * 60 * 1000 + 1000;
    try {
      await service.archiveDue();
    } finally {
      Date.now = now;
    }
    const swept = (await api().get(`/api/workspaces/${uid}`).expect(200)).body as WorkspaceDocument;
    expect(swept.workspace.todos.map(todo => todo.name)).toEqual(['Now']);
    expect(swept.archive.todos.map(todo => todo.name)).toEqual(['Someday', 'Its subtask', 'Finished']);

    const restored = (await api().post(`/api/workspaces/${uid}/archive/${open.id}/restore`).expect(201)).body as MutationResult;
    expect(restored.workspace.todos.map(todo => todo.name)).toEqual(['Now', 'Someday', 'Its subtask']);
  });

  it('moves deleted workspaces to the trash', async () => {
    const uid = await createWorkspace();
    await api().delete(`/api/workspaces/${uid}`).expect(204);
    await api().get(`/api/workspaces/${uid}`).expect(404);
    const trash = join(dataDir, 'users', 'alice', 'trash');
    expect(readFileSync(join(trash, require('node:fs').readdirSync(trash)[0], 'TODO.md'), 'utf8')).toContain('# tasks');
  });

  it('asks the login service who the user is, with the tasks permission, and refuses anyone else', async () => {
    await api(null).get('/api/workspaces').expect(401);
    await api(null).get('/api/health').expect(200);
    const guest = await api('guest').get('/api/workspaces').expect(401);
    expect(guest.body.code).toBe('not-logged-in');
    await api().get('/api/workspaces').set('Host', 'tasks.example.com:443').expect(200);
    expect(checks.at(-1)).toEqual({ cookie: 'session=alice', permission: 'tasks', domain: 'tasks.example.com' });

    // A header can't make anyone somebody else
    await createWorkspace('mine');
    const spoofed = await api('bob').get('/api/workspaces').set('X-Auth-User-Id', 'alice').expect(200);
    expect(spoofed.body).toEqual([]);

    // A renewal the check decided on reaches the browser
    const renewed = await api('renewed').get('/api/workspaces').expect(200);
    expect(renewed.headers['set-cookie']).toEqual(['session=renewed; Domain=.example.com']);

    await new Promise(resolve => login.close(resolve));
    login.closeAllConnections();
    await api('carol').get('/api/workspaces').expect(503);
  });

  it("keeps each user's projects and running task apart", async () => {
    const alices = await createWorkspace('alice project', 'alice');
    const bobs = await createWorkspace('bob project', 'bob');
    const a = await addTodo(alices, { name: 'A', weight: 1 }, 'alice');
    const b = await addTodo(bobs, { name: 'B', weight: 1 }, 'bob');

    expect((await api('alice').get('/api/workspaces').expect(200)).body.map((item: { uid: string }) => item.uid)).toEqual([alices]);
    expect((await api('bob').get('/api/workspaces').expect(200)).body.map((item: { uid: string }) => item.uid)).toEqual([bobs]);
    // Someone else's project doesn't exist for you
    await api('bob').get(`/api/workspaces/${alices}`).expect(404);
    await api('bob').patch(`/api/workspaces/${alices}/todos/${a.id}`).send({ status: 'running' }).expect(404);
    await api('bob').put(`/api/workspaces/${alices}/files`).send({ todo: '# x\n', modified: Date.now() }).expect(404);
    await api('bob').delete(`/api/workspaces/${alices}`).expect(404);

    // Starting your task stops only yours
    await api('alice').patch(`/api/workspaces/${alices}/todos/${a.id}`).send({ status: 'running' }).expect(200);
    const started = await api('bob').patch(`/api/workspaces/${bobs}/todos/${b.id}`).send({ status: 'running' }).expect(200);
    expect(started.body.pausedElsewhere).toEqual([]);
    expect((await api('alice').get('/api/current').expect(200)).body).toMatchObject({ uid: alices, running: true });
    expect((await api('bob').get('/api/current').expect(200)).body).toMatchObject({ uid: bobs, running: true });
    expect((await api('bob').get('/api/todos').expect(200)).body.map((todo: { name: string }) => todo.name)).toEqual(['B']);
  });

  it('ignores the projects from before users', async () => {
    const legacy = join(dataDir, 'workspaces', '00000000-0000-4000-8000-000000000000');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'TODO.md'), '---\nuid: 00000000-0000-4000-8000-000000000000\n---\n\n# Old\n');
    expect((await api().get('/api/workspaces').expect(200)).body).toEqual([]);
    await api().get('/api/workspaces/00000000-0000-4000-8000-000000000000').expect(404);
  });

  it("makes a project from a folder's files, keeping ids, history and archive", async () => {
    const old = await createWorkspace('Old');
    const kept = await addTodo(old, { name: 'Kept', weight: 3 });
    const gone = await addTodo(old, { name: 'Gone', weight: 1 });
    await api().patch(`/api/workspaces/${old}/todos/${kept.id}`).send({ status: 'running' }).expect(200);
    await api().post(`/api/workspaces/${old}/todos/${gone.id}/archive`).expect(201);
    const files = (await api().get(`/api/workspaces/${old}/files`).expect(200)).body;

    const todo = `${files.todo}\n## Written by hand\n`;
    const created = (await api('bob').post('/api/workspaces').send({ name: 'Again', timezone: 'Europe/Rome', todo, archive: files.archive }).expect(201)).body as WorkspaceDocument;
    expect(created.workspace.uid).not.toBe(old);
    expect(created.workspace.todos.map(item => [item.id, item.name, item.weight, item.rev])).toEqual([
      [kept.id, 'Kept', 3, 1],
      [gone.id + 1, 'Written by hand', 1, 1],
    ]);
    expect(statusOf(created.workspace.todos[0])).toBe('running');
    expect(created.archive.todos.map(item => [item.id, item.name])).toEqual([[gone.id, 'Gone']]);
    expect(created.workspace.nextId).toBe(gone.id + 2);
    expect((await api('bob').get('/api/current').expect(200)).body).toMatchObject({ uid: created.workspace.uid, running: true });
    // And the merged files sync like any other project's
    const synced = (await api('bob').get(`/api/workspaces/${created.workspace.uid}/files`).expect(200)).body;
    const pushed = (await api('bob').put(`/api/workspaces/${created.workspace.uid}/files`).send({ todo: synced.todo, modified: Date.now() }).expect(200)).body as PushFilesResult;
    expect(pushed.changed).toBe(false);
  });
});
