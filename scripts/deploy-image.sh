#!/bin/sh
# deploy.shが本番側で呼ぶ内部adapter。受入済みの商用imageを同じdigestで使う。
set -eu
cd "$(dirname "$0")/.."
repo=$(pwd)
: "${BELLTEAM_SERVER_IMAGE:?受入imageを指定してください}"
: "${BELLTEAM_DEPLOY_QUIET_EXCEPT:?quiet対象Botを指定してください}"
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

# 旧本体の実imageを控える。失敗・途中保存では更新を始めず、原本を残す。
umask 077
mkdir -p runtime/backups
previous=$(mktemp -d runtime/backups/image-before-deploy.XXXXXX)
docker container inspect --format '{{.Id}} {{.Image}}' bellteam > "$previous/container-image.txt"
read -r previous_container previous_image < "$previous/container-image.txt"
docker image save --output "$previous/image.tar" "$previous_image"
sha256sum "$previous/image.tar" > "$previous/image.tar.sha256"
printf 'previous-image=%s\n' "$previous"

# 内部overlayと同じvolumeの全fileを、同じ旧CIDから読む。
docker container inspect --format '{{range .Mounts}}{{if eq .Destination "/home/bell/.local"}}{{.Type}} {{.Name}}{{end}}{{end}}' "$previous_container" > "$previous/cursor-volume.txt"
[ "$(cat "$previous/cursor-volume.txt")" = 'volume bellteam_cursor-cli' ] || { echo 'Cursor volumeを確認できません。更新は開始していません。' >&2; exit 1; }
docker exec --user bell "$previous_container" /bin/tar --numeric-owner -C /home/bell/.local -cf - . > "$previous/cursor.tar"
sha256sum "$previous/cursor.tar" > "$previous/cursor.tar.sha256"

# 取得・資材準備の失敗では、旧本体を止めない。
docker compose pull bellteam
staging=$(mktemp -d "${TMPDIR:-/tmp}/bellteam-deploy-image.XXXXXX")
mkdir "$staging/scripts"
for path in compose.cursor-update.yaml scripts/update-cursor.sh; do
  docker run --pull never --rm --network none --read-only --entrypoint /bin/cat \
    "$BELLTEAM_SERVER_IMAGE" "/app/$path" > "$staging/$path"
done

# 両地点の既存quietを旧本体で観測する。停止してquietを作らない。
sh scripts/check-deploy-quiet.sh "$BELLTEAM_DEPLOY_QUIET_EXCEPT"
sh "$staging/scripts/update-cursor.sh"
sh scripts/check-deploy-quiet.sh "$BELLTEAM_DEPLOY_QUIET_EXCEPT"
docker compose up -d --no-build --pull never
