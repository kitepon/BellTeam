#!/bin/sh
# Builds the published Linux app downloads into <out>: one self-contained archive per CPU, SHA256SUMS and the installer.
# Only those four files in <out> are replaced; anything else there is left as it is.
# Usage: scripts/package-linux-app.sh <out>   (the Google Desktop client secret goes into the build, never into git: it comes from the authentication module on main-server over ssh, one call, unless BELLTEAM_GOOGLE_DESKTOP_JSON is already set)
set -eu
cd "$(dirname "$0")/.."
# rabbit has no module socket (Tronie's host ruling): ask main-server, which runs the granted command and prints the value on stdout.
[ -n "${BELLTEAM_GOOGLE_DESKTOP_JSON:-}" ] || BELLTEAM_GOOGLE_DESKTOP_JSON="$(ssh main-server 'cd /home/kite/BellTeam && auth exec printenv BELLTEAM_GOOGLE_DESKTOP_JSON')" || { echo "認証仲介からGoogleのデスクトップ用クライアントの値を取れませんでした（ssh main-server の auth exec printenv BELLTEAM_GOOGLE_DESKTOP_JSON）。" >&2; exit 1; }
[ -n "$BELLTEAM_GOOGLE_DESKTOP_JSON" ] || { echo "Googleのデスクトップ用クライアントの値が空です。" >&2; exit 1; }
export BELLTEAM_GOOGLE_DESKTOP_JSON
out="${1:?出力先のフォルダを指定してください。}"
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
for rid in linux-x64 linux-arm64; do
  app="$work/build-$rid"
  dotnet publish linux/BellTeam.Linux/BellTeam.Linux.csproj -c Release -r "$rid" --self-contained true -o "$app" --nologo
  cp ios/BellBot/BellBot/Assets.xcassets/AppIcon.appiconset/bellbot-icon.png "$app/bellteam.png"
  tar -czf "$work/BellTeam-$rid.tar.gz" -C "$app" .
done
cp scripts/install-linux.sh "$work/install-linux.sh"
(cd "$work" && sha256sum BellTeam-linux-x64.tar.gz BellTeam-linux-arm64.tar.gz install-linux.sh > SHA256SUMS)
mkdir -p "$out"
for name in BellTeam-linux-x64.tar.gz BellTeam-linux-arm64.tar.gz install-linux.sh SHA256SUMS; do mv -f "$work/$name" "$out/$name"; done
