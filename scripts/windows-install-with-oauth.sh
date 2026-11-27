#!/bin/sh
# Runs on main-server under `auth exec /home/kite/BellTeam/scripts/windows-install-with-oauth.sh [install-windows.ps1 options]` (the item name is that path).
# The Desktop OAuth client JSON arrives in BELLTEAM_GOOGLE_DESKTOP_OAUTH and goes on stdin to the Windows build on fox; nothing on fox listens or stores it.
# The fox clone must already be on the commit to ship (git switch --detach <main sha>) and BellTeam must be closed there.
set -eu
[ -n "${BELLTEAM_GOOGLE_DESKTOP_OAUTH:-}" ] || { echo "Googleのデスクトップ用クライアントの値がありません。次のように実行してください: auth exec /home/kite/BellTeam/scripts/windows-install-with-oauth.sh" >&2; exit 1; }
printf '%s' "$BELLTEAM_GOOGLE_DESKTOP_OAUTH" | ssh -o BatchMode=yes kite_@192.168.1.11 pwsh -NoProfile -File 'C:\Users\kite_\Developer\BellTeam\scripts\install-windows.ps1' -NoLaunch -SkipShareTarget -GoogleDesktopOAuthStdin "$@"
