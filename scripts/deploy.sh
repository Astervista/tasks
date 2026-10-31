#!/bin/sh
# Rebuilds and restarts the server container, then frees what old builds leave behind:
# superseded images of this project and build cache beyond a small budget (the most recently used
# layers stay, so the next rebuild is still quick).
set -e
cd "$(dirname "$0")/.."

CACHE_BUDGET="${CACHE_BUDGET:-1gb}"

docker compose up -d --build
docker image prune -f --filter "label=com.docker.compose.project=$(basename "$PWD")" >/dev/null
# --max-used-space needs BuildKit 0.17+; older Docker Desktop builders only know --keep-storage
docker builder prune -f --max-used-space "$CACHE_BUDGET" >/dev/null 2>&1 \
  || docker builder prune -f --keep-storage "$CACHE_BUDGET" >/dev/null
docker system df
