#!/bin/sh
# 本番反映の正規入口。GitHubのmainを取り込み、受入imageまたは新規buildを反映する。
# usage: scripts/deploy.sh
# 商用image: BELLTEAM_DEPLOY_IMAGE=repo@sha256:digest BELLTEAM_DEPLOY_QUIET_EXCEPT=bot-id sh scripts/deploy.sh
set -eu
cd "$(dirname "$0")/.."
host=main-server
dir=/home/kite/BellTeam
quiet_except=${BELLTEAM_DEPLOY_QUIET_EXCEPT:-}
case "$quiet_except" in *[!a-zA-Z0-9_-]*) echo 'invalid quiet Bot ID' >&2; exit 2;; esac
image=${BELLTEAM_DEPLOY_IMAGE:-}
if [ -n "$image" ]; then
  case "$image" in *@sha256:*) ;; *) echo '受入imageをrepo@sha256:digestで指定してください。' >&2; exit 2;; esac
  digest=${image##*@sha256:}
  repository=${image%@sha256:*}
  case "$image" in *[!a-zA-Z0-9._:/@-]*) echo '受入imageの指定が不正です。' >&2; exit 2;; esac
  case "$digest" in ''|*[!a-f0-9]*) echo 'image digestが不正です。' >&2; exit 2;; esac
  if [ ${#digest} -ne 64 ] || [ -z "$repository" ] || [ -z "$quiet_except" ]; then
    echo '受入imageの完全なdigestとquiet対象Botを指定してください。' >&2
    exit 2
  fi
fi
quiet_check=:
if [ -n "$quiet_except" ]; then quiet_check="sh scripts/check-deploy-quiet.sh $quiet_except"; fi

# 反映するのはcommit済みの内容だけ。本番でcommitを作らないので、履歴はGitHubのmainと常に一致する。
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo '未commitの変更がある。commitしてから反映する。' >&2
  exit 1
fi
git push -q origin HEAD:main
head="$(git rev-parse HEAD)"

# 本番の作業ツリーに手直しがあれば取り込まずに止める（本番のBot台帳config/bots.jsonを含む）。
ssh "$host" "cd $dir && git fetch -q origin && if [ -n \"\$(git status --porcelain --untracked-files=no)\" ]; then git status -s --untracked-files=no; echo '本番に未commitの変更がある。GitHubへ取り込んでから反映する。' >&2; exit 1; fi && git merge -q --ff-only origin/main && test \"\$(git rev-parse HEAD)\" = $head && git log --oneline -1"

# 反映で止まるBotを控える（処理待ち一覧も保存する）。再開の声かけは送らない（オーナー裁定 2026-09-03）。
busy="$(ssh "$host" "cd $dir && mkdir -p runtime/backups && docker exec bellteam curl -fsS http://127.0.0.1:4181/api/queue | tee runtime/backups/queue-before-deploy-\$(date +%Y%m%dT%H%M).json | node -e 'let d=\"\";process.stdin.on(\"data\",c=>d+=c).on(\"end\",()=>console.log([...new Set(JSON.parse(d).items.map(i=>i.botId||i.target))].join(\" \")))'" 2>/dev/null || true)"
printf '作業中のBot: %s\n' "${busy:-なし}"

# 反映は本番側で切り離して走らせる。指定imageは再buildせず、受け入れた実物を使う。
log="runtime/backups/deploy-$(date +%Y%m%dT%H%M%S).log"
if [ -n "$image" ]; then
  ssh "$host" "cd $dir && setsid nohup env BELLTEAM_SERVER_IMAGE=$image BELLTEAM_DEPLOY_QUIET_EXCEPT=$quiet_except sh scripts/deploy-image.sh > $log 2>&1 < /dev/null &"
else
  ssh "$host" "cd $dir && setsid nohup sh -c 'docker compose build --pull --no-cache && $quiet_check && sh scripts/update-cursor.sh && $quiet_check && docker compose up -d --no-build; echo deploy-exit=\$?' > $log 2>&1 < /dev/null &"
fi
for _ in $(seq 1 360); do
  if ssh "$host" "grep -q '^deploy-exit=' $dir/$log" 2>/dev/null; then break; fi
  sleep 5
done
ssh "$host" "tail -3 $dir/$log"
if ! ssh "$host" "grep -q '^deploy-exit=0$' $dir/$log"; then
  echo "本番ビルドまたはコンテナ更新が失敗した。詳細: $dir/$log" >&2
  exit 1
fi

for _ in $(seq 1 24); do
  if ssh "$host" 'docker exec bellteam curl -fsS http://127.0.0.1:4180/healthz' 2>/dev/null | grep -q '"ok"'; then break; fi
  sleep 5
done
printf 'healthz: %s\n' "$(ssh "$host" 'docker exec bellteam curl -fsS http://127.0.0.1:4180/healthz')"
ssh "$host" "docker exec bellteam sh -c 'node --version; codex --version; claude --version; grok --version; cursor-agent --version; gh --version | head -1; npm ls -g --depth=0 2>/dev/null | grep -E \"aiterm-mcp|throughline\"'"
ssh "$host" 'docker exec bellteam curl -fsS http://127.0.0.1:4181/api/bots' \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const b=JSON.parse(d).bots;console.log(`bots ${b.length} online ${b.filter(x=>x.online).length}`)})'
