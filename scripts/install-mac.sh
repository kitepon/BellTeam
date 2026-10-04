#!/bin/zsh
# このMac用の開発署名でReleaseビルドを作り、Applicationsへ導入する。
set -eu
cd "$(dirname "$0")/.."
: "${BELLTEAM_APP_ID:?配布者のBundle IDをBELLTEAM_APP_IDへ指定してください}"
: "${BELLTEAM_TEAM_ID:?Apple DeveloperのTeam IDをBELLTEAM_TEAM_IDへ指定してください}"
output_dir="${BELLTEAM_MAC_BUILD_DIR:-$PWD/runtime/mac-build}"
app_dir="${BELLTEAM_MAC_APP_DIR:-$HOME/Applications}"
xcodebuild -project ios/BellBot/BellBot.xcodeproj -scheme BellTeam \
  -configuration Release -destination 'platform=macOS,variant=Mac Catalyst' \
  -derivedDataPath "$output_dir" TARGETED_DEVICE_FAMILY=6 BELLTEAM_APP_BUNDLE_IDENTIFIER="$BELLTEAM_APP_ID" \
  DEVELOPMENT_TEAM="$BELLTEAM_TEAM_ID" BELLTEAM_PUSH_ENVIRONMENT=development \
  CODE_SIGN_IDENTITY='Apple Development' -allowProvisioningUpdates -allowProvisioningDeviceRegistration build
source_app="$output_dir/Build/Products/Release-maccatalyst/BellTeam.app"
codesign --verify --deep --strict "$source_app"
mkdir -p "$app_dir"
if [ -d "$app_dir/BellTeam.app" ]; then
  mkdir -p runtime/backups
  ditto -c -k --keepParent "$app_dir/BellTeam.app" "runtime/backups/BellTeam-Mac-$(date +%Y%m%dT%H%M%S).zip"
fi
installed_executable="$app_dir/BellTeam.app/Contents/MacOS/BellTeam"
if pgrep -f -x "$installed_executable" >/dev/null; then
  osascript -e "tell application id \"$BELLTEAM_APP_ID\" to quit"
  for ((attempt = 0; attempt < 50; attempt++)); do
    if ! pgrep -f -x "$installed_executable" >/dev/null; then break; fi
    sleep 0.1
  done
  if pgrep -f -x "$installed_executable" >/dev/null; then
    print -u2 '既存のBellTeamアプリが終了しませんでした。導入を中止します。'
    exit 1
  fi
fi
ditto "$source_app" "$app_dir/BellTeam.app"
codesign --verify --deep --strict "$app_dir/BellTeam.app"
if [ -n "${BELLTEAM_SERVER_URL:-}" ]; then
  defaults write "$BELLTEAM_APP_ID" bellbot.serverURL -string "$BELLTEAM_SERVER_URL"
fi
open "$app_dir/BellTeam.app"
for ((attempt = 0; attempt < 50; attempt++)); do
  if pgrep -f -x "$installed_executable" >/dev/null; then break; fi
  sleep 0.1
done
if ! pgrep -f -x "$installed_executable" >/dev/null; then
  print -u2 '導入したBellTeamアプリを起動できませんでした。'
  exit 1
fi
printf '導入先: %s/BellTeam.app\n' "$app_dir"
