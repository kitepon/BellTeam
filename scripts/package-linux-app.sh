#!/bin/sh
# Builds the published Linux app downloads into <out>: one self-contained archive per CPU, SHA256SUMS and the installer.
# Only those four files in <out> are replaced; anything else there is left as it is.
# Usage: scripts/package-linux-app.sh <out>
set -eu
cd "$(dirname "$0")/.."
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
