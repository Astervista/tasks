# Running the server on a home server

From scratch: an empty server, the repo checked out in its own folder, the data in a `data/` folder inside it.

You need a Linux host with Docker Engine and the compose plugin (`docker compose version`), git, and
openssl. Nothing else: the image builds the app itself.

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

Then open `.env` and set:

| Setting | Value |
|---|---|
| `AUTH_MODE` | `proxy` when your login service guards the web app (see step 3), `token` otherwise |
| `BIND` | `127.0.0.1` when the reverse proxy runs on this host; this host's LAN address when it runs elsewhere |
| `PORT` | the host port, `8080` unless it is taken |
| `DATA_PATH` | `./data` (the folder you just made); any other path works too |

`data/` holds one folder per project with plain `TODO.md` / `TODO.archive.md` files. Back it up like any
folder. It is git-ignored, so `git pull` never touches it.

## 2. Start

```sh
sh scripts/deploy.sh
docker compose ps                               # wait for "(healthy)"
curl -i http://127.0.0.1:8080/api/current       # 200 in proxy mode, 401 in token mode
```

`deploy.sh` builds the image, starts the container, removes the image it replaced, and trims Docker's
build cache to 1 GB (`CACHE_BUDGET=2gb sh scripts/deploy.sh` to keep more). The cache is shared with
your other projects; trimming only makes their next build slower.

**At boot:** the container has `restart: unless-stopped`, so it comes back whenever Docker starts.
Make sure Docker itself starts at boot: `sudo systemctl enable docker` (already the default on most
distributions).

## 3. Reverse proxy and login service

Give it a name and TLS in your reverse proxy. The web app goes through your login service; the CLI,
the daemon and the tray apps cannot log in there, but they always send `Authorization: Bearer <token>`.
Let exactly those requests through: the server checks the token whenever one is sent, so a wrong one
gets a 401.

Caddy with Authelia, for example:

```
tasks.example.com {
    @token header Authorization "Bearer *"
    handle @token {
        reverse_proxy 127.0.0.1:8080
    }
    handle {
        forward_auth authelia:9091 {
            uri /api/authz/forward-auth
            copy_headers Remote-User Remote-Groups Remote-Email Remote-Name
        }
        reverse_proxy 127.0.0.1:8080
    }
}
```

With `AUTH_MODE=proxy`, a request without a token is trusted. So nothing may reach port 8080 except
through the proxy: keep `BIND=127.0.0.1`, or firewall the port to the proxy's address.

## 4. Point your computers at it

On each computer with the CLI:

```sh
tasks remote set https://tasks.example.com --token <TASKS_TOKEN from the server's .env>
cd ~/projects/something && tasks init          # once per project folder
```

The daemon and the tray app read the same config. Restart them after changing the remote:

- macOS: `launchctl kickstart -k gui/$(id -u)/com.tasks.daemon`, then quit and reopen TasksBar.
- Windows: sign out and in, or restart `TasksTray.exe` and the `TasksDaemon` scheduled task (`schtasks /Run /TN TasksDaemon`).

To read the token on the server without printing it into your shell history:
`grep ^TASKS_TOKEN= .env | cut -d= -f2`.

## Updating

```sh
cd ~/tasks
git pull
sh scripts/deploy.sh
```

## Moving the data folder or the port later

Stop with `docker compose down`, move the folder (or change `.env`), and run `sh scripts/deploy.sh`
again. The files are plain Markdown; nothing else holds state.
