#!/usr/bin/env bash
# Build the Burrow image and roll the production instance in ~/dev/apps/burrow.
#   pnpm prod:deploy              # checks, build, backup, restart, wait for health
#   SKIP_CHECKS=1 pnpm prod:deploy
set -euo pipefail

REPO=$(cd "$(dirname "$0")/.." && pwd)
APP_DIR=${BURROW_APP_DIR:-$HOME/dev/apps/burrow}
CONTAINER=burrow
IMAGE=burrow
PORT=${BURROW_PORT:-4200}
KEEP_BACKUPS=30
KEEP_IMAGES=5
# The public URL lives in the production .env (BURROW_PUBLIC_URL), not in this repo.
PUBLIC_URL=$(sed -n 's/^BURROW_PUBLIC_URL=//p' "$APP_DIR/.env" 2>/dev/null | tail -n 1)

cd "$REPO"
VERSION=$(git rev-parse --short HEAD)
if ! git diff --quiet || ! git diff --cached --quiet; then VERSION="$VERSION-dirty"; fi
step() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }

if [ "${SKIP_CHECKS:-0}" != 1 ]; then
  step "checks (typecheck, lint, format, tests)"
  pnpm -s check
fi

step "build $IMAGE:$VERSION"
docker build --build-arg BURROW_VERSION="$VERSION" -t "$IMAGE:$VERSION" -t "$IMAGE:latest" .

if docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  step "backup the live database"
  mkdir -p "$APP_DIR/data/backups"
  name="burrow-$(date +%Y%m%d-%H%M%S)-before-$VERSION.sqlite"
  # VACUUM INTO gives a consistent copy while the app keeps running.
  docker exec "$CONTAINER" node -e "new (require('node:sqlite').DatabaseSync)('/data/burrow.sqlite').exec(\"vacuum into '/data/backups/$name'\")" 2>/dev/null
  echo "  $APP_DIR/data/backups/$name"
  ls -1t "$APP_DIR/data/backups"/burrow-*.sqlite | tail -n +$((KEEP_BACKUPS + 1)) | xargs -r rm --
fi

step "start"
docker compose --project-directory "$APP_DIR" up -d --remove-orphans

step "wait for $VERSION to be healthy"
for _ in $(seq 1 30); do
  if curl -fsS "http://localhost:$PORT/api/health" 2>/dev/null | grep -q "\"version\":\"$VERSION\""; then
    echo "  up: http://localhost:$PORT${PUBLIC_URL:+  ·  $PUBLIC_URL}"
    old=$(docker image ls "$IMAGE" --format '{{.Tag}} {{.CreatedAt}}' | grep -v '^latest ' | sort -k2 -r | awk '{print $1}' | tail -n +$((KEEP_IMAGES + 1)))
    for t in $old; do docker image rm "$IMAGE:$t" >/dev/null 2>&1 || true; done
    exit 0
  fi
  sleep 1
done
echo "  not healthy after 30 s — last logs:" >&2
docker logs --tail 40 "$CONTAINER" >&2
exit 1
