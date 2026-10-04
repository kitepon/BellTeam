# ランタイムとCLIを反映ごとに現行版へ更新

2026-09-27確認。導入する版は固定しない。Dockerfileと正規反映スクリプトを動作の正本とし、この文書は判断と検証の記録とする。

- Node.jsは公式イメージの`current-bookworm`を使い、反映時に`--pull`で更新する。
- Claude Code、Codex、Throughline、Aitermはnpmの`latest`タグ、Grokは[公式installer](https://x.ai/cli/install.sh)、GitHub CLIは[公式APTリポジトリ](../../rag/github-cli/raw/install_linux.md)、Cursorは[公式installerと`cursor-agent update`](../../rag/runtime-updates/raw/update-commands.md)を使う。
- 反映ごとにDockerのビルドキャッシュを使わず、各導入コマンドを実行する。ビルドが失敗した時はコンテナを入れ替えず、失敗を返す。
- Cursorの`/home/bell/.local`は永続volumeのため、コンテナ起動時にも`cursor-agent update`を実行する。更新に失敗したらBotの受付を開始しない。
- [Aiterm 0.41.0の更新履歴](https://github.com/kitepon/aiterm-mcp/releases/tag/v0.41.0)では旧`composer_agent` aliasと`composer`種別が削除された。BellTeamは`pty_send`と4ハーネスの正式名を使い、このaliasは使わない。
- Codex 0.157.1の`codex debug models`を取得し、`config/models.json`のCodex候補と差がないことを確認した。モデル候補の変更は不要。

参照した導入仕様の原文抜粋は[更新コマンドの一次資料](../../rag/runtime-updates/raw/update-commands.md)に保存した。過去の計画・試験記録にある旧版番号は当時の実測として残す。

## 反映前の実測

- `docker build --pull --no-cache`でmacOS上のLinux arm64検証イメージを作成できた。
- イメージ内の版はNode.js 26.10.0、Claude Code 2.1.283、Codex 0.157.1、Grok 1.0.41、Cursor Agent 2026.09.26、Aiterm 0.41.0、Throughline 0.10.19、GitHub CLI 2.101.0。これは検証時点の取得結果であり、次回反映の版指定ではない。
- 検証コンテナの`cursor-agent update`は成功し、現行版と報告した。
- Aiterm 0.41.0へMCP接続し、`pty_send`と`agent_launch`が提供され、削除された`agent_steer`ツールが無いことを確認した。
- `node --test test/aiterm-transport.test.mjs`は23件成功、`npm test`は192件成功・失敗0。
- `sh -n scripts/deploy.sh`と`git diff --check`は成功。本番のDocker Compose v5.3.1で`build --pull --no-cache`と`up --no-build`の引数を確認した。

## 初回反映で見つけた環境復元の欠落

初回反映のコンテナは`healthy`となり、15体のBot台帳とAiterm MCP接続を確認した。一方、Bot 1体の`environment/setup.sh`が`corepack: command not found`（終了コード127）で失敗した。Node 25以降は[Nodeの配布からCorepackが外れた](../../rag/runtime-updates/raw/update-commands.md)ため、Node 26へ更新したイメージに存在しないことが原因である。そのBotの構築手順は変更せず、BellTeamのベース環境へ公式npm packageのCorepack現行版を追加する。

修正版のイメージを再ビルドし、`corepack --version`は0.36.0、当該Botの`packageManager`指定を再現した一時プロジェクトで`corepack pnpm --version`は10.0.0を返した。Botの実際の`setup.sh`の成否は本番再反映後に確認する。
