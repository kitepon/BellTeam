#!/bin/sh
# Runs on main-server under `auth exec /home/kite/BellTeam/scripts/windows-install-with-oauth.sh [install-windows.ps1 options]` (the item name is that path).
# The Desktop OAuth client JSON arrives in BELLTEAM_GOOGLE_DESKTOP_OAUTH and goes on stdin to the Windows build on fox; nothing on fox listens or stores it.
# The fox clone must already be on the commit to ship (git switch --detach <main sha>) and BellTeam must be closed there (install only).
# `--package <fox folder>` builds the published downloads (BellTeam-win-x64.zip, BellTeam-win-arm64.zip, SHA256SUMS, install-windows.ps1) into that folder on fox instead of installing; the upload is scripts/publish-windows-app.ps1.
set -eu
[ -n "${BELLTEAM_GOOGLE_DESKTOP_OAUTH:-}" ] || { echo "Googleのデスクトップ用クライアントの値がありません。次のように実行してください: auth exec /home/kite/BellTeam/scripts/windows-install-with-oauth.sh" >&2; exit 1; }
if [ "${1:-}" = "--package" ]; then
  out="${2:?出力先のfoxのフォルダを指定してください。}"
  printf '%s' "$BELLTEAM_GOOGLE_DESKTOP_OAUTH" | ssh -o BatchMode=yes kite_@192.168.1.11 pwsh -NoProfile -File 'C:\Users\kite_\Developer\BellTeam\scripts\package-windows-app.ps1' -Out "$out" -GoogleDesktopOAuthStdin
  exit
fi
printf '%s' "$BELLTEAM_GOOGLE_DESKTOP_OAUTH" | ssh -o BatchMode=yes kite_@192.168.1.11 pwsh -NoProfile -File 'C:\Users\kite_\Developer\BellTeam\scripts\install-windows.ps1' -NoLaunch -SkipShareTarget -GoogleDesktopOAuthStdin "$@"
