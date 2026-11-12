#!/bin/sh
# Builds the published Linux app downloads into <out>: one self-contained archive per CPU, SHA256SUMS and the installer.
# Usage: scripts/package-linux-app.sh <out>
set -eu
cd "$(dirname "$0")/.."
out="${1:?出力先のフォルダを指定してください。}"
rm -rf "$out"; mkdir -p "$out"
for rid in linux-x64 linux-arm64; do
  app="$out/.build-$rid"
  dotnet publish linux/BellTeam.Linux/BellTeam.Linux.csproj -c Release -r "$rid" --self-contained true -o "$app" --nologo
  cp ios/BellBot/BellBot/Assets.xcassets/AppIcon.appiconset/bellbot-icon.png "$app/bellteam.png"
  tar -czf "$out/BellTeam-$rid.tar.gz" -C "$app" .
  rm -rf "$app"
done
cp scripts/install-linux.sh "$out/install-linux.sh"
(cd "$out" && sha256sum BellTeam-linux-x64.tar.gz BellTeam-linux-arm64.tar.gz install-linux.sh > SHA256SUMS)
