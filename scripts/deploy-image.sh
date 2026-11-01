#!/bin/sh
# deploy.shが本番側で呼ぶ内部adapter。受入済みの商用imageを同じdigestで使う。
set -eu
cd "$(dirname "$0")/.."
repo=$(pwd)
[ "$(/usr/bin/id -u):$(/usr/bin/id -g)" = 0:0 ] || { echo SEC014_INTERNAL_ROOT_REQUIRED >&2; exit 1; } # sec014-root-entry
selected_image=${BELLTEAM_SERVER_IMAGE:-}
if [ -n "${BELLTEAM_SERVER_IMAGE:-}" ]; then
  : "${BELLTEAM_DEPLOY_QUIET_EXCEPT:?quiet対象Botを指定してください}"
fi
quiet_except=${BELLTEAM_DEPLOY_QUIET_EXCEPT:-}
export COMPOSE_FILE="$repo/distribution/server/compose.yaml:$repo/distribution/internal/compose.overlay.yaml"
export COMPOSE_PROJECT_NAME=bellteam
export BELLTEAM_INTERNAL_PROFILE_FILE="$repo/src/distribution-profile.mjs"
BELLTEAM_NORMAL_ADMISSION_TOKEN=$(node --input-type=module -e 'import { randomBytes } from "node:crypto"; console.log(randomBytes(32).toString("hex"))')
export BELLTEAM_NORMAL_ADMISSION_TOKEN

