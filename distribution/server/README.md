# BellTeam サーバー

Docker Engine 26以降とvolume subpathに対応したDocker Composeを使い、自分のマシンとAIの契約で動かすBellTeamです。Dockerイメージと設置用ファイルを配布します。個人のメンバー設定や資格情報は含まれず、初回の案内役から始まります。

## 設置

アプリから初めて使う場合は、[サーバーの導入ガイド](https://github.com/kitepon/BellTeam/blob/main/docs/server-installation.md)でDockerの準備・ファイルの取得・アプリへの接続を確認してください。

1. 設置用ファイルを展開し、そのフォルダで`./install.sh`を実行します。イメージの取得、空の保存先の所有権設定、起動と正常稼働の確認まで行います。`.env`の作成や追加機能の設定は不要です。
2. installerが表示するURLをブラウザで開きます。同じマシンでは`http://localhost:18891`、iPhone・iPadや別のMacでは`http://このマシンのLANアドレス:18891`へ接続できます。アプリの接続先にも同じURLを指定します。
3. 最初に使うClaude・Codex・Grok・Cursorを画面で選び、表示される公式サイトで認証します。公式CLIの初回設定も画面の案内に従って完了します。
4. 認証後、案内役との会話が始まります。メンバーや追加機能など、希望する使い方を案内役へ伝えて設定します。

Webアプリとサーバーは無料です。初期設定の後も、すべてのメンバーとの会話、メンバー間の配送、予定の実行を購読なしで使えます。AI各社や追加機能に使う外部サービスの契約は自分で用意します。

## 追加機能と接続

追加機能は未設定のまま無効になります。設定画面または案内役との会話から、使う機能だけを設定できます。必要な秘密情報は専用の入力カードへ登録します。

| 追加機能 | 必要な設定 |
| --- | --- |
| 返信者の自動選択 | TypeSafeのAPIキー |
| 通話 | 自分が設置する通話MCPの接続先と合言葉 |
| 外部接続 | Cloudflare Accessのチームドメイン・audience・公開URL |
| 診断連携 | 診断APIの合鍵 |
| 通知 | 運営の通知送信サービスの接続先 |

直接接続で始められます。外部から接続するときはCloudflare TunnelとAccessを設定し、Tunnelの転送先をこのマシンの18891番ポートにします。通話MCPのimageは別の公開製品です。任意の[Bridge配布構成](bridge/README.md)を使うと、単独serviceとして導入・更新でき、選んだ場合だけBellTeamへ接続できます。設定後に各メンバーのCLIへ登録します。詳しい設定仕様は[初回設定と追加機能](docs/onboarding.md)を参照してください。

特定のIPアドレスへ接続を限定するときだけ、`.env.example`を`.env`へコピーし、`BELLTEAM_BIND_IP`を指定します。既存の環境変数による追加機能の設定は初回に保存済み設定へ移行し、以後は画面の設定を使います。

## 購読とデータ

iPhone・Macアプリからの通常の会話と予定操作は共通の月額購読を使います。台数制限はありません。初期設定の案内役との会話、閲覧・書き出し・管理は無料です。Webで使ってからAppleアプリの購入を選べます。購読の確認先と商品は配布物内の`services/subscriptions/`に含まれています。Appleの秘密鍵は運営の通知送信サービスが持ち、利用者のコンテナへ配布しません。

一般配布版は開発者免除を受け付けません。`BELLTEAM_SUBSCRIPTION_ACCESS_MODE=developer`を指定すると`SUBSCRIPTION_DEVELOPER_ACCESS_UNAVAILABLE`で起動を停止します。

購読が終了しても、Webからの会話と設定済みの予定は動き続けます。Appleアプリでも保存済みの会話の閲覧とJSON書き出しは利用できます。会話・設定は本体専用の`server-state` volume、メンバーの作業とAIの認証情報は自分の`runtime/`へ保存されます。更新時にも両方を保持します。

## 版の確認と更新

イメージ内の`/app/distribution.json`にソースのGit commitを記録しています。`docker compose exec bellteam cat /app/distribution.json`で確認できます。既定の公開タグは`latest`です。以前の`preview`も同じ検査済みイメージを指します。更新は`./install.sh`で行います。再作成すると実行中のメンバーが停止するため、実行中の作業を確認してから行ってください。

設置には`compose.yaml`と`install.sh`だけを同じフォルダへ保存してください。installerは取得したイメージに入っている更新手順を使うため、別のスクリプトを手で配置する必要はありません。更新時は本体を止めてからCursorを更新し、成功後に起動します。更新に失敗した場合は停止したままエラーを表示します。コンテナ本体は読み取り専用で動作し、利用者の会話・設定・追加ツールは割り当てた永続領域へ保存します。

installerは設置フォルダに新しい`.bellteam-compose.XXXXXX/normal.json`と同世代の`compose.state-maintenance.json`を作り、停止から起動まで同じ通常設定を使います。フォルダは実行者所有の0700、設定は0600で、既存の世代を上書きしません。停止を試みた後は、失敗時も選択した設定を残し、コンテナの管理情報から参照できるようにします。設定には秘密情報を含むことがあるため公開せず、`runtime/`と併せて非公開のバックアップに含めてください。稼働中または復旧中のコンテナが参照する世代は削除しないでください。逆移行には同世代の専用maintenance設定を使い、後から変更した.envで保存先を選び直さないでください。設置先は実行者が書き込める場所を使ってください。通常サービスの設定でbind元になっているフォルダの配下は拒否します。別名パスや追加mountでもコンテナから見えない設置先を選んでください。

2026年10月17日以前の設置ファイルでは、更新用スクリプトが無いというエラーで止まることがあります。その場合は[導入ガイド](https://github.com/kitepon/BellTeam/blob/main/docs/server-installation.md)の取得コマンドを同じ設置フォルダで実行し、`compose.yaml`と`install.sh`を取り直してください。`runtime`内の会話・設定は消さずに更新できます。

Claude・Codex・Grokなどのコマンドは、イメージに入っている物を全メンバーが使います。版が変わるのはイメージを更新した時です。Claude Codeはメンバーのフォルダの中で自分を更新しません（メンバーごとに版がずれるのを防ぐため）。メンバーのフォルダ（`.local`）に残っているClaude Codeの写しは、サーバーの起動時に片付けます。消すのはその写しと入口だけで、ほかのデータには触りません。詳しくは`docs/bot-environment.md`にあります。

AppleアプリはApp Storeで公開されています。Appleの実購入・復元とWSLでの動作の検証状況は、アプリとサーバーの対応する配布記録を参照してください。

## ソースから構築する

公開済みDockerイメージを使う場合は、上の設置手順だけで導入できます。ソースから構築する場合は、DockerとComposeに加えてGitとNode.js 24以上を用意し、配布用の構成を生成します。リポジトリ直下のComposeとprofileは開発者の運用向けです。

```sh
git clone https://github.com/kitepon/BellTeam.git
cd BellTeam
mkdir -p runtime
source_work=$(mktemp -d "$PWD/runtime/source-build.XXXXXX")
node scripts/package-server.mjs "$source_work/context"
docker build --pull --no-cache -t bellteam-server:local "$source_work/context"
mkdir -p ../bellteam-server
cp "$source_work/context/compose.yaml" "$source_work/context/install.sh" ../bellteam-server/
cd ../bellteam-server
BELLTEAM_SERVER_IMAGE=bellteam-server:local sh install.sh --no-pull
```

`package-server.mjs`はcommit済みのソースを取り出し、空のメンバー構成と一般配布用profileに差し替えます。作業中の未commit変更は入りません。生成したcontextとarchiveはビルド用で、会話や認証情報を置く設置フォルダとは分けます。

`--no-pull`は指定したローカルイメージを使い、通常のinstallerと同じ手順で保存先の準備・Cursor更新・起動を行います。イメージが無ければ、既存のBellTeamを停止する前にエラーになります。これは完全なオフライン導入ではなく、ビルドとCursorの公式更新には通信が必要です。

ソース版を更新するときは、リポジトリで`git pull --ff-only`したあと、`mkdir -p runtime`からの手順をもう一度実行します。設置先の`bellteam-server/runtime`とDocker volumeは残してください。別の設置フォルダを使っている場合は、コピー先と移動先をそのフォルダへ合わせます。ローカル版を使い続ける場合は、更新時も`BELLTEAM_SERVER_IMAGE=bellteam-server:local sh install.sh --no-pull`を指定してください。

## 移行と復旧

本体専用の設定・会話・予定は、外部volume `bellteam-server-state` に保存します。初回に実際の権限拒否を検査し、Linuxなどでは`runtime/server-only/state-data/`をvolumeの実体にします。Mac Docker Desktopなど共有フォルダの権限が効かない環境では、Docker Engine内のvolumeを使います。`runtime/home/`とメンバーの作業フォルダは保持します。別名volumeを使う場合は`BELLTEAM_SERVER_STATE_VOLUME`を初回から指定し、保存した設定と同じものを使ってください。

`docker compose down -v`でもこの外部volumeは残ります。`docker volume rm`で削除すると本体の状態が失われるため、削除しないでください。控えを取る場合は`runtime/`全体と参照中の`.bellteam-compose.*`に加え、volumeも非公開の保存先へ残します。volumeの控えは、利用中のimageからvolumeを読み取り専用でmountし、`tar`で保存できます。旧imageと保存世代は復旧が不要になるまで保持してください。

移行は異なるfilesystem間でもcopyし、公開先の全bytesを確認してから元を`retired/<操作ID>/`へ退避します。退避した原本は移行時点の控えで、移行後の新しい会話を含むbackupではありません。正常移行と必要な控えの確認後にだけ整理してください。

移行中はdataフォルダと記録fileを原子的に交換し、旧版・新版が不完全な状態で起動することを防ぎます。交換に対応しないfilesystemでは、dataを動かす前に停止します。途中で止まった場合は原因を解消し、同じ`install.sh`を再実行してください。記録fileの手動削除やdataの型変更で解除しないでください。内容の異なる同名fileは上書きせず両方を保持するので、残す内容を確認してから不要側だけを整理して再開します。

前の版へ戻す場合は、更新時に表示された保存世代を指定します。

```sh
sh install.sh --recover .bellteam-compose.対象世代
```

現在の会話・予定を含むdataを戻し、保存した旧imageと設定で起動します。古いbackupへ巻き戻す操作ではありません。旧設定を証明できなかった世代では復旧を拒否し、保存したcontainer原本を案内します。旧profileの実fileを別世代から参照している場合、その世代も保持してください。

WindowsではWSLのLinux filesystem内へ設置してください。Mac Docker Desktopでは本体専用データをEngine内volumeへ分離します。環境ごとの実移行・復旧の受入状況は対応するリリース記録を確認してください。
