#!/bin/sh
# Run after compose stop, before touching data/HOME/Cursor. No Docker socket
# is mounted into the reader, and only container state/mounts are inspected.
set -eu
image=$(docker compose config --images)
case "$image" in ''|*[[:space:]]*) echo SERVER_STATE_IMAGE_INVALID >&2; exit 1;; esac
image=$(docker image inspect --format '{{.Id}}' "$image")
digest=${image#sha256:}
case "$digest" in *[!a-f0-9]*|'') echo SERVER_STATE_IMAGE_INVALID >&2; exit 1;; esac
[ "$image" = "sha256:$digest" ] && [ "${#digest}" -eq 64 ] || { echo SERVER_STATE_IMAGE_INVALID >&2; exit 1; }
command -v realpath >/dev/null || { echo SERVER_STATE_REALPATH_REQUIRED >&2; exit 1; }
staging=$(mktemp -d "${TMPDIR:-/tmp}/bellteam-writers.XXXXXX")
trap 'rm -rf "$staging"' 0
trap 'exit 1' 1 2 15
config=$(docker compose config --format json)
printf '%s' "$config" | docker run --pull never --rm -i --network none --read-only \
  --entrypoint /usr/local/bin/node "$image" /app/src/server-state-writers.mjs plan > "$staging/plan.json"
unset config
ids=$(docker ps -aq --no-trunc)
: > "$staging/containers.jsonl"
if [ -n "$ids" ]; then
  # Docker emits hexadecimal IDs, never arbitrary shell input.
  set -- $ids
  for id do case "$id" in *[!a-f0-9]*|'') echo SERVER_STATE_CONTAINER_ID_INVALID >&2; exit 1;; esac; done
  docker inspect --format '{"id":{{json .Id}},"running":{{json .State.Running}},"restarting":{{json .State.Restarting}},"mounts":{{json .Mounts}}}' \
    "$@" > "$staging/containers.jsonl"
fi
reader() {
  docker run --pull never --rm --network none --read-only --user 0:0 \
    --mount "type=bind,source=$staging,target=/check,readonly" \
    --entrypoint /usr/local/bin/node "$image" /app/src/server-state-writers.mjs "$1"
}
reader sources > "$staging/sources.txt"
: > "$staging/canonical.txt"
while IFS= read -r kind && IFS= read -r source; do
  case "$kind" in
    observed) [ -e "$source" ] || { echo SERVER_STATE_HOST_PATH_UNAVAILABLE >&2; exit 1; };;
    planned) ;;
    *) echo SERVER_STATE_PATH_INVALID >&2; exit 1;;
  esac
  current=$source
  suffix=
  # Fresh installs may not have the final directories yet. Resolve every
  # existing ancestor; a dangling symlink is not an absent fresh directory.
  while [ ! -e "$current" ]; do
    [ ! -L "$current" ] || { echo SERVER_STATE_PATH_INVALID >&2; exit 1; }
    parent=$(dirname "$current")
    [ "$parent" != "$current" ] || { echo SERVER_STATE_PATH_INVALID >&2; exit 1; }
    suffix="/$(basename "$current")$suffix"
    current=$parent
  done
  resolved=$(realpath "$current")
  if [ "$resolved" = / ] && [ -z "$suffix" ]; then canonical=/
  else canonical="${resolved%/}$suffix"; fi
  printf '%s\n%s\n' "$source" "$canonical" >> "$staging/canonical.txt"
done < "$staging/sources.txt"
reader verify
