#!/bin/sh
# 本番反映の正規入口。GitHubのmainを取り込み、受入imageまたは新規buildを反映する。
# usage: scripts/deploy.sh
# 商用image: BELLTEAM_DEPLOY_IMAGE=repo@sha256:digest sh scripts/deploy.sh
set -eu
cd "$(dirname "$0")/.."
host=main-server
dir=/home/kite/BellTeam
image=${BELLTEAM_DEPLOY_IMAGE:-}
if [ -n "$image" ]; then
  case "$image" in *@sha256:*) ;; *) echo '受入imageをrepo@sha256:digestで指定してください。' >&2; exit 2;; esac
  digest=${image##*@sha256:}
  repository=${image%@sha256:*}
  case "$image" in *[!a-zA-Z0-9._:/@-]*) echo '受入imageの指定が不正です。' >&2; exit 2;; esac
  case "$digest" in ''|*[!a-f0-9]*) echo 'image digestが不正です。' >&2; exit 2;; esac
  if [ ${#digest} -ne 64 ] || [ -z "$repository" ]; then
    echo '受入imageの完全なdigestを指定してください。' >&2
    exit 2
  fi
fi

# 反映するのはcommit済みの内容だけ。本番でcommitを作らないので、履歴はGitHubのmainと常に一致する。
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo '未commitの変更がある。commitしてから反映する。' >&2
  exit 1
fi
git push -q origin HEAD:main
head="$(git rev-parse HEAD)"

# 本番の作業ツリーに手直しがあれば取り込まずに止める（本番のBot台帳config/bots.jsonを含む）。
previous=$(ssh "$host" "cd $dir && sudo -n /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/root LANG=C.UTF-8 GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0=$dir /bin/sh -s $head" <<'REMOTE'
set -eu
umask 077
docker_config=$(mktemp -d "$PWD/.bellteam-docker.XXXXXX")
trap 'rm -rf "$docker_config"' 0
DOCKER_HOST=unix:///var/run/docker.sock
DOCKER_CONFIG=$docker_config
export DOCKER_HOST DOCKER_CONFIG
git fetch -q origin
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  git status -s --untracked-files=no >&2
  echo '本番に未commitの変更がある。GitHubへ取り込んでから反映する。' >&2
  exit 1
fi
previous=$(node --input-type=module <<'NODE'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
const repo=process.cwd(), docker=(args,options={})=>execFileSync('docker',args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],...options})
const inspect=()=>JSON.parse(docker(['container','inspect','--format','{{json .}}','bellteam']))
const serialize=model=>JSON.stringify(model,(_key,value)=>typeof value==='string'?value.replaceAll('$',()=> '$$'):value)
let saved
try {
  process.umask(0o077)
  const runtime=inspect(), labels=runtime.Config?.Labels??{}
  if(!/^[a-f0-9]{64}$/.test(runtime.Id)||!/^sha256:[a-f0-9]{64}$/.test(runtime.Image)
    ||typeof runtime.Config.Image!=='string'||!runtime.State?.Running||runtime.State.Restarting)throw new Error()
  saved=fs.mkdtempSync(path.join(repo,'.bellteam-compose.'))
  if(runtime.Mounts.some(v=>v.Type==='bind'&&(saved===path.resolve(v.Source)||saved.startsWith(path.resolve(v.Source)===path.sep?path.sep:path.resolve(v.Source)+path.sep))))throw new Error()
  const write=(name,value)=>fs.writeFileSync(path.join(saved,name),value,{mode:0o600,flag:'wx'})
  write('previous-runtime.json',JSON.stringify(runtime))
  const files=labels['com.docker.compose.project.config_files']?.split(',')??[]
  const working=labels['com.docker.compose.project.working_dir'], project=labels['com.docker.compose.project']
  const initial=JSON.stringify(files)===JSON.stringify([path.join(repo,'compose.yaml')])
    ||JSON.stringify(files)===JSON.stringify([path.join(repo,'distribution/server/compose.yaml'),path.join(repo,'distribution/internal/compose.overlay.yaml')])
  const retained=files.length===1&&path.dirname(path.dirname(files[0]))===repo
    &&/^\.bellteam-compose\.[a-zA-Z0-9]{6}$/.test(path.basename(path.dirname(files[0])))
    &&['normal.json','previous-normal.json'].includes(path.basename(files[0]))
  const envFile=labels['com.docker.compose.project.environment_file']
  const actor=retained&&working===repo
  if(project!=='bellteam'||(!initial&&!retained)||(!actor&&working!==path.dirname(files[0]))
    ||(envFile&&envFile!==path.join(repo,'.env')&&!(actor&&envFile==='/dev/null')))throw new Error()
  const env={...process.env,BELLTEAM_SERVER_IMAGE:runtime.Config.Image}
  const profile=runtime.Mounts.find(v=>v.Destination==='/app/src/distribution-profile.mjs')
  if(profile)env.BELLTEAM_INTERNAL_PROFILE_FILE=profile.Source
  const args=['compose','--project-directory',working,'-p',project,...files.flatMap(file=>['-f',file])]
  if(envFile)args.push('--env-file',envFile)
  const raw=docker([...args,'config','--format','json'],{env})
  const normal=JSON.parse(raw.replaceAll('$$','$'))
  if(normal.name!==project||Object.keys(normal.services).join(',')!=='bellteam')throw new Error()
  write('previous-model.json',serialize(normal))
  const hash=docker(['compose','-p',project,'-f',path.join(saved,'previous-model.json'),'config','--hash','bellteam']).trim()
  // shortcut: Compose hash omits fields and external file bytes; actual mount/lifetime acceptance remains separate.
  if(hash!==`bellteam ${labels['com.docker.compose.config-hash']}`)throw new Error()
  write('previous-inputs.json',JSON.stringify({files,working,project,envFile:envFile??null,
    cwd:repo,implicitEnvDirectory:working,
    source:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),hash}))
  if(profile){
    const volume=normal.services.bellteam.volumes?.find(v=>v.target===profile.Destination)
    if(profile.Type!=='bind'||profile.RW!==false||volume?.type!=='bind'||!volume.read_only||volume.source!==profile.Source
      ||docker(['exec','--user','bell',runtime.Id,'/usr/bin/stat','--format','%a',profile.Destination]).trim()!=='644')throw new Error()
    write('previous-profile.mjs',docker(['exec','--user','bell',runtime.Id,'/bin/cat',profile.Destination]))
    fs.chmodSync(path.join(saved,'previous-profile.mjs'),0o644)
    volume.source=path.join(saved,'previous-profile.mjs')
  }
  normal.services.bellteam.image=runtime.Image
  write('previous-normal.json.tmp',serialize(normal))
  fs.renameSync(path.join(saved,'previous-normal.json.tmp'),path.join(saved,'previous-normal.json'))
  const current=inspect()
  if(current.Id!==runtime.Id||current.Image!==runtime.Image||current.State.StartedAt!==runtime.State.StartedAt
    ||!current.State.Running||current.State.Restarting)throw new Error()
  console.log(path.join(saved,'previous-normal.json'))
}catch{console.error('BELLTEAM_ORIGINAL_CONFIG_UNAVAILABLE',saved??'');process.exitCode=1}
NODE
)
git merge -q --ff-only origin/main >&2
test "$(git rev-parse HEAD)" = "$1"
git log --oneline -1 >&2
printf '%s\n' "$previous"
REMOTE
)
case "$previous" in "$dir"/.bellteam-compose.*/previous-normal.json) ;; *) echo BELLTEAM_ORIGINAL_CONFIG_UNAVAILABLE >&2; exit 1;; esac
case "$previous" in *[!a-zA-Z0-9/._-]*) echo BELLTEAM_ORIGINAL_CONFIG_UNAVAILABLE >&2; exit 1;; esac

