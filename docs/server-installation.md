# アプリからBellTeamを使い始める

BellTeamは、自分のPCやサーバーで動くAIチームに、iPhone・iPad・Macアプリから接続して使います。アプリをダウンロードしたあと、まずサーバーを用意してください。すでにBellTeamが動いている場合は、その接続先URLをアプリへ入力すれば接続できます。

iPhone・iPadだけでサーバーを動かすことはできません。Mac、Windows PC、またはLinuxサーバーを用意します。AIサービスは自分のアカウントで利用します。

## AIにセットアップを任せる

セットアップをAIに任せる方は、GitHubのURLと「これセットアップしたい」というメッセージをAIに渡せば、大体解決します。PCやサーバーを操作できるAIへ、次の内容を渡してください。

```text
https://github.com/kitepon/BellTeam
これセットアップしたい
```

アプリの導入ガイドでは、URLと依頼文をまとめてコピー・共有できます。自分で進める場合は、以下の手順を使ってください。

## 1. PCにDockerを用意する

- **Mac**：[Docker Desktopの公式手順](https://docs.docker.com/desktop/setup/install/mac-install/)に従ってインストールし、Docker Desktopを起動します。
- **Windows**：[Docker Desktopの公式手順](https://docs.docker.com/desktop/setup/install/windows-install/)に従ってインストールします。[WSL 2の連携](https://docs.docker.com/desktop/features/wsl/)を有効にし、以後のコマンドはWSLのUbuntuなどのターミナルで実行します。
- **Linux**：[Docker Engineの公式手順](https://docs.docker.com/engine/install/)と[Composeの公式手順](https://docs.docker.com/compose/install/linux/)で準備します。

Dockerの導入条件・料金・対応OSは公式の案内を確認してください。すでにDockerとComposeが使える場合は、その環境を使えます。

## 2. BellTeamを起動する

PCのターミナルを開き、次のコマンドをまとめて実行します。Macでは「ターミナル」、WindowsではWSLのターミナルを使います。

```sh
mkdir -p ~/bellteam-server
cd ~/bellteam-server
curl -fL https://raw.githubusercontent.com/kitepon/BellTeam/main/distribution/server/compose.yaml -o compose.yaml &&
curl -fL https://raw.githubusercontent.com/kitepon/BellTeam/main/distribution/server/install.sh -o install.sh &&
sh install.sh
```

このコマンドは、ホームフォルダの`bellteam-server`へ設置用ファイルを保存し、公開コンテナの取得・起動・正常稼働の確認まで行います。初回はイメージのダウンロードに時間がかかります。エラーが出たらその表示を確認してください。Dockerへ接続できない場合は、Dockerの起動と、現在のユーザーにDockerを使う権限があるかを確認します。

ファイルを個別に保存する場合は、[compose.yaml](https://raw.githubusercontent.com/kitepon/BellTeam/main/distribution/server/compose.yaml)と[install.sh](https://raw.githubusercontent.com/kitepon/BellTeam/main/distribution/server/install.sh)を同じフォルダへ保存し、そのフォルダで`sh install.sh`を実行します。`.env`や追加機能の設定は初回には不要です。

## 3. アプリの接続先URLを入力する

起動が完了したら、アプリへ戻って「サーバーを用意済みの方」の入力欄にURLを入れます。

- **サーバーと同じMacで使う**：`http://localhost:18891`
- **iPhone・iPadや別のMacで使う**：`http://サーバーを動かすPCのIPアドレス:18891`

PCのネットワーク設定でIPアドレスを確認します。たとえばPCのIPアドレスが`192.168.1.25`なら、入力するURLは`http://192.168.1.25:18891`です。iPhone・iPadとPCは同じLAN・Wi-Fiへ接続してください。iPhoneへ`localhost`を入力すると、iPhone自身へ接続するためPCのBellTeamには届きません。

接続できないときは、PC側のブラウザで`http://localhost:18891`が開くか、PCのファイアウォールで18891番への接続が許可されているかを確認します。アプリがローカルネットワークへの接続許可を求めたら許可してください。

## 4. 最初のAIを選ぶ

接続後、Claude・Codex・Grok・Cursorから最初に使うAIを選び、案内された公式サイトで認証します。その後、案内役との会話でメンバーや追加機能を設定できます。

Webとサーバーは無料です。Appleアプリの通常のAI利用はアプリ内の購読案内に従います。案内役との初期設定、閲覧・書き出し・管理は無料で使えます。AI各社や外部サービスの契約は自分で用意してください。

## 使い続けるとき

サーバーを動かすPCやDockerを停止すると、アプリから接続できなくなります。会話・設定・AIの認証情報は設置フォルダ内の`runtime`とDocker volumeへ保存されます。更新時も保存先を残してください。

外出先からの接続と追加機能は、[初回設定と追加機能](https://github.com/kitepon/BellTeam/blob/main/docs/onboarding.md)を参照してください。同じLANからの利用は、その設定をせずに始められます。
