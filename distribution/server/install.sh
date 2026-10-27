#!/bin/sh
set -eu
cd "$(dirname "$0")"
pull=true
case "$#:${1-}" in
  0:) ;;
  1:--no-pull) pull=false ;;
  *) echo '使い方: sh install.sh [--no-pull]' >&2; exit 2 ;;
esac
if "$pull"; then docker compose pull; fi
image=$(docker compose config --images)
case "$image" in ''|*[[:space:]]*) echo 'BellTeamのサーバーイメージを1つ指定してください。' >&2; exit 1;; esac
BELLTEAM_SERVER_IMAGE=$image
export BELLTEAM_SERVER_IMAGE
if ! "$pull" && ! docker image inspect "$image" >/dev/null; then
  echo '指定したローカルイメージがありません。先にビルドしてください。起動中のBellTeamは変更していません。' >&2
  exit 1
fi
# 2fileだけの設置でも、取得したimageと同じ更新手順を使う。ホストへ依存を入れない。
staging=$(mktemp -d "${TMPDIR:-/tmp}/bellteam-install.XXXXXX")
trap 'rm -rf "$staging"' 0
trap 'exit 1' 1 2 15
mkdir "$staging/scripts"
for path in compose.cursor-update.yaml compose.state-maintenance.json scripts/update-cursor.sh scripts/assert-state-writers-stopped.sh; do
  if ! docker run --pull never --rm --network none --read-only --entrypoint /bin/cat "$image" "/app/$path" > "$staging/$path"; then
    echo '取得したBellTeamイメージから更新手順を読み出せませんでした。起動は行っていません。' >&2
    exit 1
  fi
done
docker compose stop bellteam
sh "$staging/scripts/assert-state-writers-stopped.sh" --maintenance
# Maintenance must use its fixed views and entry, without normal HOME/env.
config=$(docker compose config --format yaml)
project=$(printf '%s' "$config" | awk '/^name: / { print $2; exit }')
unset config
case "$project" in ''|*[!a-zA-Z0-9_.-]*) echo '通常Composeのproject名を確認できません。BellTeamは停止したままです。' >&2; exit 1;; esac
docker compose --project-directory "$PWD" -f "$staging/compose.state-maintenance.json" \
  -p "$project" run --pull never --rm --no-deps -T state-maintenance to-server
if sh "$staging/scripts/update-cursor.sh"; then
  :
else
  result=$?
  echo 'Cursorの更新に失敗しました。BellTeamは停止したままです。表示されたエラーを確認してください。' >&2
  exit "$result"
fi
docker compose up -d --wait --wait-timeout 120 --pull never

endpoint=$(docker compose port bellteam 4180)
case "$endpoint" in
  0.0.0.0:*|\[::\]:*) url="http://localhost:18891" ;;
  *) url="http://$endpoint" ;;
esac
printf '\nBellTeamを起動しました。ブラウザで %s を開いてください。\n' "$url"
printf 'iPhone・iPadからは、このマシンのLANアドレスの18891番へ接続できます。\n'
printf '最初に使うAIを選び、公式サイトで認証すると、案内役との会話が始まります。\n'
