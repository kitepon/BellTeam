#!/bin/sh
# 本体交換でclientが消えても、health確認とcleanup結果保存までHostで終える。
set -eu
cd "$(dirname "$0")/.."
previous=${BELLTEAM_PREVIOUS_COMPOSE:?}
finish() {
  result=$?
  trap - 0
  printf 'deploy-caller-exit=%s\n' "$result"
  exit "$result"
}
trap finish 0
sh scripts/deploy-image.sh

health=
for _ in $(seq 1 24); do
  if health="$(docker exec bellteam curl -fsS http://127.0.0.1:4180/healthz 2>/dev/null)" &&
    printf '%s' "$health" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{if(JSON.parse(d).status!=="ok")process.exitCode=1}catch{process.exitCode=1}})'; then break; fi
  health=
  sleep 5
done
if [ -z "$health" ]; then
  echo 'healthzの正常応答を確認できない。反映結果は未確認。' >&2
  exit 1
fi
printf 'healthz: %s\n' "$health"
# cleanupの成否は本体更新の終端と分け、同じ配備logから原本へ辿れるようにする。
if ! sh scripts/deploy-cleanup.sh "$previous"; then
  echo '本体はhealthy。image cleanupまたは結果保存に失敗した。' >&2
  exit 1
fi
printf 'cleanup result: %s/deploy-cleanup.json\n' "${previous%/*}"
docker exec bellteam sh -c 'node --version; codex --version; claude --version; grok --version; cursor-agent --version; gh --version | head -1; npm ls -g --depth=0 2>/dev/null | grep -E "aiterm-mcp|throughline"'
printf 'Bot稼働数: 未確認（配備workerには席認証がありません）\n'
