# BellTeam サーバー

Docker Engine 26以降とvolume subpathに対応したDocker Composeを使い、自分のマシンとAIの契約で動かすBellTeamです。Dockerイメージと設置用ファイルを配布します。個人のメンバー設定や資格情報は含まれず、初回の案内役から始まります。

## 設置

アプリから初めて使う場合は、[サーバーの導入ガイド](https://github.com/kitepon/BellTeam/blob/main/docs/server-installation.md)でDockerの準備・ファイルの取得・アプリへの接続を確認してください。

1. 設置用ファイルを展開し、そのフォルダで`sh install.sh`を実行します。イメージの取得、空の保存先の所有権設定、起動と正常稼働の確認まで行います。`.env`の作成や追加機能の設定は不要です。
2. installerが表示するURLをブラウザで開きます。同じマシンでは`http://localhost:18891`、iPhone・iPadや別のMacでは`http://このマシンのLANアドレス:18891`へ接続できます。アプリの接続先にも同じURLを指定します。
3. 最初に使うClaude・Codex・Grok・Cursorを画面で選び、表示される公式サイトで認証します。公式CLIの初回設定も画面の案内に従って完了します。
4. 認証後、案内役との会話が始まります。メンバーや追加機能など、希望する使い方を案内役へ伝えて設定します。

Webアプリとサーバーは無料です。初期設定の後も、すべてのメンバーとの会話、メンバー間の配送、予定の実行を購読なしで使えます。AI各社や追加機能に使う外部サービスの契約は自分で用意します。

## 設置先とイメージの指定

通常は指定せずに設置できます。接続するIP、Compose project、保存先のvolume名、使うイメージを指定する場合は、`compose.yaml`と同じフォルダの`.env`へ記します。既存の設置では、保存先を変えると別の空の環境になるため、初回に選んだ値を保持してください。

| 入力 | 指定する値 |
| --- | --- |
| `BELLTEAM_BIND_IP` | 接続を受けるホストのIP。`127.0.0.1`などのloopbackは同じPCからだけ接続できます |
| `COMPOSE_PROJECT_NAME` | この設置を識別するCompose project名。他の設置と異なる名前を使います |
| `BELLTEAM_SERVER_STATE_VOLUME` | 本体の設定・会話などを保存する専用volume名 |
| `BELLTEAM_AITERM_STATE_VOLUME` | AI実行の状態を保存する専用volume名 |
| `BELLTEAM_SERVER_IMAGE` | 使用する公開イメージ。版を固定するときは配布元が示す`ghcr.io/kitepon/bellteam-server@sha256:…`の完全な参照を指定します |

たとえば別の設置と保存先を分け、同じPCからだけ接続する場合の`.env`は次の形です。projectとvolumeの名前は、この設置専用の名前に変えてください。

```dotenv
BELLTEAM_BIND_IP=127.0.0.1
COMPOSE_PROJECT_NAME=bellteam-lab
BELLTEAM_SERVER_STATE_VOLUME=bellteam-lab-state
BELLTEAM_AITERM_STATE_VOLUME=bellteam-lab-aiterm
```

別のIPで同じポートを使う設置がある場合、その設置側もIPを限定する必要があります。`0.0.0.0`で同じポートを使用中なら競合します。値を保存したら、同じフォルダで通常どおり`sh install.sh`を実行します。更新時にも同じ`.env`を残します。

## Composeで追加設定する

環境変数・追加mount・port・メモリ制限などは、設置フォルダに自分の`compose.override.yaml`を置いて指定します。Docker Composeが配布物の`compose.yaml`へ自動で重ねます。既存のoverrideがあれば、そのfileへ必要な項目だけを追記してください。

たとえば設置フォルダに`assets/`を作り、次の設定を保存します。`EXAMPLE_OPTION`は環境変数を渡す書き方の例です。実際に使う機能が定める変数名と値へ置き換えてください。

```yaml
services:
  bellteam:
    environment:
      EXAMPLE_OPTION: example
    volumes:
      - type: bind
        source: ./assets
        target: /opt/bellteam-assets
        read_only: true
        bind:
          create_host_path: false
    ports:
      - "127.0.0.1:18893:4180"
    mem_limit: 8g
```

この例は既存portに同じPCからの18893番の接続口を追加し、assetsを読み取り専用で公開します。メモリ上限はマシンと用途に合わせてください。相対pathは配布`compose.yaml`があるフォルダを基準にします。設定後は同じフォルダで実行します。

```sh
mkdir -p assets
docker compose config --quiet && sh install.sh
```

別imageを使う追加serviceもCompose標準の`services`へ記載できます。`module-installer`と`container-updater`は付属の導入・更新プログラムが使うservice名なので、追加serviceには別名を付けてください。保守対象の保存領域へ同時に書き込む追加serviceがあれば、更新はwriter検査で停止します。

複数の追加fileを使う場合は、`.env`に次のように記します。先頭を配布`compose.yaml`にし、自動読込みの代わりに使うfileを順番に全て指定します。Mac・Linux・WSLでは区切りは`:`です。

```dotenv
COMPOSE_FILE=compose.yaml:compose.override.yaml:compose.site.yaml
```

以後も同じ`sh install.sh`で追加設定を含めて更新します。取得し直すのは配布`compose.yaml`と`install.sh`だけです。自分の`.env`、override、追加fileと保存データは残してください。追加設定は本体と利用者のserviceへ適用し、root権限で動く付属の機能導入プログラムへ任意の環境変数やmountを引き継ぎません。

本体のdata/homeは同じ親フォルダの`data`と`home`に保ち、private state/controlのvolume・subpath・読み取り専用設定とCursor専用volume、AI状態の所有設定は配布構成の契約を維持してください。必須保存先が既設置と一致しなければ、旧本体を停止する前に拒否します。`docker compose config --quiet`は設定の構文確認で、installerの保存先検査は実行時に行います。解決済み設定や保存された`normal.json`には秘密値が含まれ得るため、ログや公開の問い合わせへ貼り付けないでください。

### 管理済みprofileを使う場合

管理者が由来と権限を確認した既存profileを使う設置では、同じoverrideの`services.bellteam.volumes`へ次の項目を加えます。sourceは管理している実fileの絶対pathへ置き換えてください。

```yaml
- type: bind
  source: /absolute/path/to/trusted/distribution-profile.mjs
  target: /app/src/distribution-profile.mjs
  read_only: true
  bind:
    create_host_path: false
```

一般配布版のdeveloper禁止は維持します。環境変数や更新要求だけで開発者免除は作れません。保存済みの設定を引き続き使い、設置場所の変更と一緒に購読environmentを変えないでください。environmentを変えると、購読署名の再検証や購入復元が必要になる場合があります。

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

### 機能を個別に更新する

更新画面では、BellTeam本体と各機能を選んで更新できます。Webでは画面上部の`Update`から開きます。機能だけの更新では、その機能の版と影響を確認します。

1. 更新したい機能を選びます。たとえば設定・認証・質問と秘密入力の機能は「利用設定」です。
2. 現在稼働している版、正式公開版、公開情報の取得状態を確認し、「更新計画を確認」を押します。
3. 計画の対象が選んだ機能だけで、表示された影響が希望どおりか確認し、「この計画で更新」を押します。本体再起動が必要と表示される計画は、機能だけの無停止更新とは異なります。
4. 「更新完了」と、実行・稼働確認の両方が「成功」になったことを確認します。受付やダウンロードの完了だけでは、更新は完了していません。

同梱版の `sh install.sh` は、同じイメージから本体、機能導入プログラム、本体更新専用プログラムを起動します。DockerやHostの追加設定、sudo、Host用ツール・unitの登録は不要です。Mac/Docker Desktop・Windows/WSL・Linuxでは、上の本体導入と同じ操作を使います。環境ごとの実物確認状況はリリースの受入記録を参照してください。

本体更新用の`container-updater`だけがDocker socketを使います。この権限はHost上のコンテナや保存領域を操作できる強い権限です。本体、Bot、機能導入用の`module-installer`にはDocker socketを渡しません。本体更新用プログラムは、画面で確認した正式な更新計画だけを受け付けます。

導入プログラムは公式の更新一覧と署名を確認してから機能を配置し、アプリが対象機能だけを交換します。本体全体のコンテナ更新は別の対応能力として表示されます。「更新を実行できません」と表示されたら、その対象の対応状態と表示されたエラーを確認してください。資格や設定を手で書き足して通す必要はありません。

`MODULE_INSTALLER_START_FAILED` の場合、本体起動後に機能導入プログラムが準備できず、installerは非0で終了しています。保存設定と元の操作結果を残して確認してください。古いイメージを明示指定した場合の `MODULE_INSTALLER_NOT_BUNDLED` は、その版に同梱されていないことを示します。通常本体の利用と機能更新の対応状態を分けて確認します。

`CONTAINER_UPDATER_START_FAILED`は、本体更新用プログラムの準備に失敗したことを示します。本体の起動状況と保存設定は残り、installerは非0で終了します。古いイメージで`CONTAINER_UPDATER_NOT_BUNDLED`と表示された場合、その版には本体更新用プログラムが含まれていません。

更新操作の結果も専用Docker volumeへ保存します。結果が不明な間はvolumeを削除しないでください。

「結果確認不能」になった場合は、新しい更新を重ねず、同じ画面で「状態を再取得」を使って元の操作の結果を確認してください。会話・設定などの保存先と、設置時の`.env`を保持します。

### 本体イメージを更新する

同梱版では、アプリのUpdateでBellTeam本体を選び、公開版と再起動の影響を確認して計画を作成します。実行中の作業を終え、表示された本体再起動を明示的に確認して実行してください。更新中は接続が切れます。再接続後は同じ操作の結果と実際に起動した版を確認します。結果不明の場合は同じ要求を再送せず、その操作結果を確認してください。

画面からの更新は、導入時に保存した追加設定と保存先を引き継ぎます。設置フォルダの`.env`やoverrideを書き換えた場合は、次の`sh install.sh`で変更を適用してください。画面から更新した後も、元の設置フォルダから公開installerを使って更新できます。

イメージ内の`/app/distribution.json`にソースのGit commitを記録しています。`docker compose exec bellteam cat /app/distribution.json`で確認できます。既定の公開タグは`latest`です。以前の`preview`も同じ検査済みイメージを指します。更新は`sh install.sh`で行います。再作成すると実行中のメンバーが停止するため、実行中の作業を確認してから行ってください。

設置には配布`compose.yaml`と`install.sh`を同じフォルダへ保存してください。自分の追加設定は上のCompose手順で併置できます。installerは取得したイメージに入っている更新手順を使うため、別のスクリプトを手で配置する必要はありません。更新時は本体を止めてからCursorを更新し、成功後に起動します。更新に失敗した場合は停止したままエラーを表示します。コンテナ本体は読み取り専用で動作し、利用者の会話・設定・追加ツールは割り当てた永続領域へ保存します。

installerは設置フォルダに新しい`.bellteam-compose.XXXXXX/normal.json`と同世代の`compose.state-maintenance.json`を作り、停止から起動まで同じ通常設定を使います。フォルダは実行者所有の0700、設定は0600で、既存の世代を上書きしません。停止を試みた後は、失敗時も選択した設定を残し、コンテナの管理情報から参照できるようにします。設定には秘密情報を含むことがあるため公開せず、`runtime/`と併せて非公開のバックアップに含めてください。稼働中または復旧中のコンテナが参照する世代は削除しないでください。逆移行には同世代の専用maintenance設定を使い、後から変更した.envで保存先を選び直さないでください。設置先は実行者が書き込める場所を使ってください。通常サービスの設定でbind元になっているフォルダの配下は拒否します。別名パスや追加mountでもコンテナから見えない設置先を選んでください。

2026年10月17日以前の設置ファイルでは、更新用スクリプトが無いというエラーで止まることがあります。その場合は[導入ガイド](https://github.com/kitepon/BellTeam/blob/main/docs/server-installation.md)の取得コマンドを同じ設置フォルダで実行し、`compose.yaml`と`install.sh`を取り直してください。`runtime`内の会話・設定は消さずに更新できます。

Claude・Codex・Grokなどのコマンドは、イメージに入っている物を全メンバーが使います。版が変わるのはイメージを更新した時です。Claude Codeはメンバーのフォルダの中で自分を更新しません（メンバーごとに版がずれるのを防ぐため）。メンバーのフォルダ（`.local`）に残っているClaude Codeの写しは、サーバーの起動時に片付けます。消すのはその写しと入口だけで、ほかのデータには触りません。詳しくは`docs/bot-environment.md`にあります。

AppleアプリはApp Storeで公開されています。Appleの実購入・復元とWSLでの動作の検証状況は、アプリとサーバーの対応する配布記録を参照してください。

### 設置フォルダだけを変えて更新する

保存データを移動せず、新しいフォルダの設置ファイルから同じ環境を更新できます。旧設置フォルダと参照中の`.bellteam-compose.*`は残します。先に旧設置フォルダで、現在のproject名と実保存先を確認してください。mountの表示には保存先とvolume名が含まれます。

```sh
cid=$(docker compose ps -q bellteam)
docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$cid"
docker inspect --format '{{json .Mounts}}' "$cid"
```

新しい設置フォルダへ[導入ガイド](https://github.com/kitepon/BellTeam/blob/main/docs/server-installation.md#2-bellteamを起動する)の2fileを取得します。まだinstallerは実行せず、既存の`.env`と追加fileを新フォルダへ配置してください。`.env`では先ほど確認した同じproject名、stateとAI stateのvolume指定、接続先とimageの指定を維持します。既設置に`.env`がなければ、現物に合わせて作成します。

新フォルダのoverrideには、既存の実保存先を絶対pathで指定します。以下のpathとCursor volume名は先ほど確認した値に置き換え、既存の追加設定へ合わせてください。

```yaml
services:
  bellteam:
    volumes:
      - type: bind
        source: /absolute/path/to/existing/runtime/home
        target: /home/bell
      - type: bind
        source: /absolute/path/to/existing/runtime/data
        target: /srv/bellteam
        bind:
          create_host_path: false
volumes:
  cursor-cli:
    external: true
    name: existing-project_cursor-cli
```

dataとhomeの親は同じ既存`runtime`にします。Throughlineの追加bindや管理済みprofileがある場合も、同じ実保存先へ絶対pathで指定し、profileの読み取り専用設定を保持します。複数Compose fileを使う場合は全fileを配置し、`COMPOSE_FILE`内のpathも新フォルダから解決できるようにします。

新フォルダで`docker compose config --quiet && sh install.sh`を実行します。旧containerの管理情報から旧設定を照合し、同じstorageを使って更新します。旧設定の本人性を証明できない場合やdata/home/Cursor/private stateが食い違う場合は、旧本体を停止する前にエラーになります。表示された不一致を確認し、既存の保存先を削除したり、空の保存先へ変更したりして通さないでください。

通常更新ではAI実行用の新しいvolumeへ切り替わり、元volumeは削除しません。旧AI volumeと旧`normal.json`は、更新後も削除・上書き・通常の掃除の対象にせず保持してください。保存済みの会話・設定・予定・作業・CLI認証と履歴は、同じ保存先を使って引き継ぎます。実行中の会話の自動再開や未保存の回答・ACKの継続を保証する手順ではありません。元の受付済み・結果不明の仕事を完了扱いにせず、同じ本文や更新要求を再送しないでください。更新前に実行中の作業を終えてください。

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

本体更新の結果と、画面から更新した時の保存世代は`<project>-container-updater` volumeにも残ります。このvolumeと参照中の保存世代を削除しないでください。控えを取る時は、このvolumeも非公開の保存先へ含めます。

移行は異なるfilesystem間でもcopyし、公開先の全bytesを確認してから元を`retired/<操作ID>/`へ退避します。退避した原本は移行時点の控えで、移行後の新しい会話を含むbackupではありません。正常移行と必要な控えの確認後にだけ整理してください。

移行中はdataフォルダと記録fileを原子的に交換し、旧版・新版が不完全な状態で起動することを防ぎます。交換に対応しないfilesystemでは、dataを動かす前に停止します。途中で止まった場合は原因を解消し、同じ`install.sh`を再実行してください。記録fileの手動削除やdataの型変更で解除しないでください。内容の異なる同名fileは上書きせず両方を保持するので、残す内容を確認してから不要側だけを整理して再開します。

前の版へ戻す場合は、更新時に表示された保存世代を指定します。

```sh
sh install.sh --recover .bellteam-compose.対象世代
```

現在の会話・予定を含むdataを戻し、保存した旧imageと設定で起動します。古いbackupへ巻き戻す操作ではありません。旧設定を証明できなかった世代では復旧を拒否し、保存したcontainer原本を案内します。旧profileの実fileを別世代から参照している場合、その世代も保持してください。

WindowsではWSLのLinux filesystem内へ設置してください。Mac Docker Desktopでは本体専用データをEngine内volumeへ分離します。環境ごとの実移行・復旧の受入状況は対応するリリース記録を確認してください。
