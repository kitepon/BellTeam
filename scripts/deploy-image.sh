#!/bin/sh
# Internal adapter: image acquisition plus the public installer and overlay.
set -eu
cd "$(dirname "$0")/.."
repo=$(pwd)
recovery=false
saved=
case "$#:${1-}" in
  0:) ;;
  2:--recover) recovery=true; saved=$2 ;;
  *) echo 'usage: scripts/deploy-image.sh [--recover generation]' >&2; exit 2;;
esac
finish() {
  result=$?
  trap - 0
  if "$recovery"; then printf 'recovery-exit=%s\n' "$result"; else printf 'deploy-exit=%s\n' "$result"; fi
  exit "$result"
}
trap finish 0
export COMPOSE_FILE="$repo/distribution/server/compose.yaml:$repo/distribution/internal/compose.overlay.yaml"
export COMPOSE_PROJECT_NAME=bellteam
export BELLTEAM_INTERNAL_PROFILE_FILE="$repo/src/distribution-profile.mjs"
export BELLTEAM_INSTALL_DIR=$repo
if "$recovery"; then
  sh distribution/server/install.sh --recover "$saved"
else
  if [ -z "${BELLTEAM_SERVER_IMAGE:-}" ]; then
    COMPOSE_FILE="$repo/compose.yaml" docker compose build --pull --no-cache
    image=$(COMPOSE_FILE="$repo/compose.yaml" docker compose config --images)
    case "$image" in ''|*[[:space:]]*) echo SERVER_STATE_IMAGE_INVALID >&2; exit 1;; esac
    BELLTEAM_SERVER_IMAGE=$(docker image inspect --format '{{.Id}}' "$image")
    export BELLTEAM_SERVER_IMAGE
  else
    docker compose pull bellteam
  fi
  sh distribution/server/install.sh --no-pull
fi
