# 内部運用のCompose差分

商用imageと同じdigestへ、内部profile、既存HOME/data、Throughline bind、Cursorの外部volumeを追加する。秘密・runtime・内部profileを公開imageへ含めない。`scripts/deploy-image.sh`はimageの取得/build後に、公開`distribution/server/install.sh`をこのoverlayと組み合わせて呼ぶ。公開と内部で移行・復旧の実装は共通。

```sh
repo=/home/kite/BellTeam
cd "$repo"
BELLTEAM_SERVER_IMAGE='ghcr.io/kitepon/bellteam-server@sha256:採用digest' sh scripts/deploy-image.sh
```

正規の遠隔入口は`scripts/deploy.sh`。checkout変更前に実旧normalをCompose label/hashで照合し、実profile bytesとraw image、稼働CID/開始時刻を保存する。内部adapterは`BELLTEAM_PREVIOUS_COMPOSE`からその原本を公開installerへ渡す。profileは保存世代の実fileを引き続き参照するため、新旧どちらのmodelが参照する世代も削除しない。

通常の流れは固定normal/maintenance保存→実旧normal保存→exact CID停止/確認→writer検査→prepare→to-server→Cursor更新→同normalでhealth付き起動。毎回のquiet待機、image/Cursor全量archive、別Python actor/token/journalは置かない。日常のbackupは既存のbackup運用を継続し、移行のgateと混ぜない。

復旧は今回の保存世代を明示する。

```sh
sh scripts/deploy-image.sh --recover /home/kite/BellTeam/.bellteam-compose.対象世代
```

最新dataを旧layoutへ寄せて保存旧normalを起動する。旧layoutへ戻す場合は現CIDの停止確認後にrestart無効化・container削除を行い、同CIDの遅延start先を残さない。volumeやdataは削除しない。新layoutの世代へ戻す時も、途中の移行があればその向きへ収束させる。自動rollback・自動retryは行わない。

`runtime/server-only/state-data`をroot:1001/0750としてdirectory lockを取り、六つの本体stateをUID1001へ分ける。保守は`runtime`一つをbindし固定codeだけでdata/stateを移す。HOMEはmount内にあるが移行対象ではない。移行途中はdata rootをroot:root/0700にsealするため、旧imageも新imageも起動できない。手でchmodを戻さず、失敗原因を修理して同installerを再実行する。衝突した別内容は双方残し、保持する側を決めてから再開する。

本変更の実コンテナ移行・両復旧・全writer/CLI・Mac filesystemの受入は別の実行原本で確認する。source試験だけで本番へ反映しない。反映担当はトロニー、独立採否はセンチ、OS管理は各host担当。
