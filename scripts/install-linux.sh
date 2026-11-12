#!/bin/sh
# Installs or updates the BellTeam Linux app for the current user (no root needed): downloads the
# published build (.NET bundled) and installs it. --from-source builds it from this checkout instead.
# Usage: install-linux.sh [--server-url URL] [--no-launch] [--from-source] | --uninstall
#   curl -fsSL https://github.com/kitepon/BellTeam/releases/download/linux-app/install-linux.sh | sh
set -eu
server_url=""; launch=1; uninstall=0; from_source=0
release="${BELLTEAM_LINUX_RELEASE:-https://github.com/kitepon/BellTeam/releases/download/linux-app}"
while [ $# -gt 0 ]; do
  case "$1" in
    --server-url) server_url="${2:?--server-url にURLを指定してください。}"; shift 2 ;;
    --no-launch) launch=0; shift ;;
    --uninstall) uninstall=1; shift ;;
    --from-source) from_source=1; shift ;;
    *) echo "引数は --server-url <URL>・--no-launch・--from-source・--uninstall です。" >&2; exit 2 ;;
  esac
done
data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
install_dir="$HOME/.local/lib/BellTeam"
link="$HOME/.local/bin/bellteam"
desktop="$data_home/applications/bellteam.desktop"
executable="$install_dir/BellTeam"
# Replacing the files of a running app breaks it; the user closes it and runs this again.
if pgrep -u "$(id -u)" -f -x "$executable" >/dev/null 2>&1; then
  echo 'BellTeamを閉じてから実行してください。' >&2; exit 1
fi
# Only paths this installer created are replaced or removed: the app folder carries a marker file
# (or is the marker-less layout of the first version of this installer), the command is a symlink to
# the installed app, and the menu entry runs the installed app. Anything else at those paths belongs
# to someone else; the run stops before changing anything and names it, and the user moves it away and runs again.
marker="$install_dir/.bellteam-installer"
found_foreign=0
foreign() { echo "このinstallerが置いた物ではないため変更しません: $1" >&2; found_foreign=1; }
if [ -e "$install_dir" ] || [ -L "$install_dir" ]; then
  [ -d "$install_dir" ] && [ ! -L "$install_dir" ] && { [ -f "$marker" ] || { [ -x "$executable" ] && [ -f "$install_dir/bellteam.png" ]; }; } || foreign "$install_dir"
fi
if [ -e "$link" ] || [ -L "$link" ]; then
  [ -L "$link" ] && [ "$(readlink "$link")" = "$executable" ] || foreign "$link"
fi
if [ -e "$desktop" ] || [ -L "$desktop" ]; then
  [ -f "$desktop" ] && [ ! -L "$desktop" ] && grep -Fqx "Exec=$executable" "$desktop" || foreign "$desktop"
fi
if [ "$found_foreign" = 1 ]; then
  echo '別の場所へ移すか、不要なら削除してから、もう一度実行してください。' >&2; exit 1
fi
if [ "$uninstall" = 1 ]; then
  rm -rf "$install_dir"; rm -f "$link" "$desktop"
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$data_home/applications" || true
  echo "BellTeamを削除しました。設定は $data_home/BellTeam に残しています。"
  exit 0
fi
case "$(uname -m)" in
  x86_64|amd64) rid=linux-x64 ;;
  aarch64|arm64) rid=linux-arm64 ;;
  *) echo "このCPU（$(uname -m)）には対応していません。x64かarm64のLinuxで実行してください。" >&2; exit 1 ;;
esac
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
staging="$work/app"; mkdir -p "$staging"
if [ "$from_source" = 1 ]; then
  repo="$(cd "$(dirname "$0")/.." && pwd)"
  [ -f "$repo/linux/BellTeam.Linux/BellTeam.Linux.csproj" ] || { echo '--from-source はBellTeamのソースの scripts/install-linux.sh から実行してください。' >&2; exit 1; }
  command -v dotnet >/dev/null 2>&1 || [ -x "$HOME/.dotnet/dotnet" ] || { echo '.NET 10 SDKが見つかりません。https://dotnet.microsoft.com/download から導入してください。' >&2; exit 1; }
  dotnet_cmd="$(command -v dotnet || echo "$HOME/.dotnet/dotnet")"
  "$dotnet_cmd" publish "$repo/linux/BellTeam.Linux/BellTeam.Linux.csproj" -c Release -r "$rid" --self-contained true -o "$staging" --nologo
  cp "$repo/ios/BellBot/BellBot/Assets.xcassets/AppIcon.appiconset/bellbot-icon.png" "$staging/bellteam.png"
else
  fetch() { if command -v curl >/dev/null 2>&1; then curl -fsSL -o "$2" "$1"; else wget -q -O "$2" "$1"; fi; }
  command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 || { echo 'curlかwgetが必要です。' >&2; exit 1; }
  archive="BellTeam-$rid.tar.gz"
  fetch "$release/$archive" "$work/$archive" && fetch "$release/SHA256SUMS" "$work/SHA256SUMS" || { echo "公開版を取得できませんでした: $release/$archive" >&2; exit 1; }
  # A truncated or mismatched download is never installed.
  (cd "$work" && grep -F "  $archive" SHA256SUMS | sha256sum -c --status) || { echo '取得した公開版の検査に失敗しました。もう一度実行してください。' >&2; exit 1; }
  tar -xzf "$work/$archive" -C "$staging"
fi
if [ -n "$server_url" ]; then
  "$staging/BellTeam" --configure "$server_url" || { echo '接続先を保存できませんでした。HTTPS、またはlocalhost・LANのHTTP接続先URLを指定してください。' >&2; exit 1; }
fi
rm -rf "$install_dir"; mkdir -p "$install_dir" "$(dirname "$link")" "$(dirname "$desktop")"
cp -a "$staging/." "$install_dir/"
echo "scripts/install-linux.sh" > "$marker"
ln -sf "$executable" "$link"
cat > "$desktop" <<EOF
[Desktop Entry]
Type=Application
Name=BellTeam
Comment=BellTeamのメンバーと会話する
Exec=$executable
Icon=$install_dir/bellteam.png
Terminal=false
Categories=Network;Chat;
StartupWMClass=BellTeam
EOF
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$data_home/applications" || true
echo "導入先: $install_dir"
if [ "$launch" = 1 ]; then
  setsid "$executable" >/dev/null 2>&1 < /dev/null &
  attempt=0
  while [ $attempt -lt 50 ]; do
    pgrep -u "$(id -u)" -f -x "$executable" >/dev/null 2>&1 && exit 0
    attempt=$((attempt + 1)); sleep 0.1
  done
  echo '導入したBellTeamを起動できませんでした。' >&2; exit 1
fi
