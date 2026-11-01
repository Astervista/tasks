import { hostname } from 'node:os';
import { API_PREFIX } from '@tasks/core';
import { Client, NOT_LOGGED_IN, RemoteError } from './client';
import { clearSession, readConfig, readSession, Session, updateConfig, writeSession } from './config';

/** See the login service's docs/tool-login.md */
interface LoginStart {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  verificationUrlComplete: string;
  qrCodeText: string;
  expiresIn: number;
  interval: number;
}

function requireRemote(): string {
  const { remote } = readConfig();
  if (remote == null) {
    throw new Error('No remote configured. Run: tasks remote set <url>');
  }
  return remote;
}

/**
 * The login service of a remote, found where it sends a visitor without a session; null when the
 * remote lets anyone in (no login service, e.g. a local test server).
 */
export async function loginSite(remote: string): Promise<string | null> {
  let response: Response;
  try {
    response = await fetch(`${remote}/${API_PREFIX}/current`, { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    throw new RemoteError(0, `Cannot reach ${remote}: ${(error as Error).message}`);
  }
  if (response.ok) {
    return null;
  }
  const location = response.headers.get('location');
  if (location == null) {
    throw new RemoteError(response.status, `${remote} answered ${response.status}`);
  }
  return new URL(location, remote).origin;
}

async function post(url: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  return { status: response.status, body: (await response.json().catch(() => ({}))) as Record<string, unknown> };
}

function clientName(): string {
  return `Tasks CLI - ${hostname().replace(/[^\p{L}\p{N} ._-]/gu, '')}`.trim().slice(0, 64);
}

/** Waits for the approval: network trouble is retried until the login expires */
async function collect(api: string, start: LoginStart): Promise<Session> {
  const deadline = Date.now() + start.expiresIn * 1000;
  let wait = start.interval;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, wait * 1000));
    const result = await post(`${api}/token`, { deviceCode: start.deviceCode }).catch(() => null);
    if (result == null) continue;
    if (result.status === 200) return result.body as unknown as Session;
    switch (result.body['error']) {
      case 'authorization_pending':
        break;
      case 'slow_down':
        wait += start.interval;
        break;
      case 'access_denied':
        throw new Error('The login was denied.');
      case 'expired_token':
        throw new Error('The login expired. Run "tasks login" again.');
      default:
        throw new Error(`The login failed with status ${result.status}.`);
    }
  }
  throw new Error('The login expired. Run "tasks login" again.');
}

export async function login(): Promise<void> {
  const remote = requireRemote();
  const site = await loginSite(remote);
  if (site == null) {
    console.log(`${remote} doesn't ask for a login.`);
    return;
  }
  // Scrubs the old shared token from the config, if it's still there
  updateConfig(() => undefined);
  const client = new Client(remote);
  if (readSession() != null) {
    try {
      await client.workspaces();
      console.log('Already logged in.');
      return;
    } catch (error) {
      if (!(error instanceof RemoteError && error.status === NOT_LOGGED_IN)) throw error;
    }
  }

  const api = `${site}/${API_PREFIX}/auth/tool-login`;
  const started = await post(`${api}/start`, { clientName: clientName() });
  if (started.status !== 200) {
    throw new Error(`Couldn't start the login: ${String(started.body['message'] ?? started.status)}`);
  }
  const start = started.body as unknown as LoginStart;
  console.log(`To log in, scan this code or open ${start.verificationUrlComplete}\n`);
  console.log(start.qrCodeText);
  console.log(`\nOr go to ${start.verificationUrl} and enter this code: ${start.userCode}`);
  console.log('Waiting for approval... (only approve it if the page shows this same code)');

  writeSession(await collect(api, start));
  try {
    const workspaces = await client.workspaces();
    console.log(`Logged in. ${workspaces.length} workspace(s) on ${remote}.`);
  } catch (error) {
    if (!(error instanceof RemoteError && error.status === NOT_LOGGED_IN)) throw error;
    throw new Error(
      `Logged in, but ${remote} refuses this session. The path's rule on the login service must require a\n`
        + 'permission flagged for Tools, and your account must have it. It works as soon as that is fixed, with no new login.',
    );
  }
}

export async function logout(): Promise<void> {
  const session = readSession();
  if (session == null) {
    console.log('Not logged in.');
    return;
  }
  const site = await loginSite(requireRemote()).catch(() => null);
  const ended = site != null && await fetch(`${site}/${API_PREFIX}/auth/login`, {
    method: 'DELETE',
    headers: { Cookie: `${session.cookieName}=${session.token}` },
    signal: AbortSignal.timeout(30_000),
  }).then(response => response.ok, () => false);
  clearSession();
  console.log(ended ? 'Logged out.' : 'Logged out on this machine, but the login service could not be told: the session stays valid there until it expires.');
}
