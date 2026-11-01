import { parseArgs } from 'node:util';
import { clone, forget, init, list, remoteSet, remoteShow, status, sync } from './commands';
import { runDaemon } from './daemon';
import { login, logout } from './login';
import { show } from './tui';
import { completionScript, installCompletion, printUids } from './completion';
import { installService, uninstallService } from './service';

const HELP = `tasks: keeps the TODO.md of your projects in sync with the tasks server

Setup (once per machine):
  tasks remote set <url>                   connect to the server, and log in if it asks for it
  tasks remote                             show the configured server
  tasks login                              log in, approving from a browser on any device
  tasks logout                             end this machine's session (tray apps included)

Projects:
  tasks init [dir] [--name <n>] [--description <d>] [--new]
                                           link a folder: asks name and description and creates the
                                           project, or re-links a known one
  tasks clone <uid> [dir]                  link a folder to an existing project
  tasks show [dir] [--history]             browse the folder's TODO.md in the terminal
  tasks sync [dir]                         sync one project (all when omitted)
  tasks status                             state of every registered project
  tasks list [--remote]                    registered projects (or every project on the server, with uids)
  tasks forget [dir]                       stop syncing a folder (files stay)

Daemon:
  tasks daemon                             sync continuously (foreground)
  tasks daemon install | uninstall         start it automatically at login

Shell completion:
  tasks completion install                 set it up for your shell (zsh, bash or fish)
  tasks completion bash | zsh | fish       print the script
`;

async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      name: { type: 'string' },
      description: { type: 'string' },
      history: { type: 'boolean' },
      new: { type: 'boolean' },
      remote: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, ...rest] = positionals;
  if (values.help || command == null || command === 'help') {
    console.log(HELP);
    return;
  }
  switch (command) {
    case 'remote':
      if (rest[0] === 'set' && rest[1] != null) return remoteSet(rest[1]);
      if (rest.length === 0) return remoteShow();
      break;
    case 'login':
      return login();
    case 'logout':
      return logout();
    case 'init':
      return init(rest[0], { name: values.name, description: values.description, createNew: values.new ?? false });
    case 'clone':
      if (rest[0] != null) return clone(rest[0], rest[1]);
      break;
    case 'show':
      return show(rest[0], values.history ?? false);
    case 'sync':
      return sync(rest[0]);
    case 'status':
      return status();
    case 'list':
      return list(values.remote ?? false);
    case 'forget':
      return forget(rest[0]);
    case 'completion':
      if (rest[0] === 'install') return installCompletion();
      if (rest[0] != null) return void process.stdout.write(completionScript(rest[0]));
      break;
    case '__uids':
      return printUids();
    case 'daemon':
      if (rest[0] === 'install') return installService();
      if (rest[0] === 'uninstall') return uninstallService();
      if (rest.length === 0) return runDaemon();
      break;
  }
  throw new Error(`Unknown command: tasks ${positionals.join(' ')}\n\n${HELP}`);
}

main(process.argv.slice(2)).catch(error => {
  console.error((error as Error).message);
  process.exit(1);
});
