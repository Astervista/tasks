# Running the server on a home server

From scratch: an empty server, the repo checked out in its own folder, the data in a `data/` folder
inside it, a reverse proxy in front.

You need a Linux host with Docker Engine and the compose plugin (`docker compose version`), git and
openssl, plus the Docker network your proxy runs on (`proxy_network`). Nothing else: the image builds
the app itself.

## 1. Check out and configure

```sh
git clone https://github.com/Astervista/tasks.git ~/tasks    # any folder works
cd ~/tasks
cp .env.example .env
chmod 600 .env

# A fresh secret, and your user as the owner of the data
sed -i "s/^TASKS_TOKEN=.*/TASKS_TOKEN=$(openssl rand -hex 32)/" .env
sed -i "s/^TASKS_UID=.*/TASKS_UID=$(id -u)/; s/^TASKS_GID=.*/TASKS_GID=$(id -g)/" .env

mkdir data
```

The defaults in `.env` fit this setup:

| Setting | Value |
|---|---|
| `AUTH_MODE` | `token`: every request needs the token (step 3) |
| `PROXY_NETWORK` | `proxy_network`, the network your reverse proxy is on. The server joins it and publishes no port, so only containers on that network reach it |
| `DATA_PATH` | `./data` (the folder you just made); any other path works too |

`data/` holds one folder per project with plain `TODO.md` / `TODO.archive.md` files. Back it up like any
folder. It is git-ignored, so `git pull` never touches it.

## 2. Start

```sh
sh scripts/deploy.sh
docker compose ps        # wait for "(healthy)"
```

`deploy.sh` builds the image, starts the container, removes the image it replaced, and trims Docker's
build cache to 1 GB (`CACHE_BUDGET=2gb sh scripts/deploy.sh` to keep more). The cache is shared with
your other projects; trimming only makes their next build slower.

On the network the server is `http://tasks-server:8080`. To check from the host, without a port:

```sh
docker compose exec tasks node -e "fetch('http://127.0.0.1:8080/api/current').then(r => console.log(r.status))"
# 401: up, and asking for the token as it should
```

**At boot:** the container has `restart: unless-stopped`, so it comes back whenever Docker starts.
Make sure Docker itself starts at boot: `sudo systemctl enable docker` (already the default on most
distributions).

## 3. Reverse proxy

Point a proxy host on `proxy_network` at `http://tasks-server:8080`, with TLS.

The CLI, the daemon and the tray apps always send `Authorization: Bearer <token>`. In the browser,
the web app asks for the token once and remembers it. If something in front of the server already
authenticates your users, it can add `Authorization: Bearer <token>` to their `/api/` requests
instead, and the web app never asks.

Live updates (server-sent events on `/api/events`) pass through nginx unbuffered: the server marks
them with `X-Accel-Buffering: no`. Its 25-second heartbeat keeps them open through proxy read
timeouts of 30 seconds or more.

## 4. Point your computers at it

On each computer with the CLI:

```sh
tasks remote set https://tasks.example.com --token <TASKS_TOKEN from the server's .env>
cd ~/projects/something && tasks init          # once per project folder
```

The daemon and the tray app read the same config. Restart them after changing the remote:

- macOS: `launchctl kickstart -k gui/$(id -u)/com.tasks.daemon`, then quit and reopen TasksBar.
- Windows: sign out and in, or restart `TasksTray.exe` and the `TasksDaemon` scheduled task (`schtasks /Run /TN TasksDaemon`).

## Updating

```sh
cd ~/tasks
git pull
sh scripts/deploy.sh
```

## Moving the data folder later

Stop with `docker compose down`, move the folder (or change `DATA_PATH` in `.env`), and run
`sh scripts/deploy.sh` again. The files are plain Markdown; nothing else holds state.

## Without a reverse proxy (local testing)

`docker network create proxy_network` once, then add
`COMPOSE_FILE=docker-compose.yml:docker-compose.local.yml` to `.env`: the server is also published on
`127.0.0.1:8080`.
