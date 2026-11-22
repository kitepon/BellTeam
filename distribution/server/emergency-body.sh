#!/bin/sh
# Put a body in when the body cannot start (docs/architecture/modules/runtime/emergency-body.md).
# usage: sh emergency-body.sh ghcr.io/kitepon/bellteam-server@sha256:<digest>
#        sh emergency-body.sh --local <image id from docker build>      (operator-built body)
# Run as a user with Docker access, on the box. Project name: BELLTEAM_PROJECT (default bellteam).
set -eu
project=${BELLTEAM_PROJECT:-bellteam}
local=
case "${1-}" in --local) local=--local; shift;; esac
[ "$#" -eq 1 ] || { echo 'usage: sh emergency-body.sh [--local] <image>' >&2; exit 2; }
case "$project" in ''|*[!a-zA-Z0-9_.-]*) echo 'BELLTEAM_PROJECT is invalid' >&2; exit 2;; esac
if [ -n "$local" ]; then
  image=$(docker image inspect --format '{{.Id}}' "$1")
else
  case "$1" in ghcr.io/kitepon/bellteam-server@sha256:*) ;; *) echo 'published image must be ghcr.io/kitepon/bellteam-server@sha256:<digest>' >&2; exit 2;; esac
  docker pull "$1"
  image=$1
fi
volume=$project-container-updater
mountpoint=$(docker volume inspect --format '{{.Mountpoint}}' "$volume")
# Same shape as ContainerUpdater.launch_service: the TARGET image, root, the updater volume at its prefix and its mountpoint, the Docker socket.
exec docker run --rm --init --read-only --user 0:0 --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER \
  --security-opt no-new-privileges:true --memory 2g --memory-swap 2g --pids-limit 512 --tmpfs /tmp:rw,nosuid,nodev,size=64m \
  --mount "type=volume,source=$volume,target=/srv/bellteam-container-updater,volume-nocopy" \
  --mount "type=volume,source=$volume,target=$mountpoint,volume-nocopy" \
  --mount type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock \
  --entrypoint /usr/bin/python3 "$image" -I -B /app/scripts/emergency-body.py $local "$image"
