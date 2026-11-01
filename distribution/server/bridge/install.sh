#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
cd "$root"
pull=true
combined=false
selected=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --no-pull) pull=false; shift ;;
    --with-bellteam) combined=true; shift ;;
    --image) [ "$#" -ge 2 ] || exit 2; selected=$2; shift 2 ;;
    *) echo 'Usage: sh bridge/install.sh [--no-pull] [--with-bellteam] [--image IMAGE]' >&2; exit 2 ;;
  esac
done
[ -f bridge/bridge.env ] || { echo 'Copy bridge/bridge.env.example to bridge/bridge.env and set your Bridge image and authentication.' >&2; exit 1; }
if [ -n "$selected" ]; then
  CALL_BRIDGE_IMAGE=$selected
  export CALL_BRIDGE_IMAGE
elif [ -z "${CALL_BRIDGE_IMAGE:-}" ] && [ -f runtime/call-bridge/image.ref ]; then
  CALL_BRIDGE_IMAGE=$(cat runtime/call-bridge/image.ref)
  export CALL_BRIDGE_IMAGE
fi
if ! "$pull"; then CALL_BRIDGE_PULL_POLICY=never; export CALL_BRIDGE_PULL_POLICY; fi
compose() {
  if "$combined"; then
    if [ -f .env ]; then
      docker compose --project-directory "$root" --env-file .env --env-file bridge/bridge.env -f compose.yaml -f bridge/compose.yaml -f bridge/compose.bellteam.yaml "$@"
    else
      docker compose --project-directory "$root" --env-file bridge/bridge.env -f compose.yaml -f bridge/compose.yaml -f bridge/compose.bellteam.yaml "$@"
    fi
  else
    docker compose --project-directory "$root" --env-file bridge/bridge.env -f bridge/compose.yaml "$@"
  fi
}
image=$(compose config --images call-bridge)
if "$pull"; then compose pull call-bridge; fi
docker image inspect "$image" >/dev/null
new_data=false
if [ ! -d runtime/call-bridge/data ]; then new_data=true; fi
mkdir -p runtime/call-bridge/data runtime/call-bridge/auth
if "$combined"; then
  # Prepare only the dedicated socket directory, using BellTeam's existing runtime user.
  compose run --pull never --rm --no-deps --entrypoint sh bellteam -c 'mkdir -p /srv/bellteam/state/call-bridge-socket'
fi
if "$new_data"; then
  identity=$(compose run --pull never --rm --no-deps --entrypoint sh call-bridge -c 'printf "%s:%s" "$(id -u)" "$(id -g)"')
  compose run --pull never --rm --no-deps --user root --entrypoint sh call-bridge -c 'chown "$1" /app/data' bridge-data "$identity"
fi
# The product's own authenticator validates the user's configuration before replacement.
compose run --pull never --rm --no-deps --entrypoint python call-bridge -c 'from call_bridge.auth import Authenticator; a = Authenticator.from_env(); raise SystemExit(0 if a.enabled else "Configure CALL_BRIDGE_TOKEN or CALL_BRIDGE_TOKENS_FILE before starting Bridge.")'
previous=
container=$(compose ps -q call-bridge)
if [ -n "$container" ]; then previous=$(docker inspect --format '{{.Config.Image}}' "$container"); fi
compose up -d --wait --wait-timeout 120 --no-deps --pull never call-bridge
if [ -n "$previous" ] && [ "$previous" != "$image" ]; then printf '%s\n' "$previous" > runtime/call-bridge/previous-image.ref; fi
printf '%s\n' "$image" > runtime/call-bridge/image.ref
printf 'Bridge is ready. Image: %s\n' "$image"
printf 'Data remains in runtime/call-bridge/data. Use --image PREVIOUS_REFERENCE --no-pull to roll back while keeping the latest data.\n'
if "$combined"; then
  printf 'BellTeam was not recreated. Apply bridge/compose.bellteam.yaml to BellTeam when enabling the combination, then enter your Bridge token in BellTeam settings.\n'
fi