# 反映で止まるBotを控える（処理待ち一覧も保存する）。再開の声かけは送らない（オーナー裁定 2026-09-03）。
if ! busy="$(ssh "$host" "cd $dir && mkdir -p runtime/backups && queue=runtime/backups/queue-before-deploy-\$(date +%Y%m%dT%H%M).json && docker exec bellteam curl -fsS http://127.0.0.1:4181/api/queue > \"\$queue\" && node -e 'const d=JSON.parse(require(\"fs\").readFileSync(process.argv[1],\"utf8\"));console.log([...new Set(d.items.map(i=>i.botId||i.target))].join(\" \"))' \"\$queue\"" 2>/dev/null)"; then
  echo '処理待ち一覧を保存・確認できない。反映は開始していない。' >&2
  exit 1
fi
printf '作業中のBot: %s\n' "${busy:-なし}"

# 反映は本番側で切り離して走らせる。指定imageは再buildせず、受け入れた実物を使う。
log="runtime/backups/deploy-$(date +%Y%m%dT%H%M%S).log"
ssh "$host" "cd $dir && setsid nohup sudo -n /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/root LANG=C.UTF-8 BELLTEAM_PREVIOUS_COMPOSE=$previous BELLTEAM_SERVER_IMAGE=$image sh scripts/deploy-image.sh > $log 2>&1 < /dev/null &"
for _ in $(seq 1 360); do
  if ssh "$host" "grep -q '^deploy-exit=' $dir/$log" 2>/dev/null; then break; fi
  sleep 5
done
ssh "$host" "tail -3 $dir/$log"
if ! ssh "$host" "grep -q '^deploy-exit=0$' $dir/$log"; then
  echo "本番ビルドまたはコンテナ更新が失敗した。詳細: $dir/$log" >&2
  exit 1
fi

health=
for _ in $(seq 1 24); do
  if health="$(ssh "$host" 'docker exec bellteam curl -fsS http://127.0.0.1:4180/healthz' 2>/dev/null)" &&
    printf '%s' "$health" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{if(JSON.parse(d).status!=="ok")process.exitCode=1}catch{process.exitCode=1}})'; then break; fi
  health=
  sleep 5
done
if [ -z "$health" ]; then
  echo 'healthzの正常応答を確認できない。反映結果は未確認。' >&2
  exit 1
fi
printf 'healthz: %s\n' "$health"
ssh "$host" "docker exec bellteam sh -c 'node --version; codex --version; claude --version; grok --version; cursor-agent --version; gh --version | head -1; npm ls -g --depth=0 2>/dev/null | grep -E \"aiterm-mcp|throughline\"'"
ssh "$host" 'docker exec bellteam curl -fsS http://127.0.0.1:4181/api/bots' \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const b=JSON.parse(d).bots;console.log(`bots ${b.length} online ${b.filter(x=>x.online).length}`)})'