staging=
saved=
keep_saved=false
docker_config=
finish() {
  result=$?
  if [ -n "$docker_config" ]; then rm -rf "$docker_config" || { [ "$result" -ne 0 ] || result=1; }; fi
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

# sec014-actor-bootstrap-start
sec014_actor() {
  /usr/bin/python3 -I -B - "$repo" "$saved/normal.json" "${stopped_container-}" "$1" <<'PYACTOR'
import importlib.util,json,os,shutil,stat,sys
from pathlib import Path
if any(value != 0 for value in (os.getuid(),os.geteuid(),os.getgid(),os.getegid())):
    raise RuntimeError('SEC014_INTERNAL_ROOT_REQUIRED')
root,normal,stopped,step=Path(sys.argv[1]),Path(sys.argv[2]),sys.argv[3],sys.argv[4]
files=['scripts/deploy-image.sh','scripts/check-deploy-quiet.sh','scripts/check-deploy-quiet.mjs',
       'distribution/internal/sec014-host-actor.py',
       'distribution/internal/sec014-host-control.py','distribution/internal/sec014-prepared-proof.py',
       'distribution/internal/sec014-prepare-executor.py','distribution/internal/sec014-writer-collector.py',
       'distribution/internal/sec014-writer-snapshot.mjs','src/server-state-writers.mjs',
       'compose.state-prepare.yaml','compose.state-maintenance.json']
node=shutil.which('node',path='/usr/local/bin:/usr/bin:/bin')
plugins=[Path(directory)/'docker-compose' for directory in ('/usr/local/lib/docker/cli-plugins','/usr/local/libexec/docker/cli-plugins','/usr/lib/docker/cli-plugins','/usr/libexec/docker/cli-plugins') if (Path(directory)/'docker-compose').exists()]
if not node or not plugins:
    raise RuntimeError('SEC014_INTERNAL_TRUST_NOT_INSTALLED')
paths=[*(root/name for name in files),normal,normal.parent/'compose.state-prepare.yaml',normal.parent/'compose.state-maintenance.json',
       Path('/usr/bin/docker').resolve(),Path(sys.executable).resolve(),Path(node).resolve(),*(path.resolve() for path in plugins)]
for path in paths:
    if path.resolve(strict=True) != path:
        raise RuntimeError('SEC014_INTERNAL_TRUST_NOT_INSTALLED')
    if not stat.S_ISREG(path.stat().st_mode):
        raise RuntimeError('SEC014_INTERNAL_TRUST_NOT_INSTALLED')
    for current in (path,*path.parents):
        info=current.stat()
        # The fixed management HOME is outside ordinary seat mounts (staged_a).
        management_parent=current == root.parent and current == Path('/home/kite') and info.st_uid == 1000
        if (info.st_uid != 0 and not management_parent) or info.st_mode & 0o022:
            raise RuntimeError('SEC014_INTERNAL_TRUST_NOT_INSTALLED')
spec=importlib.util.spec_from_file_location('sec014_internal_actor',root/'distribution/internal/sec014-host-actor.py')
a=importlib.util.module_from_spec(spec);spec.loader.exec_module(a)
selected=a.control._normal(normal)
if selected['owner'] != [0,0]:
    raise RuntimeError('SEC014_INTERNAL_TRUST_NOT_INSTALLED')
if step=='run':
    image=selected.get('imageRef',selected['image'])
    result=a.run_actor('to-server',image,lambda tx:a._InternalForward(tx,stopped),saved_normal=normal)
    print(json.dumps(result))
elif step!='preflight':
    raise RuntimeError('SEC014_INTERNAL_STEP')
PYACTOR
}
# sec014-actor-bootstrap-end

# 旧本体の実imageを控える。失敗・途中保存では更新を始めず、原本を残す。
umask 077
docker_config=$(mktemp -d "$PWD/.bellteam-docker.XXXXXX")
DOCKER_HOST=unix:///var/run/docker.sock
DOCKER_CONFIG=$docker_config
export DOCKER_HOST DOCKER_CONFIG
mkdir -p runtime/backups
previous=$(mktemp -d runtime/backups/image-before-deploy.XXXXXX)
docker container inspect --format '{{.Id}} {{.Image}}' bellteam > "$previous/container-image.txt"
read -r previous_container previous_image < "$previous/container-image.txt"
if [ -n "${BELLTEAM_PREVIOUS_COMPOSE:-}" ]; then
  docker container inspect --format '{{.State.StartedAt}}' "$previous_container" > "$previous/container-started-at.txt"
  node --input-type=module - "$BELLTEAM_PREVIOUS_COMPOSE" "$previous" <<'NODE'
import fs from 'node:fs'
import path from 'node:path'
try {
  const [normalFile,archive]=process.argv.slice(2), generation=path.dirname(normalFile)
  if(path.dirname(generation)!==process.cwd()||!/^\.bellteam-compose\.[a-zA-Z0-9]{6}$/.test(path.basename(generation))
    ||path.basename(normalFile)!=='previous-normal.json')throw new Error()
  const dir=fs.lstatSync(generation)
  if(!dir.isDirectory()||dir.uid!==process.getuid()||(dir.mode&0o777)!==0o700)throw new Error()
  for(const file of ['previous-normal.json','previous-runtime.json']){
    const st=fs.lstatSync(path.join(generation,file))
    if(!st.isFile()||st.uid!==process.getuid()||(st.mode&0o777)!==0o600)throw new Error()
  }
  const runtime=JSON.parse(fs.readFileSync(path.join(generation,'previous-runtime.json'),'utf8'))
  const normal=JSON.parse(fs.readFileSync(normalFile,'utf8').replaceAll('$$','$'))
  const [cid,image]=fs.readFileSync(path.join(archive,'container-image.txt'),'utf8').trim().split(' ')
  if(runtime.Id!==cid||runtime.Image!==image||runtime.State.StartedAt!==fs.readFileSync(path.join(archive,'container-started-at.txt'),'utf8').trim()
    ||normal.services.bellteam.image!==image)throw new Error()
  fs.writeFileSync(path.join(archive,'previous-compose.path'),normalFile+'\n',{mode:0o600,flag:'wx'})
}catch{console.error('BELLTEAM_PREVIOUS_CONFIG_CHANGED');process.exitCode=1}
NODE
fi
docker image save --output "$previous/image.tar" "$previous_image"
sha256sum "$previous/image.tar" > "$previous/image.tar.sha256"
printf 'previous-image=%s\n' "$previous"

# 内部overlayと同じvolumeの全fileを、同じ旧CIDから読む。
docker container inspect --format '{{range .Mounts}}{{if eq .Destination "/home/bell/.local"}}{{.Type}} {{.Name}}{{end}}{{end}}' "$previous_container" > "$previous/cursor-volume.txt"
[ "$(cat "$previous/cursor-volume.txt")" = 'volume bellteam_cursor-cli' ] || { echo 'Cursor volumeを確認できません。更新は開始していません。' >&2; exit 1; }
docker exec --user bell "$previous_container" /bin/tar --numeric-owner -C /home/bell/.local -cf - . > "$previous/cursor.tar"
sha256sum "$previous/cursor.tar" > "$previous/cursor.tar.sha256"

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
  const service=normal.services.bellteam, token=process.argv[3];
  const control=service.volumes.filter(v=>v.target==="/run/bellteam-maintenance");
  if(!/^[a-f0-9]{64}$/.test(token)||service.environment?.BELLTEAM_NORMAL_ADMISSION_TOKEN!==token
    ||control.length!==1||control[0].type!=="bind"
    ||control[0].source!=="/home/kite/BellTeam/runtime/server-only/maintenance-control"
    ||control[0].read_only!==true||control[0].bind?.create_host_path!==false) throw new Error();
  const p=prepare.services["state-prepare"], m=maintenance.services["state-maintenance"];
  const parent=p.volumes.find(v=>v.target==="/srv/bellteam-state-parent").source;
  const state=m.volumes.find(v=>v.target==="/srv/bellteam/state").source;
  if(p.image!==process.argv[1]||m.image!==process.argv[1]||!path.isAbsolute(parent)
    ||path.resolve(state)!==path.join(parent,"state")) throw new Error();
  if(process.argv[4].includes("@sha256:")) {
    for(const model of [normal,prepare]) model["x-bellteam-image-ref"]=process.argv[4];
  }
  console.log(normal.name);
  for(const model of models) console.log(JSON.stringify(model,(_key,value)=>
    typeof value==="string"?value.replaceAll("$",()=>"$$"):value));
} catch { console.error("SERVER_STATE_CONFIG_UNAVAILABLE"); process.exitCode=1; }
' "$image" "$saved" "$BELLTEAM_NORMAL_ADMISSION_TOKEN" "$selected_image" > "$staging/models.jsonl"
project=$(sed -n '1p' "$staging/models.jsonl")
case "$project" in ''|*[!a-zA-Z0-9_.-]*) echo '通常Composeのproject名を確認できません。起動中のBellTeamは変更していません。' >&2; exit 1;; esac
sed -n '2p' "$staging/models.jsonl" > "$saved/normal.json.tmp"
mv "$saved/normal.json.tmp" "$saved/normal.json"
sed -n '3p' "$staging/models.jsonl" > "$saved/compose.state-prepare.yaml"
sed -n '4p' "$staging/models.jsonl" > "$saved/compose.state-maintenance.json"
# The existing checker resolves maintenance relative to its own parent.
mkdir "$saved/scripts"
mv "$staging/scripts/assert-state-writers-stopped.sh" "$saved/scripts/"
if [ -n "${BELLTEAM_PREVIOUS_COMPOSE:-}" ]; then
  node --input-type=module - "$saved" "$previous" "$BELLTEAM_PREVIOUS_COMPOSE" <<'NODE'
