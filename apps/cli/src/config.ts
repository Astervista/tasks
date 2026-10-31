import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/**
 * ~/.config/tasks/config.json (same place on Windows, under the user profile). Shared with the tray
 * apps, which read `remote` and `token` from it.
 */
export interface CliConfig {
  remote: string | null;
  token: string | null;
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

export function readConfig(): CliConfig {
  try {
    const json = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as Partial<CliConfig>;
    return { ...json, remote: json.remote ?? null, token: json.token ?? null, projects: json.projects ?? {} };
  } catch {
    return { remote: null, token: null, projects: {} };
  }
}

export function writeConfig(config: CliConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const temp = `${CONFIG_FILE}.tmp`;
  writeFileSync(temp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  renameSync(temp, CONFIG_FILE);
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
