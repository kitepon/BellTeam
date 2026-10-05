# Botの開発環境

各Botは `/srv/bellteam/bots/<bot-id>/` に自分の実装、依存ファイル、環境の構築手順を持つ。コンテナの中は読み取り専用で、変更できない（`/tmp` と `/run` を除く）。必要な道具は、自分のプロジェクトの下へ導入する。

標準でPython 3・pip・venv・Python開発ヘッダ、Node/npm・Corepack、GCC/G++・make・pkg-config・CMake、git・GitHub CLI（`gh`）・curl・rsync・ripgrep・jq・zip/unzipが使える。他の言語のランタイム、言語ごとの依存関係、複数の版は、自分のプロジェクト内に置く。OSパッケージ（`.deb`）が要る時は、後の「OSパッケージ」の手順で自分のプロジェクトへ展開する。`sudo apt-get install` は、コンテナが読み取り専用なので失敗する。

GitHubの認証情報はコンテナイメージに含めない。全Botが共有の`/srv/bellteam/shared/tools/github/`を使う（オーナー裁定 2026-09-25）。BellTeamは全Botの環境で`GH_CONFIG_DIR`を`gh/`へ、`GIT_CONFIG_GLOBAL`を`gitconfig`へ向けるので、`gh auth login`と`git config --global`の結果はコンテナ更新や再設置で消えない。認証が切れた時は、どのBotの席からでも`gh auth login`を一度実行すれば全員に効く。

## 構築と復元

`environment/setup.sh` を作り、プロジェクトのルートで `bash -e environment/setup.sh` を実行する。BellTeamもコンテナ起動時、会話受付と予定の開始前に、同じスクリプトをBotごとに順番に一度実行する。実行権限の付与は不要。

setup.shは何度実行しても必要な状態になるように書く。依存ファイル、固定した版、必要なソースを同じ永続プロジェクトへ置く。実際の依存管理にはpip・npmなどの標準ツールを使う。構築処理にAIやBellTeam MCPの呼び出し、サーバーの常駐処理を入れない。

例えば、Pythonの依存を `environment/requirements.txt` に固定して保存した場合は、次のsetup.shで導入・復元できる。

```bash
set -eu
cd "${BELLTEAM_PROJECT:-$(pwd)}"
# ここは専用の生成物の置き場。コードやデータを入れない。
# コンテナのPythonが更新されても同じ依存ファイルから作り直す。
/usr/bin/python3 -m venv --clear environment/python
environment/python/bin/python -m pip install -r environment/requirements.txt
```

venvはPython本体を参照するため、フォルダの永続化だけでは別のPythonへの更新を扱えない。[Python公式文書](https://docs.python.org/3/library/venv.html#how-venvs-work)も依存ファイルから再作成できるようにする方法を示している。既存のvenvを再利用する設計も選べるが、その場合はPython更新時の再作成をsetup.shで扱う。

Nodeのライブラリは各リポジトリの `package.json` と `package-lock.json` を保存し、setup.shでそのリポジトリへ移動して `npm ci` を実行する。CLIを `npm install -g package@version` で入れる場合も、同じコマンドをsetup.shへ残す。導入先はBotの `.local` になる。

導入操作はsetup.shへ残す。BellTeamがシェル履歴から導入操作を推測したり、既存のvenvを勝手に消したりすることはない。

## OSパッケージ

コンテナの中へは導入できないので、`.deb` をrootなしで自分のプロジェクトへ展開し、道を通して使う。落とすのは、コンテナに入っていない物だけ（依存も含む）。

```bash
S="$PWD/.cache/apt"; R="$PWD/.local/os/root"
mkdir -p "$S/state/lists/partial" "$S/cache/archives/partial" "$R"
APT="-o Dir::State=$S/state -o Dir::State::status=/var/lib/dpkg/status -o Dir::Cache=$S/cache -o Debug::NoLocking=1"
apt-get $APT update
apt-get $APT install -d -y --no-install-recommends shellcheck
for deb in "$S"/cache/archives/*.deb; do dpkg -x "$deb" "$R"; done
```

使う時は、env.shで `PATH` へ `$R/usr/bin`、`LD_LIBRARY_PATH` へ `$R/usr/lib/<アーキテクチャ>` を足す。コンテナのイメージが替わると、入っている物が変わるので、展開し直す。systemdや `service` で起こす仕組みは使えない。サーバー（PostgreSQLなど）は、データを自分のプロジェクト、ソケットを `/tmp` に置いて、自分で起こす。

複数のBotが同じOSパッケージを使う時は、共通の置き場 `/srv/bellteam/shared/tools/<tool-id>/` へ一つだけ展開する。この手順をまとめたスクリプトを共通の置き場に持つ設置では、それを使う。

起動時の出力と終了コードは `environment/setup.log` に保存し、次の起動で上書きする。失敗した場合も他のBotの復元とBellTeamの起動を続ける。本人がログを読んで修正し、同じsetup.shを手動実行する。自動再試行は行わない。各スクリプトの処理中は起動が待つので、終了する構築処理を書く。

## 環境変数とコマンド

`BELLTEAM_PROJECT` は自分のプロジェクトの絶対パスになる。既定のPATHは自分の `.local/bin`、`node_modules/.bin`、コンテナのPATHの順。npmのグローバル導入先も自分の `.local` に設定される。npmとpipのキャッシュはそれぞれ自分の `.cache/npm`、`.cache/pip` に置く。共有のHOMEとCLI認証・MCP登録先は従来のまま。

追加の設定は `environment/env.sh` に書く。例えば前述のPython環境を使う場合は次のようにする。

```bash
export VIRTUAL_ENV="$BELLTEAM_PROJECT/environment/python"
export PATH="$VIRTUAL_ENV/bin:$PATH"
```

env.shはBashで読み、変数の代入も自動的にexportする。関数やaliasではなく環境変数を設定する。導入処理はsetup.shへ置く。setup.shの実行ではenv.shを読み込まないので、まだ存在しないvenvを参照して構築に失敗することはない。

会話用CLIは起動時にこの環境を受け取り、子プロセスとMCPへ引き継ぐ。変更済みのenv.shを現在の会話中に使うにはシェルで読み込むか、対象プログラムの絶対パスを指定する。次のセッション起動からは自動で適用される。CLI自身がシェル設定でPATHを変更する場合も、絶対パスを使える。

コマンド予定は毎回env.shを読み、同じ環境で `sh -c` を実行する。env.shが失敗した予定は従来のコマンド失敗として報告される。新しいBotにもenvironmentフォルダが作られるが、setup.shとenv.shは本人が必要な時に作る。

複数Botが使うツールは、共通の置き場へ一つだけ置く。置き方とMCP登録先は規範に従う。共有ツールの導入が必要なBotは、自分のsetup.shから共通の構築スクリプトを呼べる。共有領域に置いたという理由で全Botへ導入・登録することはない。
