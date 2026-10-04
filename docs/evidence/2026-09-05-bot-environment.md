# Botの環境構築と復元

## 実装と試験

コンテナ内のパスワード不要sudo、Python/pip/venvとビルド道具、各Botのsetup.shによる起動時復元、env.shによるCLIとコマンド予定への環境適用を実装した。

- 対象試験: 環境5件、Bot管理11件、Aitermと予定31件で成功。
- 全試験: `npm test` 一回、152件成功、失敗0。
- 4種のCLIについて起動時に環境を渡すことを確認。Aiterm接続の試験は実際のMCPクライアントと試験用stdioサーバーを使い、同時に起動した接続で変数値が混ざらず、ツール引数には値を出さないことを確認した。AIモデルへの実メッセージ送信は行っていない。

## 実コンテナでの確認

本番とは別に `bellteam-environment-test:20260905` をビルドし、`scripts/smoke-bot-environment.mjs` を実行した。保存フォルダはホストの `/home/kite/BellTeam/runtime/backups/environment-smoke-20260905`。本番Botのコードや設定は使っていない。

1. UID 1000のbellから `sudo -n` を使い、イメージに含まれないtreeをaptで導入。
2. Botの専用venvにpackaging 24.2、専用npm prefixにsemver 7.7.2を導入。
3. コマンド予定と同じ実行関数から、環境変数・Python import・npm CLIを使用して成功。
4. コンテナを削除し、新規コンテナへ同じ永続フォルダをマウント。treeが消えていることを確認し、保存されたvenvも試験として削除。
5. 保存済みsetup.shと依存ファイルから再構築し、同じ確認が成功。

初回はイメージ作成中にrootが共有HOMEへ作ったnpmキャッシュでEACCESとなった。ビルド用キャッシュを `/root/.npm`、各Botのnpm/pipキャッシュをプロジェクト内 `.cache/` へ分け、修正後の二回の新規コンテナで成功した。

復元結果は各回とも `restored`、`sudo: true`、`commandEnvironment: true`、`python-package-ok`、`node-cli-ok`。復元失敗後に次のBotへ進む挙動、ログ保存、空白と改行を含む環境値は対象試験で確認した。

## 本番反映

反映前のBellTeam MCPの処理待ち一覧は空。`scripts/deploy.sh` を一回実行し、本番commit `d123bce` で反映した（開発commit `ecddddf`）。healthzは `{"status":"ok"}`、Botは8体、稼働セッション0。Aiterm 0.31.0とThroughline 0.10.14を維持した。

本番のbellユーザーで `sudo -n id -u` が0、`python3 -m pip --version` がpip 23.0.1 / Python 3.11、venvモジュールが利用可能であることを確認した。gcc・g++・make・pkg-config・cmake・rsync・rg・jq・zip・unzipの実行ファイルも存在する。Botのenvironmentフォルダ、個別のnpm導入先・npm/pipキャッシュ・PATHと、生成された共通起動時指示を確認した。チャイム個人の業務コード、既存venv、予定、MCP登録には変更を加えていない。
