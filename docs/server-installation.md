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

インストール後、BellTeamを設置するユーザーのターミナルで次を実行します。

```sh
docker version
docker compose version
```

`docker version`にClientとServerの両方が表示され、`docker compose version`にComposeの版が表示されることを確認します。Serverへ接続できない場合はDockerの起動と利用権限を確認してください。`docker compose`が見つからない場合は、上のOS別の公式手順でComposeを導入してから進めます。LinuxでComposeを手動配置する場合も、公式手順のプラグイン配置先を使い、同じユーザーでこの2つのコマンドを確認してください。

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

### 追加設定と更新

環境変数、追加の保存先や接続port、メモリ制限、追加serviceは、設置フォルダの`compose.override.yaml`で設定できます。配布`compose.yaml`へDocker Composeが自動で設定を重ねます。[追加設定の例](https://github.com/kitepon/BellTeam/blob/main/distribution/server/README.md#composeで追加設定する)を使い、既存のoverrideがある場合は必要な項目だけを追記してください。相対pathは`compose.yaml`のフォルダが基準です。複数fileを使う場合は、同じ案内の`COMPOSE_FILE`指定を使います。

更新するときは、現在の設置フォルダで次を実行します。自分の`.env`と追加設定file、保存データを残したまま、配布2fileだけを取得し直します。実行中のメンバーは停止するため、作業を終えてから更新してください。

```sh
curl -fL https://raw.githubusercontent.com/kitepon/BellTeam/main/distribution/server/compose.yaml -o compose.yaml &&
curl -fL https://raw.githubusercontent.com/kitepon/BellTeam/main/distribution/server/install.sh -o install.sh &&
docker compose config --quiet &&
sh install.sh
```

既存のデータを使って設置フォルダだけ変える場合は、[設置フォルダを変える更新手順](https://github.com/kitepon/BellTeam/blob/main/distribution/server/README.md#設置フォルダだけを変えて更新する)に従い、同じproject名・実保存先・volume名を指定してからinstallerを実行してください。追加bindは既保存先への絶対pathへ合わせます。旧フォルダと保存世代は参照される間は保持します。新しい空の保存先への切替えを、既環境の更新として扱わないでください。

保存される解決済み設定には秘密値が含まれ得ます。設定全体や`.bellteam-compose.*`を公開の問い合わせへ貼り付けないでください。通常更新でのAI実行状態と再開の扱いは、上の更新手順を確認してください。

設置先のIP・保存先・利用するイメージの指定と、機能ごとの更新は、[サーバー配布手順](https://github.com/kitepon/BellTeam/blob/main/distribution/server/README.md)を参照してください。同梱版では、上の `sh install.sh` が本体と機能の導入プログラム、本体更新専用プログラムをまとめて起動します。追加のHost設定や別イメージの選択は不要です。初回設定の後、アプリのUpdateで対象機能の計画と結果を確認できます。本体更新用プログラムだけがDocker socketを持ち、Host上のコンテナと保存領域を操作する強い権限を使います。本体・Bot・機能導入プログラムには渡しません。本体全体の更新と、機能だけの更新はそれぞれの対応状態を確認してください。古いイメージを明示指定し `MODULE_INSTALLER_NOT_BUNDLED` と表示された場合、その版には機能の導入プログラムが含まれていません。本体の通常利用は続けられます。

外出先からの接続と追加機能は、[初回設定と追加機能](https://github.com/kitepon/BellTeam/blob/main/docs/onboarding.md)を参照してください。同じLANからの利用は、その設定をせずに始められます。
