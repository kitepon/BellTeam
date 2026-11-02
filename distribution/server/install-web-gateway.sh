#!/bin/sh
# Online placement only: never stop, recreate, or adopt a running server/gateway.
set -eu
[ "$#" -eq 4 ] || { echo GATEWAY_INSTALL_ARGUMENTS >&2; exit 2; }
saved=$(CDPATH= cd "$1" && pwd)
[ "$(dirname "$saved")" = "$PWD" ] && [ -f "$saved/normal.json" ] || { echo GATEWAY_INSTALL_SAVED_MODEL >&2; exit 1; }
case "$(basename "$saved")" in .bellteam-compose.*) ;; *) echo GATEWAY_INSTALL_SAVED_MODEL >&2; exit 1;; esac
version=$2; source=$3; signer=$4
case "$version$source$signer" in *[!a-f0-9]*) echo GATEWAY_INSTALL_ARGUMENTS >&2; exit 2;; esac
[ "${#version}" -eq 64 ] && [ "${#source}" -eq 40 ] && [ "${#signer}" -eq 40 ] || { echo GATEWAY_INSTALL_ARGUMENTS >&2; exit 2; }
umask 077
staging=$(mktemp -d "${TMPDIR:-/tmp}/bellteam-gateway-install.XXXXXX")
trap 'rm -rf "$staging"' 0
trap 'exit 1' 1 2 15
cid=$(docker compose --project-directory "$PWD" -f "$saved/normal.json" ps --all --quiet --no-trunc bellteam)
case "$cid" in *[!a-f0-9]*) echo GATEWAY_INSTALL_CONTAINER >&2; exit 1;; esac
[ "${#cid}" -eq 64 ] || { echo GATEWAY_INSTALL_CONTAINER >&2; exit 1; }
# No Config.Env or credentials enter the model or command output.
docker container inspect --format '{"id":{{json .Id}},"image":{{json .Image}},"running":{{json .State.Running}},"restarting":{{json .State.Restarting}},"readOnly":{{json .HostConfig.ReadonlyRootfs}},"mounts":{{json .Mounts}},"specMounts":{{json .HostConfig.Mounts}},"project":{{json (index .Config.Labels "com.docker.compose.project")}}}' "$cid" > "$staging/current.json"
image=$(docker container inspect --format '{{.Image}}' "$cid")
case "$image" in sha256:*) ;; *) echo GATEWAY_INSTALL_IMAGE >&2; exit 1;; esac
image_digest=${image#sha256:}
case "$image_digest" in *[!a-f0-9]*) echo GATEWAY_INSTALL_IMAGE >&2; exit 1;; esac
[ "${#image_digest}" -eq 64 ] || { echo GATEWAY_INSTALL_IMAGE >&2; exit 1; }
docker compose --project-directory "$PWD" -f "$saved/normal.json" config --format json > "$staging/normal.json"
{
  printf '['; cat "$staging/normal.json"; printf ','; cat "$staging/current.json"; printf ']'
} | docker run --pull never --rm -i --network none --read-only --entrypoint /usr/local/bin/node "$image" /app/src/web-gateway-install-plan.mjs > "$staging/helper.json"
docker compose --project-directory "$PWD" -f "$staging/helper.json" run --pull never --rm --no-deps -T web-gateway-install "$version" "$source" "$signer"
