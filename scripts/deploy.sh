#!/bin/sh
# 本番反映の正規入口。GitHubのmainへpushしたcommitを本番がfast-forwardで取り込み、再ビルド、healthz、Bot状態までを一回で返す。
# usage: scripts/deploy.sh
set -eu
cd "$(dirname "$0")/.."
host=main-server
dir=/home/kite/BellTeam

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

# 再ビルドは本番側で切り離して走らせる。公式の現行版を毎回取得し、ビルドが成功してからコンテナを入れ替える。
log="runtime/backups/deploy-$(date +%Y%m%dT%H%M%S).log"
ssh "$host" "cd $dir && setsid nohup sh -c 'docker compose build --pull --no-cache && docker compose up -d --no-build; echo deploy-exit=\$?' > $log 2>&1 < /dev/null &"
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
