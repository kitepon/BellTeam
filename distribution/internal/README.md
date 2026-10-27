# 内部運用のCompose差分

商用imageの同じdigestへ、既存の内部保存先とprofileを外付けする。一般配布の構成は `distribution/server/` のままとし、このdirectoryは `scripts/package-server.mjs` のexport対象へ加えない。秘密・runtime・profileのコピーをimageへ含めない。

内部反映担当は正規deploy入口から、次の環境で公開composeとこのoverlayを明示する。`COMPOSE_FILE`は絶対path、区切りは内部Linuxの `:` を使う。

```sh
repo=/home/kite/BellTeam
cd "$repo"
export COMPOSE_FILE="$repo/distribution/server/compose.yaml:$repo/distribution/internal/compose.overlay.yaml"
export COMPOSE_PROJECT_NAME=bellteam
export BELLTEAM_SERVER_IMAGE='ghcr.io/kitepon/bellteam-server@sha256:受入したmanifestのdigest'
export BELLTEAM_INTERNAL_PROFILE_FILE="$repo/src/distribution-profile.mjs"
```

profileは反映対象Git SHAの既存fileを使い、file hashをimage/source/archと組にして記録する。別の固定保存先を使う場合も同じ変数へ絶対pathを渡す。初回の既存profileはsource59df581/8f18bfcでSHA256 `454701c7c3dc328ae4cb095acfbf8ccc15d553a40510055e43c77a8f22f8c0c6`。public imageの同じdigestでも、mount後は実効profileが異なる。未変更のpublic実行構成とは呼ばない。

HOME/data、追加Throughline bind、既存 `bellteam_cursor-cli`、project/container名と公開composeのport/read-onlyを維持する。既存developer契約はこの内部profileで維持し、public単体のdeveloper拒否やentitledの意味を変えない。一般利用者へこのoverlayを導入条件として案内しない。

内部adapterは、候補image取得→停止前normal/専用prepare/専用maintenance captureとローカルimage ID固定→既存quiet①→Cursor updater→既存quiet②→通常本体stop→既writer検査→専用prepare→専用maintenance to-server→同保存normalでup、の順を使う。quiet②までは旧本体を止めない。公開installerの停止順は変更しない。

段2の私有親`BELLTEAM_STATE_PARENT`と控え親`BELLTEAM_MAINTENANCE_BACKUP_PARENT`は、repoの既`.env`又は呼出環境に絶対pathで明示する。host担当の準備済み親を選び、未知親を作成/adoptしない。内部legacyはrepoの`runtime/data`を渡す。overlayの六つの通常state bindと専用prepare/maintenanceが同じ私有親を使い、既writer plannerがnormal/maintenance対応とbackupの分離を確認する。異なる親や不正入力を成功に補完しない。

通常設定はrepoの実行者所有`.bellteam-compose.XXXXXX/normal.json`（directory0700/file0600）へ保存する。公開installerと同じ標準JSONの値escape/key保持を使い、既存世代を上書きしない。stop試行前の失敗は新世代を除去し、試行後は失敗しても選択設定を残す。秘密を含み得るため別途private backupへ含め、稼働/復旧に使う世代を削除しない。設定上のbind元配下は拒否するが、実alias/mount非露出、外部参照file内容、hostinodeと全writerの停止維持はこのcaptureから保証しない。失敗時に自動でupや逆移行を実行せず、実結果と選択設定を保持して最新dataからの通常復旧を判断する。

`scripts/update-cursor.sh`を実行する際も、上記環境とrepoの作業directoryを維持する。同script内の `docker compose config` が同じ2file/project/外部volumeを読む必要がある。選択imageから抽出したupdater用composeは本体composeへmergeせず、既存scriptの `-f` 指定で単独実行する。共有update-cursor.sh自体の変更はこの差分に含めない。

本overlayは事前試験/本体review向け。profile適合以外の初期認証・既存不明席回復、両arch、整合backup/volume復元、既存停止許可と稼働条件を省略するものではない。反映時は対象と試験結果をセンチへ渡し、トロニーが本体互換と反映条件を照合する。


imageを指定しない正規deployも同じadapterを使います。repoの`compose.yaml`で従来どおり`build --pull --no-cache`し、`config --images`で得たbuild tagをローカルIDへ解決してから、上記内部normal/prepare/maintenanceへ渡します。この場合registryからの再pullは行いません。明示した商用immutable imageの経路は従来どおりpullし、quiet対象必須を維持します。build経路のquiet指定は従来どおり任意ですが、今回の段2本番実行では既承認のquiet条件と具体窓を満たします。

保存世代には実行した専用`compose.state-maintenance.json`も0600で保持します。新しい.envからmaintenanceを再合成せず、同世代の固定image/二view/backup対応を逆移行の入力に使います。これだけで旧本体の起動設定を保存したとは扱いません。移行用imageと切戻し後の通常起動用imageは別に記録し、最新dataを既専用口の`to-legacy`で戻してから、対応が確認できた旧normal/旧imageで再開します。順逆どちらの失敗でも、停止・元data・途中backupと選択設定を保ち、無根拠のupや自動rollbackは行いません。実旧normalの保存と最新世代での逆移行・health受入は未完です。
