# Running the server on a home server

From scratch: an empty server, the repo checked out in its own folder, the data in a `data/` folder
inside it, a reverse proxy in front.

You need a Linux host with Docker Engine and the compose plugin (`docker compose version`), and git,
plus the Docker network your proxy runs on (`proxy_network`). Nothing else: the image builds
the app itself.

## 1. Check out and configure

```sh
git clone https://github.com/Astervista/tasks.git ~/tasks    # any folder works
cd ~/tasks
cp .env.example .env
chmod 600 .env

# Your user as the owner of the data
sed -i "s/^TASKS_UID=.*/TASKS_UID=$(id -u)/; s/^TASKS_GID=.*/TASKS_GID=$(id -g)/" .env

mkdir data
```

The defaults in `.env` fit this setup:

| Setting | Value |
|---|---|
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
# 200: up
```

**At boot:** the container has `restart: unless-stopped`, so it comes back whenever Docker starts.
Make sure Docker itself starts at boot: `sudo systemctl enable docker` (already the default on most
distributions).

## 3. Reverse proxy and login

**The server does no authentication of its own.** The login service in front of it decides who gets in, so the proxy host must have the block below, and nothing else may be able to reach the server. Any other container on `proxy_network` can reach it directly, so only keep containers you trust on that network.

Point a proxy host on `proxy_network` at `http://tasks-server:8080`, with TLS and Force SSL, and put this under **Advanced** (in Nginx Proxy Manager, the **Custom Nginx Configuration** tab):

```nginx
proxy_read_timeout 90s;
proxy_send_timeout 90s;

auth_request /_permission_check;

auth_request_set $redirect_url $upstream_http_x_redirect_url;

# Passes the renewed session cookie on to the browser
auth_request_set $auth_set_cookie $upstream_http_set_cookie;
add_header Set-Cookie $auth_set_cookie always;

error_page 401 = @permission_redirect;
error_page 403 = @permission_redirect;
error_page 404 = @permission_not_found;

location = /_permission_check {
    internal;

    proxy_pass http://astervista-auth-backend:1000/permission;

    proxy_pass_request_body off;
    proxy_set_header Content-Length "";

    proxy_set_header Cookie $http_cookie;
    proxy_set_header X-Domain $host;
    proxy_set_header X-Path $request_uri;
    proxy_set_header X-Scheme $scheme;
    proxy_set_header X-Original-Method $request_method;
}

location @permission_redirect {
    return 302 $redirect_url;
}

location @permission_not_found {
    return 404;
}

# Replaces the default "/" location, whose own add_header would drop the session cookie renewal.
location / {
    add_header Set-Cookie $auth_set_cookie always;

    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $http_connection;
    proxy_http_version 1.1;

    include conf.d/include/proxy.conf;
}
```

If HTTPS ends before Nginx Proxy Manager (for example, Cloudflare connects to it over plain HTTP), `$scheme` is `http`: use `proxy_set_header X-Scheme https;` instead.

**Let the tools in.** The CLI, the daemon and the tray apps use a tool login, and a tool session only passes a path whose rule requires a permission flagged for Tools. A rule that only requires being logged in refuses it. On the login service, give this host's rule a permission that's yours to use, such as `tasks`, turn on **Tools** next to it in the **Permissions and Roles** admin tab, and give it to your account. Names starting with `admin-` or `manage-` can't be flagged.

Live updates (server-sent events on `/api/events`) pass through nginx unbuffered: the server marks them with `X-Accel-Buffering: no`. Its 25-second heartbeat keeps them open through the 90-second read timeout above.

## 4. Point your computers at it

On each computer with the CLI:

```sh
tasks remote set https://tasks.example.com     # also logs in, showing a QR code and a code to approve
cd ~/projects/something && tasks init          # once per project folder
```

The CLI, the daemon and the tray app share one session, in `~/.config/tasks/session.json`, readable only by you. It lasts 30 days and each use extends it. If it ends, run `tasks login` or use "Log in…" in the tray menu; the daemon and the tray app pick up the new session by themselves. `tasks logout` ends it.

The daemon and the tray app read the same config. Restart them after changing the remote, which also logs you out:

- macOS: `launchctl kickstart -k gui/$(id -u)/com.tasks.daemon`, then quit and reopen TasksBar.
- Windows: sign out and in, or restart `TasksTray.exe` and the `TasksDaemon` scheduled task (`schtasks /Run /TN TasksDaemon`).

## Moving from the shared token

Do it in this order. **The nginx block comes first:** the old block lets through any request with an `Authorization: Bearer` header, and the new server no longer checks it, so that order mistake would leave the API open to anyone.

1. Flag the permission for Tools, as in step 3.
2. Replace the proxy host's Advanced block with the one in step 3.
3. Deploy the server (see Updating) and delete `TASKS_TOKEN` and `AUTH_MODE` from `.env`.
4. On each computer, update the CLI and the tray app, restart them, and run `tasks login`. The old token is removed from `config.json`.

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
`127.0.0.1:8080`, with no login at all.
