import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/**
 * ~/.config/tasks/config.json (same place on Windows, under the user profile). Shared with the tray
 * apps, which read `remote` from it.
 */
export interface CliConfig {
  remote: string | null;
  /** Registered projects: workspace uid -> absolute folder */
  projects: Record<string, string>;
  /** Pause the running task when the computer sleeps (daemon and tray apps); default true */
  pauseOnSleep?: boolean;
  /** Tray apps: ask "how far along?" after this many minutes of running; default 45, 0 = never */
  checkInMinutes?: number;
  /** Tray apps: pause as of the question when nobody answers within this many minutes; default 10 */
  checkInGraceMinutes?: number;
}

export const CONFIG_DIR = process.env['TASKS_CONFIG_DIR'] ?? join(homedir(), '.config', 'tasks');
export const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
export const SESSION_FILE = join(CONFIG_DIR, 'session.json');

/**
 * The login session of this machine, in session.json next to the config: shared by the CLI, the daemon
 * and the tray apps, so logging in from one logs in them all. The token is a secret.
 */
export interface Session {
  cookieName: string;
  token: string;
  expiresAt: string;
}

export function readConfig(): CliConfig {
  try {
    // `token` was the old shared secret: dropping it here removes it from the file on the next write
    const { token: _old, ...json } = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as Partial<CliConfig> & { token?: unknown };
    return { ...json, remote: json.remote ?? null, projects: json.projects ?? {} };
  } catch {
    return { remote: null, projects: {} };
  }
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const temp = `${file}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(temp, file);
}

export function writeConfig(config: CliConfig): void {
  writeJson(CONFIG_FILE, config);
}

export function readSession(): Session | null {
  try {
    const session = JSON.parse(readFileSync(SESSION_FILE, 'utf8')) as Partial<Session>;
    return session.cookieName && session.token ? (session as Session) : null;
  } catch {
    return null;
  }
}

export function writeSession(session: Session): void {
  writeJson(SESSION_FILE, session);
}

export function clearSession(): void {
  rmSync(SESSION_FILE, { force: true });
}

export function updateConfig(change: (config: CliConfig) => void): CliConfig {
  const config = readConfig();
  change(config);
  writeConfig(config);
  return config;
}

/** The registered uid for a folder, if any */
export function uidForPath(config: CliConfig, path: string): string | undefined {
  const target = resolve(path);
  return Object.keys(config.projects).find(uid => resolve(config.projects[uid]) === target);
}

export function ensureDir(file: string): void {
  mkdirSync(dirname(file), { recursive: true });
}