import fs from 'node:fs'
import path from 'node:path'
import { stateWriterPlan } from './src/server-state-writers.mjs'
try {
  const [saved,archive,previousCompose]=process.argv.slice(2)
  const read=file=>JSON.parse(fs.readFileSync(file,'utf8').replaceAll('$$','$'))
  const normal=read(path.join(saved,'normal.json')), maintenance=read(path.join(saved,'compose.state-maintenance.json'))
  const original=read(previousCompose), old=original.services.bellteam, current=normal.services.bellteam
  const combined=model=>({...model,services:{...model.services,...maintenance.services}})
  const targetPlan=stateWriterPlan(combined(normal)), oldPlan=stateWriterPlan(combined(original))
  const home=service=>path.resolve(service.volumes.find(v=>v.target==='/home/bell').source)
  if(original.name!==normal.name||oldPlan.volume!==targetPlan.volume||home(old)!==home(current)
    ||fs.readFileSync(path.join(archive,'previous-compose.path'),'utf8')!==previousCompose+'\n'
    ||old.image!==fs.readFileSync(path.join(archive,'container-image.txt'),'utf8').trim().split(' ')[1])throw new Error()
  const stateTargets=maintenance.services['state-maintenance'].volumes.map(v=>v.target)
    .filter(target=>!['/srv/bellteam','/srv/bellteam-legacy','/srv/bellteam-maintenance-backups'].includes(target))
  for(const service of [old,current]) if(service.volumes.some(v=>v.target!==path.posix.resolve(v.target)||v.target!=='/srv/bellteam'&&!stateTargets.includes(v.target)&&stateTargets.some(target=>
    v.target==='/'||v.target.startsWith(target+'/')||target.startsWith(v.target+'/'))))throw new Error()
  const stateLayout=old.volumes.some(v=>stateTargets.includes(v.target))?'server':'legacy'
  fs.writeFileSync(path.join(saved,'recovery.json.tmp'),JSON.stringify({previousCompose,
    previousImageArchive:path.resolve(archive),stateLayout}),{mode:0o600,flag:'wx'})
  fs.renameSync(path.join(saved,'recovery.json.tmp'),path.join(saved,'recovery.json'))
}catch{console.error('BELLTEAM_RECOVERY_PAIR_UNAVAILABLE');process.exitCode=1}
NODE
fi
COMPOSE_FILE="$saved/normal.json"
COMPOSE_PROJECT_NAME=$project
export COMPOSE_FILE COMPOSE_PROJECT_NAME

# Validate the root entry and frozen generation before Cursor or the old normal changes.
sec014_actor preflight

# 両地点の既存quietを旧本体で観測する。停止してquietを作らない。
if [ -n "$quiet_except" ]; then sh scripts/check-deploy-quiet.sh "$quiet_except"; fi
sh "$staging/scripts/update-cursor.sh"
if [ -n "$quiet_except" ]; then sh scripts/check-deploy-quiet.sh "$quiet_except"; fi
stopped_container=$(docker compose ps --all --quiet --no-trunc bellteam)
case "$stopped_container" in *[!a-f0-9]*) echo SERVER_STATE_CONTAINER_ID_INVALID >&2; exit 1;; esac
[ -z "$stopped_container" ] || [ "${#stopped_container}" -eq 64 ] || { echo SERVER_STATE_CONTAINER_ID_INVALID >&2; exit 1; }
keep_saved=true
printf 'saved-compose=%s\n' "$saved"
# Stop the captured container even if another caller changes the service alias.
if [ -n "$stopped_container" ]; then docker stop "$stopped_container"; fi
sec014_actor run
