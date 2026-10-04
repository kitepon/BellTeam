#!/bin/sh
set -eu
cd "$(dirname "$0")"
docker compose pull
docker compose run --rm --no-deps --user root bellteam sh -c \
  'mkdir -p /home/bell /srv/bellteam && chown bell:bell /home/bell /srv/bellteam'
docker compose up -d --wait --wait-timeout 120

endpoint=$(docker compose port bellteam 4180)
case "$endpoint" in
  0.0.0.0:*|\[::\]:*) url="http://localhost:18891" ;;
  *) url="http://$endpoint" ;;
esac
printf '\nBellTeamを起動しました。ブラウザで %s を開いてください。\n' "$url"
printf 'iPhone・iPadからは、このマシンのLANアドレスの18891番へ接続できます。\n'
printf '最初に使うAIを選び、公式サイトで認証すると、案内役との会話が始まります。\n'
