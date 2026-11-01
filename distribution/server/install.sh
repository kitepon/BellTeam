#!/bin/sh
set -eu
cd "${BELLTEAM_INSTALL_DIR:-$(dirname "$0")}"
pull=true
recovery=false
saved=
case "$#:${1-}" in
  0:) ;;
  1:--no-pull) pull=false ;;
  2:--recover) recovery=true; pull=false; saved=$(CDPATH= cd "$2" && pwd) ;;
  *) echo '使い方: sh install.sh [--no-pull] | --recover <保存世代>' >&2; exit 2 ;;
esac
umask 077
staging=$(mktemp -d "${TMPDIR:-/tmp}/bellteam-install.XXXXXX")
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
if "$recovery"; then
  # Recovery never synthesizes an old model from the current template.
  keep_saved=true
  [ "$(dirname "$saved")" = "$PWD" ] && [ -f "$saved/previous-normal.json" ] || {
    echo SERVER_STATE_PREVIOUS_MODEL_UNVERIFIED >&2; exit 1;
  }
  COMPOSE_FILE="$saved/normal.json"
  export COMPOSE_FILE
fi
if "$pull"; then docker compose pull; fi
docker compose config --format json > "$staging/normal.raw.json"
image=$(docker compose -f "$staging/normal.raw.json" config --images)
case "$image" in ''|*[[:space:]]*) echo SERVER_STATE_IMAGE_INVALID >&2; exit 1;; esac
selected_image=$image
if ! "$pull" && ! docker image inspect "$image" >/dev/null; then
  echo '指定したローカルイメージがありません。先にビルドしてください。起動中のBellTeamは変更していません。' >&2
  exit 1
fi
image=$(docker image inspect --format '{{.Id}}' "$image")
case "$image" in sha256:*) ;; *) echo SERVER_STATE_IMAGE_INVALID >&2; exit 1;; esac
BELLTEAM_SERVER_IMAGE=$image
export BELLTEAM_SERVER_IMAGE
mkdir "$staging/scripts"
for path in compose.cursor-update.yaml compose.state-maintenance.json scripts/update-cursor.sh scripts/assert-state-writers-stopped.sh; do
  docker run --pull never --rm --network none --read-only --entrypoint /bin/cat "$image" "/app/$path" > "$staging/$path"
done
if ! "$recovery"; then
  saved=$(mktemp -d "$PWD/.bellteam-compose.XXXXXX")
  docker compose --project-directory "$PWD" -f "$staging/compose.state-maintenance.json" \
    config --format json > "$staging/maintenance.raw.json"
  {
    printf '['; cat "$staging/normal.raw.json"; printf ','; cat "$staging/maintenance.raw.json"; printf ']'
  } | docker run --pull never --rm -i --network none --read-only --entrypoint /usr/local/bin/node "$image" -e '
const fs=require("node:fs"),path=require("node:path");
try {
  const [normal,maintenance]=JSON.parse(fs.readFileSync(0,"utf8").replaceAll("$$","$"));
  const [image,saved,selected]=process.argv.slice(1),service=normal.services.bellteam;
  if(typeof normal.name!=="string"||!path.isAbsolute(saved))throw Error();
  const bind=target=>{const m=service.volumes.filter(v=>v.target===target);if(m.length!==1||m[0].type!=="bind"||m[0].read_only)throw Error();return path.resolve(m[0].source)};
  const data=bind("/srv/bellteam"),home=bind("/home/bell"),runtime=path.dirname(data);
  if(data!==path.join(runtime,"data")||home!==path.join(runtime,"home")||service.volumes.some(v=>
    v.type==="bind"&&(saved===path.resolve(v.source)||saved.startsWith(path.resolve(v.source)+path.sep))))throw Error();
  const privateRoot=path.join(runtime,"server-only/state-data");
  for(const name of ["state","rooms","owner","logs","shared/tools/bellteam-settings","shared/tools/apns"])
    if(bind("/srv/bellteam/"+name)!==path.join(privateRoot,name.split("/").at(-1)))throw Error();
  const control=service.volumes.filter(v=>v.target==="/run/bellteam-maintenance");
  if(control.length!==1||control[0].type!=="bind"||!control[0].read_only||control[0].source!==privateRoot)throw Error();
  service.image=image;
  const m=maintenance.services["state-maintenance"];
  if(m.volumes.length!==1||m.volumes[0].target!=="/srv/bellteam-runtime")throw Error();
  m.image=image;m.volumes[0].source=runtime;
  if(selected.includes("@sha256:"))normal["x-bellteam-image-ref"]=selected;
  console.log(normal.name);
  for(const model of [normal,maintenance])console.log(JSON.stringify(model,(_k,v)=>typeof v==="string"?v.replaceAll("$",()=>"$$"):v));
}catch{console.error("SERVER_STATE_CONFIG_UNAVAILABLE");process.exitCode=1}
' "$image" "$saved" "$selected_image" > "$staging/models.jsonl"
  sed -n '2p' "$staging/models.jsonl" > "$saved/normal.json"
  sed -n '3p' "$staging/models.jsonl" > "$saved/compose.state-maintenance.json"
