import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';

const LABEL = 'com.tasks.daemon';
const WINDOWS_TASK = 'TasksDaemon';

/** node + this script: the daemon runs the very CLI that installed it */
function command(): [string, string] {
  return [process.execPath, process.argv[1]];
}

/** Starts the daemon at login and keeps it running */
export function installService(): void {
  const [node, script] = command();
  switch (process.platform) {
    case 'darwin': {
      const plist = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
      const logs = join(homedir(), 'Library', 'Logs', 'tasks-daemon.log');
      mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
      writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(node)}</string><string>${xml(script)}</string><string>daemon</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${xml(logs)}</string>
  <key>StandardErrorPath</key><string>${xml(logs)}</string>
</dict>
</plist>
`);
      const domain = `gui/${userInfo().uid}`;
      try {
        execFileSync('launchctl', ['bootout', domain, plist], { stdio: 'ignore' });
      } catch {
        // not loaded yet
      }
      execFileSync('launchctl', ['bootstrap', domain, plist]);
      console.log(`Installed launchd agent ${plist}\nLogs: ${logs}`);
      return;
    }
    case 'win32': {
      execFileSync('schtasks', ['/Create', '/F', '/SC', 'ONLOGON', '/RL', 'LIMITED', '/TN', WINDOWS_TASK, '/TR', `"${node}" "${script}" daemon`]);
      execFileSync('schtasks', ['/Run', '/TN', WINDOWS_TASK]);
      console.log(`Installed scheduled task ${WINDOWS_TASK} (runs at logon)`);
      return;
    }
    case 'linux': {
      const unitDir = join(homedir(), '.config', 'systemd', 'user');
      mkdirSync(unitDir, { recursive: true });
      writeFileSync(join(unitDir, 'tasks-daemon.service'), `[Unit]
Description=tasks sync daemon

[Service]
ExecStart="${node}" "${script}" daemon
Restart=on-failure
RestartSec=30

[Install]
WantedBy=default.target
`);
      execFileSync('systemctl', ['--user', 'daemon-reload']);
      execFileSync('systemctl', ['--user', 'enable', '--now', 'tasks-daemon.service']);
      console.log('Installed systemd user service tasks-daemon');
      return;
    }
    default:
      throw new Error(`Autostart is not supported on ${process.platform}; run "tasks daemon" yourself`);
  }
}

export function uninstallService(): void {
  switch (process.platform) {
    case 'darwin': {
      const plist = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
      try {
        execFileSync('launchctl', ['bootout', `gui/${userInfo().uid}`, plist], { stdio: 'ignore' });
      } catch {
        // not loaded
      }
      rmSync(plist, { force: true });
      break;
    }
    case 'win32':
      execFileSync('schtasks', ['/End', '/TN', WINDOWS_TASK], { stdio: 'ignore' });
      execFileSync('schtasks', ['/Delete', '/F', '/TN', WINDOWS_TASK]);
      break;
    case 'linux':
      execFileSync('systemctl', ['--user', 'disable', '--now', 'tasks-daemon.service']);
      rmSync(join(homedir(), '.config', 'systemd', 'user', 'tasks-daemon.service'), { force: true });
      break;
    default:
      throw new Error(`Autostart is not supported on ${process.platform}`);
  }
  console.log('Daemon autostart removed');
}

function xml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
