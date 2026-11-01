#!/bin/sh
# deploy.shが本番側で呼ぶ内部adapter。受入済みの商用imageを同じdigestで使う。
set -eu
cd "$(dirname "$0")/.."
repo=$(pwd)
: "${BELLTEAM_SERVER_IMAGE:?受入imageを指定してください}"
export COMPOSE_FILE="$repo/distribution/server/compose.yaml:$repo/distribution/internal/compose.overlay.yaml"
export COMPOSE_PROJECT_NAME=bellteam
export BELLTEAM_INTERNAL_PROFILE_FILE="$repo/src/distribution-profile.mjs"

staging=
finish() {
  result=$?
  trap - 0
  if [ -n "$staging" ]; then rm -rf "$staging"; fi
  printf 'deploy-exit=%s\n' "$result"
}
trap finish 0
trap 'exit 1' 1 2 15

# 取得・資材準備の失敗では、旧本体を止めない。
docker compose pull bellteam
staging=$(mktemp -d "${TMPDIR:-/tmp}/bellteam-deploy-image.XXXXXX")
mkdir "$staging/scripts"
for path in compose.cursor-update.yaml scripts/update-cursor.sh; do
  docker run --pull never --rm --network none --read-only --entrypoint /bin/cat \
    "$BELLTEAM_SERVER_IMAGE" "/app/$path" > "$staging/$path"
done

# 静けさ待ちと復旧点は作らない（オーナー 2026-11-01「以前はぽんぽん再起動してた」）。旧imageは残るので戻せる。
sh "$staging/scripts/update-cursor.sh"
docker compose up -d --no-build --pull never
