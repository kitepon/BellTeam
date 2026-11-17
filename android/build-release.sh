#!/bin/sh
# Builds the Google Play upload bundle (AAB) signed with the upload key. The key and its password live outside the repository
# (default ~/.config/bellteam-android/upload.jks and upload.pass); Play re-signs the app with its own app-signing key.
# Usage: android/build-release.sh [versionCode]   (versionCode must grow with every upload; default: seconds since 2026-01-01 / 60)
set -eu
here=$(cd "$(dirname "$0")" && pwd)
keys=${BELLTEAM_ANDROID_KEYS:-$HOME/.config/bellteam-android}
[ -f "$keys/upload.jks" ] && [ -f "$keys/upload.pass" ] || { echo "アップロード鍵が見つかりません: $keys/upload.jks と upload.pass" >&2; exit 1; }
code=${1:-$(( ($(date +%s) - 1767225600) / 60 ))}
BELLTEAM_UPLOAD_PASS=$(cat "$keys/upload.pass"); export BELLTEAM_UPLOAD_PASS
dotnet=$(command -v dotnet || echo "$HOME/.dotnet/dotnet")
sdk=${ANDROID_HOME:-$HOME/Android/Sdk}
jdk=${JAVA_HOME:-$HOME/opt/jdk-17}
"$dotnet" publish "$here/BellTeam.Android/BellTeam.Android.csproj" -c Release -f net10.0-android -p:AndroidPackageFormat=aab \
  -p:ApplicationVersion="$code" -p:AndroidSdkDirectory="$sdk" -p:JavaSdkDirectory="$jdk" \
  -p:AndroidKeyStore=true -p:AndroidSigningKeyStore="$keys/upload.jks" -p:AndroidSigningKeyAlias=upload \
  -p:AndroidSigningKeyPass=env:BELLTEAM_UPLOAD_PASS -p:AndroidSigningStorePass=env:BELLTEAM_UPLOAD_PASS
echo "$here/BellTeam.Android/bin/Release/net10.0-android/publish/dev.kitepon.bellbot-Signed.aab (versionCode $code)"
