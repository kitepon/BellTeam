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
umask 077
staging=$(mktemp -d "${TMPDIR:-/tmp}/bellteam-install.XXXXXX")
saved=
keep_saved=false
cleanup() {
  install_result=$?
  trap - 0
  rm -rf "$staging" || { [ "$install_result" -ne 0 ] || install_result=1; }
  if [ -n "$saved" ] && ! "$keep_saved"; then
    rm -rf "$saved" || { [ "$install_result" -ne 0 ] || install_result=1; }
  fi
  exit "$install_result"
}
trap cleanup 0
trap 'exit 1' 1 2 15
docker compose config --format json > "$staging/normal.raw.json"
image=$(docker compose -f "$staging/normal.raw.json" config --images)
case "$image" in ''|*[[:space:]]*) echo 'BellTeamのサーバーイメージを1つ指定してください。' >&2; exit 1;; esac
if ! "$pull" && ! docker image inspect "$image" >/dev/null; then
  echo '指定したローカルイメージがありません。先にビルドしてください。起動中のBellTeamは変更していません。' >&2
  exit 1
fi
image=$(docker image inspect --format '{{.Id}}' "$image")
BELLTEAM_SERVER_IMAGE=$image
export BELLTEAM_SERVER_IMAGE
# 2fileだけの設置でも、取得したimageと同じ更新手順を使う。ホストへ依存を入れない。
mkdir "$staging/scripts"
for path in compose.cursor-update.yaml compose.state-maintenance.json compose.state-prepare.yaml scripts/update-cursor.sh scripts/assert-state-writers-stopped.sh; do
  if ! docker run --pull never --rm --network none --read-only --entrypoint /bin/cat "$image" "/app/$path" > "$staging/$path"; then
    echo '取得したBellTeamイメージから更新手順を読み出せませんでした。起動は行っていません。' >&2
    exit 1
  fi
done
for path in compose.state-prepare.yaml compose.state-maintenance.json; do
  docker compose --project-directory "$PWD" -f "$staging/$path" \
    config --format json --no-path-resolution > "$staging/$path.raw"
done
saved=$(mktemp -d "$PWD/.bellteam-compose.XXXXXX")
# Keep label keys literal; Compose config escapes dollars in keys as well as values.
{
  printf '['; cat "$staging/normal.raw.json"
  printf ','; cat "$staging/compose.state-prepare.yaml.raw"
  printf ','; cat "$staging/compose.state-maintenance.json.raw"; printf ']'
} | docker run --pull never --rm -i --network none --read-only \
  --entrypoint /usr/local/bin/node "$image" -e '
const fs=require("node:fs"), path=require("node:path");
try {
  const models=JSON.parse(fs.readFileSync(0,"utf8").replaceAll("$$","$"));
  const [normal,prepare,maintenance]=models;
  if(typeof normal.name!=="string") throw new Error();
  const saved=process.argv[2];
  if(!path.isAbsolute(saved)||(normal.services.bellteam.volumes??[]).some(v=>{
    if(v.type!=="bind")return false;
    const source=path.resolve(v.source);
    return saved===source||saved.startsWith(source===path.sep?source:source+path.sep);
  })) throw new Error();
  normal.services.bellteam.image=process.argv[1];
  const p=prepare.services["state-prepare"], m=maintenance.services["state-maintenance"];
  const parent=p.volumes.find(v=>v.target==="/srv/bellteam-state-parent").source;
  const state=m.volumes.find(v=>v.target==="/srv/bellteam/state").source;
  if(p.image!==process.argv[1]||m.image!==process.argv[1]||!path.isAbsolute(parent)
    ||path.resolve(state)!==path.join(parent,"state")) throw new Error();
  console.log(normal.name);
  for(const model of models) console.log(JSON.stringify(model,(_key,value)=>
    typeof value==="string"?value.replaceAll("$",()=>"$$"):value));
} catch { console.error("SERVER_STATE_CONFIG_UNAVAILABLE"); process.exitCode=1; }
' "$image" "$saved" > "$staging/models.jsonl"
project=$(sed -n '1p' "$staging/models.jsonl")
case "$project" in ''|*[!a-zA-Z0-9_.-]*) echo '通常Composeのproject名を確認できません。起動中のBellTeamは変更していません。' >&2; exit 1;; esac
sed -n '2p' "$staging/models.jsonl" > "$saved/normal.json.tmp"
mv "$saved/normal.json.tmp" "$saved/normal.json"
sed -n '3p' "$staging/models.jsonl" > "$staging/compose.state-prepare.yaml"
sed -n '4p' "$staging/models.jsonl" > "$saved/compose.state-maintenance.json"
cp "$saved/compose.state-maintenance.json" "$staging/compose.state-maintenance.json"
COMPOSE_FILE="$saved/normal.json"
COMPOSE_PROJECT_NAME=$project
export COMPOSE_FILE COMPOSE_PROJECT_NAME
keep_saved=true
docker compose stop bellteam
sh "$staging/scripts/assert-state-writers-stopped.sh" --maintenance
# Maintenance must use its fixed views and entry, without normal HOME/env.
docker compose --project-directory "$PWD" -f "$staging/compose.state-prepare.yaml" \
  -p "$project" run --pull never --rm --no-deps -T state-prepare
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