fi
cp "$saved/compose.state-maintenance.json" "$staging/compose.state-maintenance.json"
COMPOSE_FILE="$saved/normal.json"
export COMPOSE_FILE
project=$(docker compose config --format json | docker run --pull never --rm -i --network none --read-only \
  --entrypoint /usr/local/bin/node "$image" -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(d.name)')
case "$project" in ''|*[!a-zA-Z0-9_.-]*) echo SERVER_STATE_PROJECT_INVALID >&2; exit 1;; esac
COMPOSE_PROJECT_NAME=$project
export COMPOSE_PROJECT_NAME
stopped_container=$(docker compose ps --all --quiet --no-trunc bellteam)
case "$stopped_container" in *[!a-f0-9]*) echo SERVER_STATE_CONTAINER_ID_INVALID >&2; exit 1;; esac
[ -z "$stopped_container" ] || [ "${#stopped_container}" -eq 64 ] || { echo SERVER_STATE_CONTAINER_ID_INVALID >&2; exit 1; }

capture_previous() {
  docker container inspect "$stopped_container" > "$saved/previous-runtime.json" || return 1
  if [ -n "${BELLTEAM_PREVIOUS_COMPOSE:-}" ]; then
    # Internal deploy captures the original model/profile before updating checkout.
    previous_dir=$(dirname "$BELLTEAM_PREVIOUS_COMPOSE")
    cp "$BELLTEAM_PREVIOUS_COMPOSE" "$saved/previous-normal.json" || return 1
    cp "$previous_dir/previous-runtime.json" "$saved/previous-runtime.json" || return 1
    return
  fi
  old_image=$(docker container inspect --format '{{.Image}}' "$stopped_container") || return 1
  old_ref=$(docker container inspect --format '{{.Config.Image}}' "$stopped_container") || return 1
  old_files=$(docker container inspect --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$stopped_container") || return 1
  old_working=$(docker container inspect --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$stopped_container") || return 1
  old_project=$(docker container inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$stopped_container") || return 1
  old_hash=$(docker container inspect --format '{{index .Config.Labels "com.docker.compose.config-hash"}}' "$stopped_container") || return 1
  old_env=$(docker container inspect --format '{{index .Config.Labels "com.docker.compose.project.environment_file"}}' "$stopped_container") || return 1
  [ "$old_project" = "$project" ] || return 1
  case "$old_files" in
    "$PWD/compose.yaml")
      [ "$old_working" = "$PWD" ] || return 1
      docker run --pull never --rm --network none --read-only --entrypoint /bin/cat "$old_image" /app/compose.yaml > "$saved/previous-compose.yaml" || return 1
      old_files="$saved/previous-compose.yaml";;
    "$PWD"/.bellteam-compose.*/normal.json|"$PWD"/.bellteam-compose.*/previous-normal.json)
      [ -f "$old_files" ] && [ "$(dirname "$(dirname "$old_files")")" = "$PWD" ] || return 1
      [ "$old_working" = "$PWD" ] || [ "$old_working" = "$(dirname "$old_files")" ] || return 1;;
    *) return 1;;
  esac
  case "$old_env" in ''|'<no value>') old_env="$PWD/.env"; [ -f "$old_env" ] || old_env=/dev/null;; esac
  BELLTEAM_SERVER_IMAGE="$old_ref" docker compose --project-directory "$old_working" -p "$old_project" \
    --env-file "$old_env" -f "$old_files" config --format json > "$saved/previous-model.json" || return 1
  hash=$(docker compose -p "$project" -f "$saved/previous-model.json" config --hash bellteam) || return 1
  [ "$hash" = "bellteam $old_hash" ] || return 1
  profile=$(docker container inspect --format '{{range .Mounts}}{{if eq .Destination "/app/src/distribution-profile.mjs"}}{{.Type}} {{.RW}}{{end}}{{end}}' "$stopped_container") || return 1
  if [ -n "$profile" ]; then
    [ "$profile" = 'bind false' ] || return 1
    docker exec "$stopped_container" /bin/cat /app/src/distribution-profile.mjs > "$saved/previous-profile.mjs" || return 1
    chmod 644 "$saved/previous-profile.mjs" || return 1
  fi
  {
    printf '['; cat "$saved/previous-runtime.json"; printf ','; cat "$saved/previous-model.json"; printf ']'
  } | docker run --pull never --rm -i --network none --read-only --entrypoint /usr/local/bin/node "$image" -e '
