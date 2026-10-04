# 一般配布用サーバー

Webとサーバーは一般配布版でも無料。開発者の環境と一般配布版は、配布物に含む`src/distribution-profile.mjs`で分ける。開発者の環境ではAppleアプリの購読を免除する設定を利用できる。一般配布版では同じ環境変数を指定すると`SUBSCRIPTION_DEVELOPER_ACCESS_UNAVAILABLE`で停止する。利用者がサーバーのコードを改変する行為まで防ぐ仕組みは作らない。

## 配布物の作成

リポジトリで次の入口を一度実行する。

```sh
node scripts/package-server.mjs
```

HEADのGit commitから、製品のコード、Web UI、共通規範・モデル台帳・案内役のプロフィール、購読の接続先・商品、Dockerfileを取り出す。作業ツリーの未commit差分は含めない。展開済みの配布物、マシンへ渡せるtar.gz、ソースcommitをJSONで返す。出力先を指定する場合は、第一引数に新しいディレクトリを渡す。tar.gzにはMacの拡張属性を含めない。

個人のBot台帳は空の台帳へ置き換える。配布プロフィールは`distribution/server/`の一般配布用へ置き換え、開発者免除と開発者の通話MCP接続先を含めない。`.env`、会話、AI認証、Appleの秘密鍵、開発中の成果物は配布対象に入らない。

## 設置と確認

`./install.sh`でイメージの取得・保存先の初期化・起動・正常稼働の確認まで行う。追加機能の設定は不要で、空の保存先からWebと管理APIを使える。画面でハーネス選択と公式認証を済ませた後、案内役が利用者と会話して設定する。LANと同じマシンではHTTPで直接接続できる。詳細は [初期設定](onboarding.md) に従う。新規のbind mountをDockerがroot所有で作る場合に備え、初期化用コンテナで保存先の最上位ディレクトリをコンテナの利用者へ渡す。Linuxでroot所有のbind mountに対する`EACCES`を再現して、この初期化を追加した。

一般向けにはamd64・arm64のDockerイメージと設置用ファイルを公開する。製品ソースのリポジトリは非公開のまま保持する。`.github/workflows/publish-server-image.yml`を既定ブランチで手動実行し、各アーキテクチャの公式の現行版からイメージを作成し、配布プロフィールと空の保存先での起動を検査する。初回に登録したイメージはGitHubのpackage設定でPublicへ変更し、未認証での取得・設置までを公開の完了条件とする。作成済みの配布物、Linux試験、公開と購読試験の現在地は [subscription-setup.json](subscription-setup.json) が正本。
