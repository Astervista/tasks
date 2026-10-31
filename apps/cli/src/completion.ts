import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Client } from './client';
import { CONFIG_DIR, readConfig } from './config';

/**
 * Shell completion: commands, their flags and folders, and for `tasks clone` the projects on the
 * server (by uid, described by name). The scripts call `tasks __uids` for that, which prints
 * "uid:name" lines and stays silent when the server is out of reach.
 */

export type Shell = 'bash' | 'zsh' | 'fish';
export const SHELLS: Shell[] = ['bash', 'zsh', 'fish'];

const COMMANDS: [string, string][] = [
  ['remote', 'show or set the server'],
  ['init', 'link a folder to a new or known project'],
  ['clone', 'link a folder to a project on the server'],
  ['show', "browse the folder's TODO.md"],
  ['sync', 'sync one project, or all'],
  ['status', 'state of every linked project'],
  ['list', 'linked projects, or all on the server'],
  ['forget', 'stop syncing a folder'],
  ['daemon', 'sync continuously, or install it at login'],
  ['completion', 'shell completion script'],
  ['help', 'show help'],
];

const BASH = `# tasks completion for bash
_tasks() {
  local cur prev cword
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  cword=$COMP_CWORD
  if [[ $cword -eq 1 ]]; then
    COMPREPLY=($(compgen -W "${COMMANDS.map(([name]) => name).join(' ')}" -- "$cur"))
    return
  fi
  case "$prev" in
    --token|--name|--description) return ;;
  esac
  local dirs=0 words=""
  case "\${COMP_WORDS[1]}" in
    remote) [[ $cword -eq 2 ]] && words="set"; [[ $cword -ge 4 ]] && words="--token" ;;
    init) words="--name --description --new"; dirs=1 ;;
    clone) if [[ $cword -eq 2 ]]; then words="$(tasks __uids 2>/dev/null | cut -d: -f1)"; else dirs=1; fi ;;
    show) words="--history"; dirs=1 ;;
    sync|forget) dirs=1 ;;
    list) words="--remote" ;;
    daemon) [[ $cword -eq 2 ]] && words="install uninstall" ;;
    completion) [[ $cword -eq 2 ]] && words="${SHELLS.join(' ')} install" ;;
  esac
  if [[ $cur == -* || $dirs -eq 0 ]]; then
    COMPREPLY=($(compgen -W "$words" -- "$cur"))
  else
    COMPREPLY=($(compgen -d -- "$cur"))
  fi
}
complete -o filenames -F _tasks tasks
`;

const ZSH = `# tasks completion for zsh
_tasks_projects() {
  local -a projects
  projects=(\${(f)"$(tasks __uids 2>/dev/null)"})
  _describe -t projects 'project' projects
}

_tasks() {
  local -a commands
  commands=(
${COMMANDS.map(([name, description]) => `    '${name}:${description.replace(/'/g, "'\\''")}'`).join('\n')}
  )
  local state
  _arguments -C '(-h --help)'{-h,--help}'[show help]' '1: :->command' '*:: :->args'
  case $state in
    command) _describe -t commands 'tasks command' commands ;;
    args)
      case $words[1] in
        remote) _arguments '1:action:(set)' '2:server URL:_urls' '--token[server token]:token: ' ;;
        init) _arguments '--name[project name]:name: ' '--description[project description]:description: ' '--new[new project from this TODO.md]' '1:folder:_directories' ;;
        clone) _arguments '1:project:_tasks_projects' '2:folder:_directories' ;;
        show) _arguments '--history[days, sessions and completed work]' '1:folder:_directories' ;;
        sync|forget) _arguments '1:folder:_directories' ;;
        list) _arguments '--remote[every project on the server]' ;;
        daemon) _arguments '1:action:(install uninstall)' ;;
        completion) _arguments '1:shell:(${SHELLS.join(' ')} install)' ;;
      esac
      ;;
  esac
}

if (( ! $+functions[compdef] )); then
  autoload -Uz compinit && compinit
fi
compdef _tasks tasks
`;

const FISH = `# tasks completion for fish
complete -c tasks -f
${COMMANDS.map(([name, description]) => `complete -c tasks -n __fish_use_subcommand -a ${name} -d '${description.replace(/'/g, "\\'")}'`).join('\n')}
complete -c tasks -n '__fish_seen_subcommand_from remote' -a set
complete -c tasks -n '__fish_seen_subcommand_from remote' -l token -r -d 'server token'
complete -c tasks -n '__fish_seen_subcommand_from init' -l name -r -d 'project name'
complete -c tasks -n '__fish_seen_subcommand_from init' -l description -r -d 'project description'
complete -c tasks -n '__fish_seen_subcommand_from init' -l new -d 'new project from this TODO.md'
complete -c tasks -n '__fish_seen_subcommand_from show' -l history -d 'days, sessions and completed work'
complete -c tasks -n '__fish_seen_subcommand_from list' -l remote -d 'every project on the server'
complete -c tasks -n '__fish_seen_subcommand_from init show sync forget' -a '(__fish_complete_directories)'
complete -c tasks -n '__fish_seen_subcommand_from clone' -a '(tasks __uids 2>/dev/null | string replace : \\t)'
complete -c tasks -n '__fish_seen_subcommand_from daemon' -a 'install uninstall'
complete -c tasks -n '__fish_seen_subcommand_from completion' -a '${SHELLS.join(' ')} install'
`;

export function completionScript(shell: string): string {
  switch (shell) {
    case 'bash':
      return BASH;
    case 'zsh':
      return ZSH;
    case 'fish':
      return FISH;
    default:
      throw new Error(`No completion for "${shell}": use one of ${SHELLS.join(', ')}`);
  }
}

/** Projects on the server as "uid:name" lines, for completion; nothing when it cannot be reached */
export async function printUids(): Promise<void> {
  try {
    const config = readConfig();
    const workspaces = await Promise.race([
      Client.fromConfig(config).workspaces(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ]);
    for (const workspace of workspaces) {
      console.log(`${workspace.uid}:${workspace.name.replace(/[\r\n]+/g, ' ')}`);
    }
  } catch {
    // completion just offers nothing
  }
}

/**
 * Installs completion for the user's shell ($SHELL): the script goes next to the CLI's config, and
 * the shell's startup file sources it (fish loads it from its completions folder by itself).
 * Running it again refreshes the script and leaves the startup file alone.
 */
export function installCompletion(): void {
  const shell = (process.env['SHELL'] ?? '').split('/').pop() as Shell;
  if (!SHELLS.includes(shell)) {
    throw new Error(`Unknown shell "${process.env['SHELL'] ?? ''}": print the script with tasks completion ${SHELLS.join('|')}`);
  }
  if (shell === 'fish') {
    const dir = join(homedir(), '.config', 'fish', 'completions');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'tasks.fish'), FISH);
    console.log(`Installed ${join(dir, 'tasks.fish')}: new fish sessions complete tasks`);
    return;
  }
  mkdirSync(CONFIG_DIR, { recursive: true });
  const script = join(CONFIG_DIR, `completion.${shell}`);
  writeFileSync(script, completionScript(shell));
  const rc = join(homedir(), shell === 'zsh' ? '.zshrc' : '.bashrc');
  const line = `[ -f "${script}" ] && source "${script}"  # tasks completion`;
  if (existsSync(rc) && readFileSync(rc, 'utf8').includes(script)) {
    console.log(`Updated ${script}`);
  } else {
    appendFileSync(rc, `\n${line}\n`);
    console.log(`Installed ${script} and added it to ${rc}; open a new terminal (or: source ${rc})`);
  }
}