const fs=require("node:fs");
try {
 const [runtimeRaw,modelRaw]=JSON.parse(fs.readFileSync(0,"utf8"));
 const runtime=runtimeRaw[0],model=JSON.parse(JSON.stringify(modelRaw).replaceAll("$$","$"));
 const [saved,selected]=process.argv.slice(1),service=model.services.bellteam;
 if(service.image!==runtime.Config.Image||!/^sha256:[a-f0-9]{64}$/.test(runtime.Image))throw Error();
 const profile=runtime.Mounts.find(v=>v.Destination==="/app/src/distribution-profile.mjs");
 if(profile){const bind=service.volumes.find(v=>v.target===profile.Destination);
   if(bind?.type!=="bind"||!bind.read_only||bind.source!==profile.Source||profile.RW)throw Error();
   bind.source=saved+"/previous-profile.mjs";}
 service.image=runtime.Image;
 console.log(JSON.stringify(model,(_k,v)=>typeof v==="string"?v.replaceAll("$",()=>"$$"):v));
}catch{console.error("SERVER_STATE_PREVIOUS_MODEL_UNVERIFIED");process.exitCode=1}
' "$saved" "$old_image" > "$saved/previous-normal.json.tmp" || return 1
  mv "$saved/previous-normal.json.tmp" "$saved/previous-normal.json" || return 1
}
if ! "$recovery" && [ -n "$stopped_container" ]; then
  if capture_previous; then :; else
    rm -f "$saved/previous-normal.json"
    echo '旧設定を証明できません。原本を保存しました。この世代からの自動復旧は使えません。' >&2
  fi
fi

