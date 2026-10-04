出典: [Docker公式の導入入口](raw/official-guide-links.md)、[HomebrewのDocker Compose](https://formulae.brew.sh/formula/docker-compose)
取得日: 2026-10-05
確度: 一次資料とHomebrewの導入案内、iOS画面試験、Mac Catalystビルドで確認

# アプリから自分のサーバーへ接続するまで

サーバーへの接続前に、アプリだけをダウンロードした人が読める導入案内を用意する。BellTeamは`docs/server-installation.md`をAppleアプリへ同梱し、公開GitHubでも同じ内容を読む。最初の入口は未導入者向けの案内と、稼働中のサーバーへ接続するURL入力を分ける。

Mac・WindowsではDocker Desktopの公式手順を参照し、WindowsのコマンドはWSL内で実行する。既存のDocker環境を使う時も、`docker compose`が使えることが必要になる。HomebrewのComposeは、導入済みでもDockerがプラグインの保存先を知らなければ`docker compose`で見つからない。公式のHomebrew案内はDockerの`cliPluginsExtraDirs`へプラグインディレクトリを登録する方法を示す。

クライアントとサーバーが同じMacならlocalhostを使う。別の端末では、サーバーを動かすPCのLANアドレスを使う。iPhoneのlocalhostはiPhone自身を指すため、PCのサーバーの接続先にはならない。

## 実サーバーへの接続試験

[Apple公式の試験環境の指定](raw/apple-test-runner-env.md)に従い、試験プロセスへ渡す環境変数には`TEST_RUNNER_`を付ける。試験コードでは接頭辞が取り除かれた名前を参照する。UI試験の対象アプリへ渡す値は`XCUIApplication.launchEnvironment`で設定する。

BellTeamではinstallerで起動した空のサーバーへ、初回画面でURLを入力して接続し、4つのAIを選ぶ画面まで進めるUI試験を通した。認証は開始せず、個人の設定を使わない。
