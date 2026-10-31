import { existsSync, FSWatcher, readFileSync, unlinkSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from './client';
import { CONFIG_DIR, CONFIG_FILE, ensureDir, readConfig } from './config';
import { hashText, localState, syncProject, TODO_FILE } from './project';
import { report } from './commands';

const DEBOUNCE = 500;
/** Safety net in case a file event or a server event got lost */
const FULL_SYNC_INTERVAL = 5 * 60_000;
const LOCK_FILE = join(CONFIG_DIR, 'daemon.pid');
/** Timers stop while the computer sleeps: a tick this late means it slept */
const SLEEP_TICK = 15_000;
const SLEEP_GAP = 2 * 60_000;

interface Watched {
  uid: string;
  dir: string;
  watcher: FSWatcher | null;
  timer: NodeJS.Timeout | null;
  running: boolean;
  again: boolean;
  /** Hash of the TODO.md content we wrote last, to ignore our own writes */
  ownHash: string;
}

function log(message: string): void {
  console.log(`${new Date().toISOString()} ${message}`);
}

/** Only one daemon per user, whether started by hand, by launchd/Task Scheduler or by a tray app */
function acquireLock(): void {
  if (existsSync(LOCK_FILE)) {
    const pid = Number(readFileSync(LOCK_FILE, 'utf8'));
    try {
      process.kill(pid, 0);
      throw new Error(`The daemon is already running (pid ${pid})`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        throw error;
      }
    }
  }
  ensureDir(LOCK_FILE);
  writeFileSync(LOCK_FILE, String(process.pid));
  const release = () => {
    try {
      if (readFileSync(LOCK_FILE, 'utf8') === String(process.pid)) unlinkSync(LOCK_FILE);
    } catch {
      // already gone
    }
  };
  process.on('exit', release);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => process.exit(0));
  }
}

/** Pauses the running task as of when the computer fell asleep, if it was already running then */
async function pauseAfterSleep(client: Client, asleepSince: number): Promise<void> {
  // Give the network a moment to come back after waking up
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const current = await client.current();
      const since = current?.todo.time.find(entry => 'start' in entry && entry.end == null) as { start: number } | undefined;
      if (current?.running && since != null && since.start <= asleepSince) {
        await client.setStatus(current.uid, current.todo.id, 'paused', asleepSince);
        log(`Paused "${current.todo.name}" as of ${new Date(asleepSince).toLocaleTimeString()}: the computer was asleep`);
      }
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 6000));
    }
  }
  log('Could not reach the remote after waking up: the running task was not paused');
}

/**
 * Keeps every registered project in sync: pushes on file changes (debounced), pulls when the server
 * announces a newer revision, and resyncs everything periodically and on (re)connection.
 */
export async function runDaemon(): Promise<void> {
  acquireLock();
  const projects = new Map<string, Watched>();
  let client = Client.fromConfig(readConfig());

  const sync = async (project: Watched) => {
    if (project.running) {
      project.again = true;
      return;
    }
    project.running = true;
    try {
      const outcome = await syncProject(client, project.uid, project.dir);
      project.ownHash = outcome.writtenHash || project.ownHash;
      if (outcome.pushed || outcome.pulled || outcome.notes.length > 0 || outcome.issues.length > 0) {
        report(project.dir, outcome);
      }
    } catch (error) {
      log(`✗ ${project.dir}: ${(error as Error).message}`);
    } finally {
      project.running = false;
      if (project.again) {
        project.again = false;
        void sync(project);
      }
    }
  };

  const schedule = (project: Watched) => {
    if (project.timer != null) clearTimeout(project.timer);
    project.timer = setTimeout(() => {
      project.timer = null;
      void sync(project);
    }, DEBOUNCE);
  };

  const onFileEvent = (project: Watched, filename: string | null) => {
    if (filename != null && filename !== TODO_FILE) return;
    try {
      if (hashText(readFileSync(join(project.dir, TODO_FILE), 'utf8')) === project.ownHash) return;
    } catch {
      // deleted or being replaced: the sync downloads it again
    }
    schedule(project);
  };

  const refreshProjects = () => {
    const config = readConfig();
    client = Client.fromConfig(config);
    for (const [uid, project] of projects) {
      if (config.projects[uid] !== project.dir) {
        project.watcher?.close();
        projects.delete(uid);
        log(`Stopped watching ${project.dir}`);
      }
    }
    for (const [uid, dir] of Object.entries(config.projects)) {
      if (projects.has(uid)) continue;
      const project: Watched = { uid, dir, watcher: null, timer: null, running: false, again: false, ownHash: '' };
      try {
        // Watch the folder, not the file: atomic saves replace the file and would orphan a file watcher
        project.watcher = watch(dir, (_event, filename) => onFileEvent(project, filename?.toString() ?? null));
        project.watcher.on('error', error => log(`✗ ${dir}: ${error.message}`));
      } catch (error) {
        log(`✗ ${dir}: cannot watch (${(error as Error).message}); it will still be synced periodically`);
      }
      projects.set(uid, project);
      log(`Watching ${dir}`);
      void sync(project);
    }
  };

  refreshProjects();
  // `tasks init` / `forget` / `remote set` edit the config: pick that up live
  let configTimer: NodeJS.Timeout | null = null;
  ensureDir(CONFIG_FILE);
  watch(CONFIG_DIR, (_event, filename) => {
    if (filename?.toString() !== 'config.json') return;
    if (configTimer != null) clearTimeout(configTimer);
    configTimer = setTimeout(refreshProjects, DEBOUNCE);
  });
  setInterval(() => projects.forEach(project => void sync(project)), FULL_SYNC_INTERVAL);

  // A running timer must not count the hours the computer slept
  let lastTick = Date.now();
  setInterval(() => {
    const now = Date.now();
    const asleepSince = lastTick;
    lastTick = now;
    if (now - asleepSince > SLEEP_GAP && readConfig().pauseOnSleep !== false) {
      void pauseAfterSleep(client, asleepSince);
    }
  }, SLEEP_TICK);

  log(`tasks daemon started (pid ${process.pid}), remote ${readConfig().remote}`);
  const abort = new AbortController();
  let wasConnected = false;
  await client.listen(
    async event => {
      if (event.type !== 'revision') return;
      const project = projects.get(event.uid);
      if (project == null) return;
      const local = await localState(project.dir);
      if (!local.exists || event.revision > local.revision) {
        void sync(project);
      }
    },
    (connected, error) => {
      if (connected && !wasConnected) {
        log('Connected to the remote');
        // Anything may have happened while we were offline
        projects.forEach(project => void sync(project));
      } else if (!connected && wasConnected) {
        log(`Disconnected from the remote: ${error ?? ''}`);
      }
      wasConnected = connected;
    },
    abort.signal,
  );
}
