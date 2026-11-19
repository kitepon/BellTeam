#!/bin/sh
# Host side of the Apple review server wipe (main-server). $1 = exit code of Sky's review-state.py:
# 0 no review is waiting or in progress, 75 one is, anything else = the state could not be read.
# Installed at /home/kite/BellTeam/runtime/apple-review/wipe/ next to apple-review-wipe.mjs; state file review-seen lives there too.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
server=${REVIEW_SERVER_DIR:-/home/kite/BellTeam/runtime/apple-review/server}
seen="$here/review-seen"
case "${1:?exit code of review-state.py}" in
  75) touch "$seen"; echo "review active: nothing touched"; exit 0 ;;
  0) ;;
  *) echo "review state unreadable (exit $1): nothing touched" >&2; exit 1 ;;
esac
[ -f "$seen" ] || { echo "no review since the last wipe"; exit 0; }
cd "$server"
docker compose stop bellteam
trap 'docker compose start bellteam' EXIT # a failed wipe must not leave the review server down; review-seen stays, the next poll retries
node "$here/apple-review-wipe.mjs" wipe "$server/runtime" > "$here/last-wipe.json"
docker compose start bellteam
health() { docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q bellteam)"; }
for _ in $(seq 60); do [ "$(health)" = healthy ] && break; sleep 2; done
[ "$(health)" = healthy ] || { echo "review server not healthy after the wipe" >&2; exit 1; }
rm "$seen"
echo "wiped (counts in $here/last-wipe.json)"
