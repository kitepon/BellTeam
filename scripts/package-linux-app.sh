#!/bin/sh
# Builds the published Linux app downloads into <out>: one self-contained archive per CPU, SHA256SUMS and the installer.
# Only those four files in <out> are replaced; anything else there is left as it is.
# Usage: dotagents-op-run --env-file scripts/linux-google-desktop.env -- scripts/package-linux-app.sh <out>   (the env file only names the vault item; the Google Desktop client secret goes into the build, never into git)
set -eu
cd "$(dirname "$0")/.."
[ -n "${BELLTEAM_GOOGLE_DESKTOP_JSON:-}" ] || { echo "Googleのデスクトップ用クライアントの値がありません。次のように実行してください: dotagents-op-run --env-file scripts/linux-google-desktop.env -- scripts/package-linux-app.sh <out>" >&2; exit 1; }
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
