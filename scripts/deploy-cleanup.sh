#!/bin/sh
# 通常deployの実前版とcleanup結果を、同じprivate保存世代へ結ぶ。
set -eu
cd "$(dirname "$0")/.."
repo=$(pwd)
previous=${1-}
case "$#:$previous" in
  "1:$repo"/.bellteam-compose.*/previous-normal.json) ;;
  *) echo BELLTEAM_CLEANUP_GENERATION_INVALID >&2; exit 2;;
esac
case "$previous" in *[!a-zA-Z0-9/._-]*) echo BELLTEAM_CLEANUP_GENERATION_INVALID >&2; exit 2;; esac
umask 077
saved=${previous%/*}
stdout=$saved/deploy-cleanup.stdout.jsonl
stderr=$saved/deploy-cleanup.stderr.log
result=$saved/deploy-cleanup.json
cleanup_exit=0
(
  rollback=$(node --input-type=module - "$previous" "$saved/previous-runtime.json" <<'NODE'
import fs from 'node:fs'
const normal = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const runtime = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'))
if (!/^sha256:[a-f0-9]{64}$/.test(runtime.Image) || normal.services?.bellteam?.image !== runtime.Image)
  throw new Error('BELLTEAM_CLEANUP_PREVIOUS_IMAGE_MISMATCH')
console.log(runtime.Image)
NODE
  ) || exit $?
  python3 -B scripts/cleanup-deploy-images.py --rollback-image "$rollback"
) > "$stdout" 2> "$stderr" || cleanup_exit=$?
printf '{"exit":%s,"previousRuntime":"%s","stdout":"%s","stderr":"%s"}\n' \
  "$cleanup_exit" "$saved/previous-runtime.json" "$stdout" "$stderr" > "$result.tmp"
mv "$result.tmp" "$result"
printf 'deploy-cleanup-result=%s\n' "$result"
exit "$cleanup_exit"
