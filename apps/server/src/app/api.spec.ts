import { INestApplication } from '@nestjs/common';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { MutationResult, parseWorkspace, PushFilesResult, statusOf, WorkspaceDocument } from '@tasks/core';
import { createApp } from './create-app';

const TOKEN = 'test-token-0123456789abcdef';

describe('API', () => {
  let app: INestApplication;
  let dataDir: string;
  const api = () => request(app.getHttpServer());
  const auth = { Authorization: `Bearer ${TOKEN}` };

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'tasks-'));
    app = await createApp({ dataDir, token: TOKEN, auth: 'token', webDir: null });
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function createWorkspace(name = 'tasks'): Promise<string> {
    const response = await api().post('/api/workspaces').set(auth).send({ name, description: `About ${name}`, timezone: 'Europe/Rome' }).expect(201);
    return (response.body as WorkspaceDocument).workspace.uid;
  }

  async function addTodo(uid: string, body: object): Promise<MutationResult & { id: number }> {
    return (await api().post(`/api/workspaces/${uid}/todos`).set(auth).send(body).expect(201)).body;
  }

  it('rejects requests without the token', async () => {
    await api().get('/api/workspaces').expect(401);
    await api().get('/api/workspaces').set('Authorization', 'Bearer wrong').expect(401);
    await api().get(`/api/workspaces?token=${TOKEN}`).expect(200);
  });

  it('in proxy mode trusts requests without a token but still checks tokens that are sent', async () => {
    const proxied = await createApp({ dataDir, token: TOKEN, auth: 'proxy', webDir: null });
    await proxied.init();
    try {
      await request(proxied.getHttpServer()).get('/api/workspaces').expect(200);
      await request(proxied.getHttpServer()).get('/api/workspaces').set(auth).expect(200);
      await request(proxied.getHttpServer()).get('/api/workspaces').set('Authorization', 'Bearer wrong').expect(401);
    } finally {
      await proxied.close();
    }
  });

  it('identifies projects by uid only: names may repeat, rename and describe freely', async () => {
    const uid = await createWorkspace('tasks');
    const twin = await createWorkspace('tasks');
    expect(twin).not.toBe(uid);
    const renamed = await api().patch(`/api/workspaces/${uid}`).set(auth).send({ name: 'Tasks v2', description: 'New *text*' }).expect(200);
    expect(renamed.body.workspace).toMatchObject({ name: 'Tasks v2', description: 'New *text*' });
  });

  it('creates workspaces and stores them as Markdown', async () => {
    const uid = await createWorkspace();
    const parent = await addTodo(uid, { name: 'Testing', weight: 1 });
    await addTodo(uid, { name: 'Suite', weight: 8, desc: 'With *details*', parentId: parent.id });

    const file = readFileSync(join(dataDir, 'workspaces', uid, 'TODO.md'), 'utf8');
    expect(file).toMatch(/\n# tasks <!-- rev:1 h:[0-9a-f]{8} -->\n\nAbout tasks\n/);
    expect(file).toMatch(/\n### Suite <!-- id:2 rev:3 h:[0-9a-f]{8} -->\n- weight: 8\n/);
    expect(file).toContain('With *details*');

    const list = await api().get('/api/workspaces').set(auth).expect(200);
    expect(list.body).toEqual([expect.objectContaining({ uid, name: 'tasks', description: 'About tasks', revision: 3 })]);
  });

  it('validates input and maps domain errors', async () => {
    const uid = await createWorkspace();
    await api().post(`/api/workspaces/${uid}/todos`).set(auth).send({ name: '', weight: 1 }).expect(400);
    await api().post(`/api/workspaces/${uid}/todos`).set(auth).send({ name: 'x', weight: 1, extra: true }).expect(400);
    await api().post('/api/workspaces').set(auth).send({ name: 'x', timezone: 'Mars/Olympus' }).expect(400);
    await api().patch(`/api/workspaces/${uid}/todos/99`).set(auth).send({ status: 'running' }).expect(404);
    await api().get('/api/workspaces/not-a-uid').set(auth).expect(404);

    const parent = await addTodo(uid, { name: 'Macro', weight: 1 });
    await addTodo(uid, { name: 'Sub', weight: 1, parentId: parent.id });
    const refused = await api().patch(`/api/workspaces/${uid}/todos/${parent.id}`).set(auth).send({ status: 'done' }).expect(409);
    expect(refused.body.code).toBe('open-descendants');
    const done = await api().patch(`/api/workspaces/${uid}/todos/${parent.id}`).set(auth).send({ status: 'done', withDescendants: true }).expect(200);
    expect((done.body as MutationResult).workspace.todos.map(statusOf)).toEqual(['done', 'done']);
  });

  it('runs a single todo across all workspaces and reports the current task', async () => {
    const first = await createWorkspace('first');
    const second = await createWorkspace('second');
    const a = await addTodo(first, { name: 'A', weight: 1 });
    const b = await addTodo(second, { name: 'B', weight: 1 });

    await api().patch(`/api/workspaces/${first}/todos/${a.id}`).set(auth).send({ status: 'running' }).expect(200);
    const started = await api().patch(`/api/workspaces/${second}/todos/${b.id}`).set(auth).send({ status: 'running' }).expect(200);
    expect(started.body.pausedElsewhere).toEqual([{ uid: first, name: 'first', todo: 'A' }]);

    const firstDoc = (await api().get(`/api/workspaces/${first}`).set(auth).expect(200)).body as WorkspaceDocument;
    expect(statusOf(firstDoc.workspace.todos[0])).not.toBe('running');

    const current = await api().get('/api/current').set(auth).expect(200);
    expect(current.body).toMatchObject({ uid: second, workspace: 'second', running: true, path: [] });
    expect(current.body.todo.name).toBe('B');

    const open = await api().get('/api/todos').set(auth).expect(200);
    expect(open.body.map((todo: { name: string }) => todo.name).sort()).toEqual(['A', 'B']);
  });

  it('syncs files: hand edits are merged and written back with ids', async () => {
    const uid = await createWorkspace();
    await addTodo(uid, { name: 'Existing', weight: 2 });
    const files = (await api().get(`/api/workspaces/${uid}/files`).set(auth).expect(200)).body;

    const edited = files.todo.replace('- weight: 2', '- weight: 5') + '\n## Added by hand\n\n### With a child\n';
    const pushed = (await api().put(`/api/workspaces/${uid}/files`).set(auth).send({ todo: edited, modified: Date.now() }).expect(200)).body as PushFilesResult;
    expect(pushed.changed).toBe(true);
    const merged = parseWorkspace(pushed.todo).workspace;
    expect(merged.todos.map(todo => [todo.id, todo.parentId, todo.name, todo.weight])).toEqual([
      [1, null, 'Existing', 5],
      [2, null, 'Added by hand', 1],
      [3, 2, 'With a child', 1],
    ]);

    // Pushing the result back is a no-op: no ping-pong
    const again = (await api().put(`/api/workspaces/${uid}/files`).set(auth).send({ todo: pushed.todo, modified: Date.now() }).expect(200)).body as PushFilesResult;
    expect(again.changed).toBe(false);
    expect(again.todo).toBe(pushed.todo);

    // A file of another workspace is refused
    const foreign = pushed.todo.replace(`uid: ${uid}`, 'uid: 00000000-0000-4000-8000-000000000000');
    await api().put(`/api/workspaces/${uid}/files`).set(auth).send({ todo: foreign, modified: Date.now() }).expect(400);
  });

  it('takes estimates and check-ins, pauses as of a past moment and reports the ETA', async () => {
    const uid = await createWorkspace();
    const todo = await addTodo(uid, { name: 'A', weight: 1, estimate: 120 });
    const start = Date.now() - 30 * 60_000;
    await api().patch(`/api/workspaces/${uid}/todos/${todo.id}`).set(auth).send({ status: 'running' }).expect(200);
    const checked = await api().post(`/api/workspaces/${uid}/todos/${todo.id}/checkins`).set(auth).send({ progress: 0.5, note: 'half' }).expect(201);
    expect(checked.body.workspace.todos[0].checkins).toEqual([expect.objectContaining({ progress: 0.5, note: 'half' })]);
    await api().post(`/api/workspaces/${uid}/todos/${todo.id}/checkins`).set(auth).send({ progress: 2 }).expect(400);

    const current = await api().get('/api/current').set(auth).expect(200);
    // No time logged yet at the check-in: nothing to project from, the estimate stands
    expect(current.body.eta).toMatchObject({ source: 'estimate', progress: 0.5, total: 120 });

    // A pause "as of" before the session started is clamped to the start: no negative work
    const paused = await api().patch(`/api/workspaces/${uid}/todos/${todo.id}`).set(auth).send({ status: 'paused', at: start }).expect(200);
    expect(paused.body.workspace.todos[0].time).toEqual([]);

    await api().patch(`/api/workspaces/${uid}/todos/${todo.id}`).set(auth).send({ estimate: null }).expect(200);
    const list = await api().get('/api/workspaces').set(auth).expect(200);
    // No estimate, no history, nothing logged: this todo cannot be guessed yet
    expect(list.body[0]).toMatchObject({ running: null, eta: { unknown: 1, finish: null }, summary: { counts: { new: 1 } } });
  });

  it('serves statistics', async () => {
    const uid = await createWorkspace();
    const todo = await addTodo(uid, { name: 'A', weight: 3 });
    await api().patch(`/api/workspaces/${uid}/todos/${todo.id}`).set(auth).send({ status: 'done' }).expect(200);
    const stats = await api().get(`/api/workspaces/${uid}/stats?days=7`).set(auth).expect(200);
    expect(stats.body.summary.weight).toEqual({ done: 3, total: 3 });
    expect(stats.body.chart.days).toHaveLength(7);
  });

  it('moves deleted workspaces to the trash', async () => {
    const uid = await createWorkspace();
    await api().delete(`/api/workspaces/${uid}`).set(auth).expect(204);
    await api().get(`/api/workspaces/${uid}`).set(auth).expect(404);
    expect(readFileSync(join(dataDir, 'trash', require('node:fs').readdirSync(join(dataDir, 'trash'))[0], 'TODO.md'), 'utf8')).toContain('# tasks');
  });
});
