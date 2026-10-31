import { parseArgs } from 'node:util';
import { clone, forget, init, list, remoteSet, remoteShow, status, sync } from './commands';
import { runDaemon } from './daemon';
import { show } from './tui';
import { installService, uninstallService } from './service';

const HELP = `tasks: keeps the TODO.md of your projects in sync with the tasks server

Setup (once per machine):
  tasks remote set <url> --token <token>   connect to the server
  tasks remote                             show the configured server

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
`;

async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      token: { type: 'string' },
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
      if (rest[0] === 'set' && rest[1] != null) return remoteSet(rest[1], values.token);
      if (rest.length === 0) return remoteShow();
      break;
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
