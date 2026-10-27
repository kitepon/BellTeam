#!/bin/sh
# deploy.shが本番側で呼ぶ内部adapter。受入済みの商用imageを同じdigestで使う。
set -eu
cd "$(dirname "$0")/.."
repo=$(pwd)
if [ -n "${BELLTEAM_SERVER_IMAGE:-}" ]; then
  : "${BELLTEAM_DEPLOY_QUIET_EXCEPT:?quiet対象Botを指定してください}"
fi
quiet_except=${BELLTEAM_DEPLOY_QUIET_EXCEPT:-}
export COMPOSE_FILE="$repo/distribution/server/compose.yaml:$repo/distribution/internal/compose.overlay.yaml"
export COMPOSE_PROJECT_NAME=bellteam
export BELLTEAM_INTERNAL_PROFILE_FILE="$repo/src/distribution-profile.mjs"

staging=
saved=
keep_saved=false
finish() {
  result=$?
  trap - 0
  if [ -n "$staging" ]; then rm -rf "$staging" || { [ "$result" -ne 0 ] || result=1; }; fi
  if [ -n "$saved" ] && ! "$keep_saved"; then
    rm -rf "$saved" || { [ "$result" -ne 0 ] || result=1; }
  fi
  printf 'deploy-exit=%s\n' "$result"
  exit "$result"
}
trap finish 0
trap 'exit 1' 1 2 15

# 取得・資材準備の失敗では、旧本体を止めない。
if [ -z "${BELLTEAM_SERVER_IMAGE:-}" ]; then
  COMPOSE_FILE="$repo/compose.yaml" docker compose build --pull --no-cache
  image=$(COMPOSE_FILE="$repo/compose.yaml" docker compose config --images)
  case "$image" in ''|*[[:space:]]*) echo SERVER_STATE_IMAGE_INVALID >&2; exit 1;; esac
  BELLTEAM_SERVER_IMAGE=$(docker image inspect --format '{{.Id}}' "$image")
  export BELLTEAM_SERVER_IMAGE
else
  docker compose pull bellteam
fi
umask 077
staging=$(mktemp -d "${TMPDIR:-/tmp}/bellteam-deploy-image.XXXXXX")
docker compose config --format json > "$staging/normal.raw.json"
image=$(docker compose -f "$staging/normal.raw.json" config --images)
case "$image" in ''|*[[:space:]]*) echo SERVER_STATE_IMAGE_INVALID >&2; exit 1;; esac
image=$(docker image inspect --format '{{.Id}}' "$image")
BELLTEAM_SERVER_IMAGE=$image
BELLTEAM_LEGACY_DATA="$repo/runtime/data"
export BELLTEAM_SERVER_IMAGE BELLTEAM_LEGACY_DATA
mkdir "$staging/scripts"
for path in compose.cursor-update.yaml compose.state-maintenance.json compose.state-prepare.yaml scripts/update-cursor.sh scripts/assert-state-writers-stopped.sh; do
  docker run --pull never --rm --network none --read-only --entrypoint /bin/cat \
    "$BELLTEAM_SERVER_IMAGE" "/app/$path" > "$staging/$path"
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

# 両地点の既存quietを旧本体で観測する。停止してquietを作らない。
if [ -n "$quiet_except" ]; then sh scripts/check-deploy-quiet.sh "$quiet_except"; fi
sh "$staging/scripts/update-cursor.sh"
if [ -n "$quiet_except" ]; then sh scripts/check-deploy-quiet.sh "$quiet_except"; fi
keep_saved=true
docker compose stop bellteam
sh "$staging/scripts/assert-state-writers-stopped.sh" --maintenance
docker compose --project-directory "$PWD" -f "$staging/compose.state-prepare.yaml" \
  -p "$project" run --pull never --rm --no-deps -T state-prepare
docker compose --project-directory "$PWD" -f "$staging/compose.state-maintenance.json" \
  -p "$project" run --pull never --rm --no-deps -T state-maintenance to-server
docker compose up -d --no-build --pull never
