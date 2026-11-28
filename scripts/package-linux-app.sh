#!/bin/sh
# Builds the published Linux app downloads into <out>: one self-contained archive per CPU, SHA256SUMS and the installer.
# Only those four files in <out> are replaced; anything else there is left as it is.
# Usage: scripts/package-linux-app.sh <out>   (the Google Desktop client JSON is public build configuration (Sakura's ruling 2026-11-28): config/google-desktop-oauth.json in this checkout, untracked and never committed (GitHub's push protection refuses it), unless BELLTEAM_GOOGLE_DESKTOP_JSON is already set)
set -eu
cd "$(dirname "$0")/.."
[ -n "${BELLTEAM_GOOGLE_DESKTOP_JSON:-}" ] || { [ -f config/google-desktop-oauth.json ] && BELLTEAM_GOOGLE_DESKTOP_JSON="$(cat config/google-desktop-oauth.json)"; } || { echo "config/google-desktop-oauth.json がありません（Googleのデスクトップ用クライアントのJSON。コミットしない）。" >&2; exit 1; }
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
