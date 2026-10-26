#!/bin/sh
# ビルド後、入れ替え前に1回だけ実行。認証値をconfigから取り出さない。
set -eu
updater_compose="$(CDPATH= cd "$(dirname "$0")/.." && pwd)/compose.cursor-update.yaml"
BELLTEAM_CURSOR_UPDATE_IMAGE=$(docker compose config --images)
# Composeが正規化したproject/volume名だけを読む。設置先にNode/Pythonを要求しない。
info=$(docker compose config --format yaml | awk '
  /^name: / { project=$2 }
  /^volumes:$/ { volumes=1; next }
  volumes && /^  cursor-cli:$/ { cursor=1; next }
  cursor && /^    name: / { volume=$2; cursor=0 }
  END { if (!project || !volume) exit 1; print volume; print project }
')
BELLTEAM_CURSOR_VOLUME=$(printf '%s\n' "$info" | sed -n '1p')
project=$(printf '%s\n' "$info" | sed -n '2p')
case "$BELLTEAM_CURSOR_UPDATE_IMAGE" in ''|*[[:space:]]*) echo 'expected one server image' >&2; exit 1;; esac
case "$BELLTEAM_CURSOR_VOLUME:$project" in *[!a-zA-Z0-9_.:-]*) echo 'unexpected Compose volume/project name' >&2; exit 1;; esac
export BELLTEAM_CURSOR_UPDATE_IMAGE BELLTEAM_CURSOR_VOLUME
# 初回も本体と同じvolume名を作る。中身はimageからDockerが初期化する。
docker volume inspect "$BELLTEAM_CURSOR_VOLUME" >/dev/null 2>&1 || \
  docker volume create --label "com.docker.compose.project=$project" \
    --label com.docker.compose.volume=cursor-cli "$BELLTEAM_CURSOR_VOLUME" >/dev/null
docker compose -f "$updater_compose" run --rm --no-deps cursor-update
