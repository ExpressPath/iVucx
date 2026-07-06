#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/opt/ivucx-helper"
COMPOSE_FILE="$APP_DIR/deploy/gce/compose.yaml"
RUNTIME_ENV_FILE="$APP_DIR/deploy/gce/.env.runtime"

metadata() {
  local key="$1"
  curl -fsSL -H "Metadata-Flavor: Google" \
    "http://metadata.google.internal/computeMetadata/v1/instance/attributes/${key}" || true
}

REPO_URL="$(metadata ivucx-helper-repo-url)"
REPO_URL="${REPO_URL:-https://github.com/user-it0/nodejs.git}"
REPO_REF="$(metadata ivucx-helper-repo-ref)"
REPO_REF="${REPO_REF:-main}"
ENV_FROM_METADATA="$(metadata ivucx-helper-env)"

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y ca-certificates curl git docker.io
if ! apt-get install -y docker-compose-plugin; then
  if ! apt-get install -y docker-compose; then
    curl -fsSL \
      https://github.com/docker/compose/releases/download/v2.29.7/docker-compose-linux-x86_64 \
      -o /usr/local/bin/docker-compose
    chmod +x /usr/local/bin/docker-compose
  fi
fi

systemctl enable docker
systemctl restart docker

mkdir -p "$APP_DIR"
if [ ! -d "$APP_DIR/.git" ]; then
  git clone "$REPO_URL" "$APP_DIR"
fi

git -C "$APP_DIR" fetch --depth=1 origin "$REPO_REF"
git -C "$APP_DIR" checkout -f FETCH_HEAD

if grep -q 'dockerfile: ../../Dockerfile' "$COMPOSE_FILE"; then
  sed -i 's#dockerfile: ../../Dockerfile#dockerfile: Dockerfile#' "$COMPOSE_FILE"
fi

if [ -n "$ENV_FROM_METADATA" ]; then
  mkdir -p "$(dirname "$RUNTIME_ENV_FILE")"
  printf '%s\n' "$ENV_FROM_METADATA" > "$RUNTIME_ENV_FILE"
  chmod 600 "$RUNTIME_ENV_FILE"
fi

if docker compose version >/dev/null 2>&1; then
  docker compose -f "$COMPOSE_FILE" --env-file "$RUNTIME_ENV_FILE" up --build -d
else
  docker-compose --env-file "$RUNTIME_ENV_FILE" -f "$COMPOSE_FILE" up --build -d
fi
