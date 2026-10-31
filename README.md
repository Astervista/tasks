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
archiveAfterDays: 14
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

The HTML comments hold sync metadata, are invisible when rendered, and should be left alone. Done top-level todos move to `TODO.archive.md` after `archiveAfterDays`.

**How sync merges.** No copy is kept besides the server's and the project's:
- The `h:` hash tells which todos you edited by hand. The `rev:` tells which ones changed on the server since the file was synced.
- Edits on different todos simply merge.
- If the same todo changed on both sides, the newer edit wins and the time logs are combined.

## Server (Docker)

Step by step, from an empty host to your computers syncing: **[DEPLOY.md](DEPLOY.md)**. In short:

```sh
cp .env.example .env            # set TASKS_TOKEN, AUTH_MODE, TASKS_UID/GID
mkdir data
sh scripts/deploy.sh            # build, start, clean up old images and build cache
```

Data lives in `data/` (`data/workspaces/<uid>/TODO.md`, plain Markdown). Deleted workspaces go to `data/trash`. Put TLS and your login service in front with a reverse proxy (see DEPLOY.md).

The CLI, the daemon and the tray apps always send the token. The web app depends on `AUTH_MODE`:

- `token`: the web app asks for the token once.
- `proxy`: a login service in front of the server (Authelia, oauth2-proxy, …) already guards it. Requests without a token are trusted; a token that is sent must still be right. Only use this when nothing reaches the server around the login service.

## CLI and daemon

```sh
npm ci && npm run cli:install                                 # installs the `tasks` command
tasks remote set https://tasks.example.com --token <token>   # once per machine
cd ~/projects/something && tasks init                        # asks name + description, links the folder (re-running is a no-op)
tasks daemon install                                         # keeps every linked project in sync, at login
```

| Command | What it does |
|---|---|
| `tasks show [--history]` | Browse the folder's TODO.md in the terminal; `--history` (or `h`) shows days, sessions and completed work |
| `tasks status` | State of every linked project |
| `tasks sync` | Syncs now |
| `tasks clone <uid>` | Links a folder to a project created in the web app |
| `tasks list --remote` | Every project on the server, with its uid |
| `tasks forget` | Stops syncing a folder (nothing is deleted) |

`tasks init` behaves like this:
- In a folder that is already registered, it does nothing.
- In a folder whose `TODO.md` belongs to a workspace the server knows (another machine, a moved folder), it only registers the folder.
- Otherwise it creates a new workspace.

## Tray apps

Both read the remote and token from the CLI's config, so there's nothing to set up.

- **macOS**: run `native/macos/bundle.sh`, copy `native/macos/build/TasksBar.app` to /Applications, and add it to Login Items.
- **Windows**: run `dotnet publish native/windows/TasksTray -c Release -r win-x64`, or take `TasksTray.exe` from the CI artifacts.

What they show:
- The current task and its timer.
- Pause/Resume and Done.
- "Switch to" across all workspaces and macrotasks.
- Today's total.
- A link to the web app.

## Development

```sh
npm ci
npm test                 # core (vitest) + server API (jest)
npm run dev:server       # API on :8099, data in ./tmp/data, token dev-token-change-me-0123
npm run dev:web          # web app on :4200, proxied to :8099
```

Only one todo runs at a time across all workspaces; starting one pauses the other.

`legacy/` holds the original version, for reference.
