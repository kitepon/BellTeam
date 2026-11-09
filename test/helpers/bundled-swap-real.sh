#!/bin/sh
# One real bundled body swap OLD -> NEW on real Docker (Trony 2026-11-10): real volumes,
# uid 1000, capabilities as shipped. Asserts no failure marker, the Aiterm state log line
# and a surviving uid-1000 sentinel. Usage: bundled-swap-real.sh <old ref> <new ref> <new source>
set -eu
old=$1 new=$2 source=$3
here=$(cd "$(dirname "$0")" && pwd)
work=${RUNNER_TEMP:-/tmp}/bundled-swap
export COMPOSE_PROJECT_NAME=bundled-swap BELLTEAM_SERVER_STATE_VOLUME=bundled-swap-state
mkdir -p "$work"
cp "$here/../../distribution/server/compose.yaml" "$here/../../distribution/server/install.sh" "$work/"
cd "$work"
docker pull -q "$old" >/dev/null
docker pull -q "$new" >/dev/null
# The old body is installed by the public installer, as a user's install would be.
BELLTEAM_SERVER_IMAGE="$old" sh install.sh --no-pull

body=$(docker compose ps -q bellteam)
aiterm=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/srv/bellteam-aiterm"}}{{.Name}}{{end}}{{end}}' "$body")
[ -n "$aiterm" ]
before=$(docker volume inspect --format '{{.Name}} {{.CreatedAt}}' "$aiterm")
old_id=$(docker image inspect --format '{{.Id}}' "$old")
docker run --rm --network none --read-only --user 1000:1000 --cap-drop ALL --mount "type=volume,source=$aiterm,target=/s" \
  --entrypoint /bin/sh "$old_id" -c 'printf ci-sentinel > /s/.ci-swap-sentinel'

updater=bundled-swap-container-updater
root=$(docker volume inspect --format '{{.Mountpoint}}' "$updater")
# Same launch as ContainerUpdater.launch_service; the harness replaces only the ledger entry point.
docker run --rm --init --read-only --user 0:0 --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER \
  --security-opt no-new-privileges:true --tmpfs /tmp:rw,nosuid,nodev,size=64m \
  --mount "type=volume,source=$updater,target=/srv/bellteam-container-updater,volume-nocopy" \
  --mount "type=volume,source=$updater,target=$root,volume-nocopy" \
  --mount type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock \
  --mount "type=bind,source=$here/bundled-swap-worker.py,target=/ci/bundled-swap-worker.py,readonly" \
  --entrypoint /usr/bin/python3 "$old_id" -I -B /ci/bundled-swap-worker.py "$new" "$source" > swap.json

node --input-type=module - "$work/swap.json" "$before" "$aiterm" "$(docker image inspect --format '{{.Id}}' "$new")" <<'JS'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
const [file, before, aiterm, newId] = process.argv.slice(2)
const { result, installerLog } = JSON.parse(readFileSync(file, 'utf8'))
console.log(installerLog)
assert.deepEqual(result, { execution: 'succeeded', verification: 'succeeded', cleanup: 'succeeded', rollback: 'not_needed', error: null })
// Every `|| printf <marker>` sink in the swap path must stay silent on a real swap.
for (const marker of ['aiterm-state-apply=failed', 'note=SELECT_FAILED', 'RESUME_PRESERVE_UNCONFIRMED', 'quiesce=unconfirmed'])
  assert.ok(!installerLog.includes(marker), marker)
assert.match(installerLog, /^aiterm=preserved/m)
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim()
assert.equal(docker('volume', 'inspect', '--format', '{{.Name}} {{.CreatedAt}}', aiterm), before)
const body = docker('compose', 'ps', '-q', 'bellteam')
assert.equal(docker('inspect', '--format', '{{.Image}} {{.State.Health.Status}}', body), `${newId} healthy`)
const read = path => docker('run', '--rm', '--network', 'none', '--read-only', '--user', '1000:1000', '--cap-drop', 'ALL',
  '--mount', `type=volume,source=${aiterm},target=/s,readonly`, '--entrypoint', '/bin/cat', newId, path)
assert.equal(read('/s/.ci-swap-sentinel'), 'ci-sentinel')
assert.match(read('/s/.bellteam-reset/aiterm-state.log'), / aiterm=preserved/)
console.log('bundled swap OK: preserved, state line written, sentinel kept')
JS