direction=to-server
if "$recovery"; then
  direction=$(cat "$saved/previous-normal.json" | docker run --pull never --rm -i --network none --read-only \
    --entrypoint /usr/local/bin/node "$image" -e '
try{const d=JSON.parse(require("fs").readFileSync(0,"utf8").replaceAll("$$","$"));
 console.log(d.services.bellteam.volumes.some(v=>v.target==="/srv/bellteam/state")?"to-server":"to-legacy")
}catch{process.exitCode=1}')
  # Confirm both pinned generations are present before stopping or changing data.
  old_image=$(docker compose -f "$saved/previous-normal.json" config --images)
  docker image inspect "$old_image" >/dev/null
fi
if [ -n "$stopped_container" ]; then
  docker container inspect "$stopped_container" > "$staging/current-runtime.json"
  if [ -f "$saved/previous-normal.json" ]; then
    {
      printf '['; cat "$saved/normal.json"; printf ','; cat "$saved/previous-normal.json";
      printf ','; cat "$saved/previous-runtime.json"; printf ','; cat "$staging/current-runtime.json"; printf ']'
    } | docker run --pull never --rm -i --network none --read-only --entrypoint /usr/local/bin/node "$image" -e '
const fs=require("node:fs");
try{
 const [normalRaw,oldRaw,originalRaw,currentRaw]=JSON.parse(fs.readFileSync(0,"utf8"));
 const normal=JSON.parse(JSON.stringify(normalRaw).replaceAll("$$","$")),old=JSON.parse(JSON.stringify(oldRaw).replaceAll("$$","$"));
 const original=Array.isArray(originalRaw)?originalRaw[0]:originalRaw,current=currentRaw[0],saved=process.argv[1];
 const a=normal.services.bellteam,b=old.services.bellteam;
 const bind=(s,t)=>{const m=s.volumes.filter(v=>v.target===t);if(m.length!==1)return null;return m[0]};
 for(const t of ["/home/bell","/srv/bellteam"]){const x=bind(a,t),y=bind(b,t);
  if(x?.type!=="bind"||y?.type!=="bind"||x.source!==y.source)throw Error();}
 const cursor=(m,s)=>{const x=bind(s,"/home/bell/.local");if(x?.type!=="volume")throw Error();return m.volumes[x.source].name};
 if(cursor(normal,a)!==cursor(old,b)||old.name!==normal.name||b.image!==original.Image)throw Error();
 const labels=current.Config.Labels??{},sameOriginal=current.Id===original.Id&&current.Image===original.Image
   &&current.State.StartedAt===original.State.StartedAt;
 if(labels["com.docker.compose.project"]!==normal.name||labels["com.docker.compose.service"]!=="bellteam"
   ||!sameOriginal&&!(current.Image===a.image&&labels["com.docker.compose.project.config_files"]===saved+"/normal.json"))throw Error();
}catch{console.error("SERVER_STATE_GENERATION_CHANGED");process.exitCode=1}
' "$saved"
  fi
fi

keep_saved=true
printf 'saved-compose=%s\n' "$saved"
if [ -n "$stopped_container" ]; then
  docker stop "$stopped_container"
  state=$(docker container inspect --format '{{.State.Running}} {{.State.Restarting}}' "$stopped_container")
  [ "$state" = 'false false' ] || { echo SERVER_STATE_STOP_UNCONFIRMED >&2; exit 1; }
  if "$recovery" && [ "$direction" = to-legacy ]; then
    docker update --restart no "$stopped_container"
    docker rm "$stopped_container"
    stopped_container=
  fi
fi
BELLTEAM_STOPPED_CONTAINER_ID=$stopped_container sh "$staging/scripts/assert-state-writers-stopped.sh" --maintenance
maintenance() {
  docker compose --project-directory "$PWD" -f "$saved/compose.state-maintenance.json" \
    -p "$project" run --pull never --rm --no-deps -T state-maintenance "$1"
}
maintenance prepare
maintenance "$direction"
if "$recovery"; then
  COMPOSE_FILE="$saved/previous-normal.json"
  export COMPOSE_FILE
else
  if sh "$staging/scripts/update-cursor.sh"; then :; else
    result=$?
    echo 'Cursorの更新に失敗しました。BellTeamは停止したままです。表示されたエラーを確認してください。' >&2
    exit "$result"
  fi
fi
docker compose --project-directory "$PWD" up -d --wait --wait-timeout 120 --pull never
endpoint=$(docker compose port bellteam 4180)
case "$endpoint" in
  0.0.0.0:*|\[::\]:*) url="http://localhost:18891" ;;
  *) url="http://$endpoint" ;;
esac
printf '\nBellTeamを起動しました。ブラウザで %s を開いてください。\n' "$url"
printf 'iPhone・iPadからは、このマシンのLANアドレスの18891番へ接続できます。\n'
printf '最初に使うAIを選び、公式サイトで認証すると、案内役との会話が始まります。\n'
printf '保存設定: %s\n' "$saved"
