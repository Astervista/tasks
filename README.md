# Tasks

Todos with macrotasks, timers and statistics, in the good old carnival look.

- **Server** (`apps/server`, NestJS) runs in Docker on a remote host and stores every workspace as Markdown.
- **Web app** (`apps/web`, Angular) is served by the server.
- **CLI + sync daemon** (`apps/cli`) links project folders to workspaces, like git with a single remote.
- **Tray apps** (`native/`) for the macOS menu bar and the Windows taskbar.
- **`libs/core`** is the shared data layer used by server, web app and CLI: Markdown format, tree, timers, merge, statistics.

## TODO.md

Every project keeps a `TODO.md`, readable and editable by hand, and everything about the project is in it: the title (`#`), the description under it, the todos, their time. A project is identified only by its `uid`; names may repeat. Heading levels are the hierarchy (`##` top level … `######` = 5 levels deep):

```markdown
---
uid: 9b2e6c1e-4f0a-4c5e-9a57-0d3f2a1b7c44
timezone: Europe/Rome
revision: 42
nextId: 7
archiveAfterDays: 7
---
# tasks <!-- rev:3 h:be2bca5f -->

Todos with macrotasks, timers and statistics.

## Testing <!-- id:5 rev:40 h:1f2e3d4c -->
- weight: 1
- created: 2021-11-24 14:30:00

### Test the testing <!-- id:2 rev:41 h:a1b2c3d4 -->
- weight: 13
- created: 2021-11-24 17:37:44

Any Markdown description (no headings).

**Time**
- 2026-10-29 09:37:58 → running
- 2021-11-25 05:00:00 → 07:20:00
- 2021-11-24: 2h 20m
```

Hand edits are welcome:
- Add a heading and it becomes a todo.
- Change a heading level to move a todo under another parent.
- Edit the title or the description to rename or describe the project.
- Delete a block to delete that todo.
- Log time manually with a `day: 1h 30m` line.

**Macrotasks.** A todo with subtasks keeps its own fields (weight, estimate, time, check-ins) for the work on it itself. The UI shows them as an extra, unselectable "⋯" line, first among the subtasks. The macrotask's own line shows the totals of its whole subtree. Weight 0 means no work is expected on the macrotask itself.

The HTML comments hold sync metadata, are invisible when rendered, and should be left alone. Done top-level todos move to `TODO.archive.md` once they have been done for `archiveAfterDays` days (7 by default, set per project in the web app), and any todo that isn't running can be archived by hand; the web app's archive brings them back.

**How sync merges.** No copy is kept besides the server's and the project's:
- The `h:` hash tells which todos you edited by hand. The `rev:` tells which ones changed on the server since the file was synced.
- Edits on different todos simply merge.
- If the same todo changed on both sides, the newer edit wins and the time logs are combined.

## Server (Docker)

Step by step, from an empty host to your computers syncing: **[DEPLOY.md](DEPLOY.md)**. In short:

```sh
cp .env.example .env            # set TASKS_UID/GID
mkdir data
sh scripts/deploy.sh            # build, start, clean up old images and build cache
```

Data lives in `data/`, one folder per user (`data/users/<user id>/workspaces/<uid>/TODO.md`, plain Markdown). Deleted workspaces go to that user's `trash` folder. Put TLS and your login service in front with a reverse proxy (see DEPLOY.md).

Each user only sees their own projects, and starting a task only pauses that user's other tasks, so several people can work at the same time. The login service decides who gets in: nginx asks it first, and then the server itself asks it who the user is and whether they have the `tasks` permission, sending it the request's session cookie. Browsers use their normal login. The CLI, the daemon and the tray apps log in once with `tasks login` or the tray's "Log in…": you approve it in a browser on any device, and they share the session in `~/.config/tasks/session.json`.

## CLI and daemon

```sh
npm ci && npm run cli:install                                 # installs the `tasks` command
tasks remote set https://tasks.example.com                   # once per machine; logs in too
cd ~/projects/something && tasks init                        # asks name + description, links the folder (re-running is a no-op)
tasks daemon install                                         # keeps every linked project in sync, at login
tasks completion install                                     # Tab completion for zsh, bash or fish ($SHELL)
```

`tasks completion install` saves the script next to the CLI's config and adds one `source` line to `~/.zshrc` or `~/.bashrc` (fish loads it from `~/.config/fish/completions` by itself). Run it again after updating the CLI. `tasks clone <Tab>` offers the projects on the server by name.

| Command | What it does |
|---|---|
| `tasks show [--history]` | Browse the folder's TODO.md in the terminal; `--history` (or `h`) shows days, sessions and completed work |
| `tasks status` | State of every linked project |
| `tasks sync` | Syncs now |
| `tasks clone <uid>` | Links a folder to a project created in the web app |
| `tasks list --remote` | Your projects on the server, with their uids |
| `tasks forget` | Stops syncing a folder (nothing is deleted) |

`tasks init` behaves like this:
- In a folder that is already registered, it does nothing.
- In a folder whose `TODO.md` belongs to a workspace the server knows (another machine, a moved folder), it only registers the folder.
- In a folder whose `TODO.md` belongs to a workspace the server doesn't have for your account, it offers to make a new one from the folder's files, keeping their todos, ids, time and archive (`--new` doesn't ask).
- Otherwise it creates a new workspace.

## Tray apps

Both read the remote and the session from the CLI's config folder. If you're not logged in yet, or the session ended, their menu has a "Log in…" entry that shows a QR code and a code to approve from a browser. Logging in there also logs in the CLI and the daemon, and the other way around.

Download them from [Releases](https://github.com/Astervista/tasks/releases/latest), or build them yourself:

- **macOS**: take `TasksBar.zip` (Apple Silicon and Intel), or run `native/macos/bundle.sh`. Copy `TasksBar.app` to /Applications. It isn't notarized, so after downloading it run `xattr -dr com.apple.quarantine /Applications/TasksBar.app` once. The first launch adds it to Login Items; "Open at Login" in its menu turns that off and on.
- **Windows**: take `TasksTray.exe`, or run `dotnet publish native/windows/TasksTray -c Release -r win-x64`. Windows may warn that it's from an unknown publisher: choose "More info", then "Run anyway". The first launch makes it start with Windows; "Start with Windows" in its menu turns that off and on.

What they show:
- The current task and its timer.
- Pause/Resume and Done.
- "Switch to" across all workspaces and macrotasks.
- Today's total.
- The web app in a small window by the icon, already logged in with the tools' session ("Open web app"; on Windows a click on the icon). "Open in browser" opens it in the browser instead.

While a task runs they ask "how far along?" every 45 minutes (`checkInMinutes` in `~/.config/tasks/config.json`, 0 turns it off); with no answer in 10 minutes (`checkInGraceMinutes`) the task is paused as of the question, and they offer to resume it as soon as you use the computer again. When the computer sleeps, locks (or turns the display off), shuts down or logs out they pause the running task (`pauseOnSleep: false` turns that off), and when you're back they ask whether to resume it.

To publish a version, write its text in `.github/release-notes/<tag>.md` and push the tag, such as `v2.1.0`. CI builds both apps and attaches them to that tag's release, creating the release if needed.

## Development

```sh
npm ci
npm test                 # core (vitest) + server API (jest)
npm run dev:server       # API on :8099, data in ./tmp/data, no login
npm run dev:web          # web app on :4200, proxied to :8099
```

Only one todo runs at a time across all workspaces; starting one pauses the other.

`legacy/` holds the original version, for reference.
