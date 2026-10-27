#!/bin/sh
# Run after compose stop, before touching data/HOME/Cursor. No Docker socket
# is mounted into the reader, and only container state/mounts are inspected.
set -eu
case "$#:${1-}" in
  0:) maintenance=false;;
  1:--maintenance) maintenance=true;;
  *) echo SERVER_STATE_WRITER_ARGUMENTS_INVALID >&2; exit 1;;
esac
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
if "$maintenance"; then
  # Keep the caller's actual normal overlays and project when adding maintenance.
  maintenance_compose="$(CDPATH= cd "$(dirname "$0")/.." && pwd)/compose.state-maintenance.json"
  config=$(COMPOSE_FILE="${COMPOSE_FILE:-compose.yaml}${COMPOSE_PATH_SEPARATOR:-:}$maintenance_compose" \
    docker compose config --format json)
else
  config=$(docker compose config --format json)
fi
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
reader volumes > "$staging/volume-names.txt"
: > "$staging/volumes.jsonl"
while IFS= read -r volume; do
  [ -n "$volume" ] || continue
  case "$volume" in *[!a-zA-Z0-9_.-]*) echo SERVER_STATE_VOLUME_INVALID >&2; exit 1;; esac
  # Read backing metadata, not arbitrary driver option values. Unsupported
  # drivers/options remain unknown; credentials in remote-driver options are
  # never copied to the evidence directory.
  docker volume inspect --format '{"name":{{json .Name}},"driver":{{json .Driver}},"mountpoint":{{json .Mountpoint}},"optionCount":{{len .Options}},"type":{{if and (eq .Driver "local") (eq (index .Options "type") "none")}}{{json (index .Options "type")}}{{else}}null{{end}},"device":{{if and (eq .Driver "local") (eq (index .Options "type") "none") (or (eq (index .Options "o") "bind") (eq (index .Options "o") "bind,rw") (eq (index .Options "o") "rw,bind") (eq (index .Options "o") "rbind"))}}{{json (index .Options "device")}}{{else}}null{{end}},"options":{{if and (eq .Driver "local") (eq (index .Options "type") "none") (or (eq (index .Options "o") "bind") (eq (index .Options "o") "bind,rw") (eq (index .Options "o") "rw,bind") (eq (index .Options "o") "rbind"))}}{{json (index .Options "o")}}{{else}}null{{end}}}' \
    "$volume" >> "$staging/volumes.jsonl"
done < "$staging/volume-names.txt"
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
