# 段2の停止中移行の呼出し

Draft PR42 の途中工程。利用者分離全体はまだ NOTDEPLOYABLE であり、この変更だけを main や本番へ出さない。

公開 installer は Compose の停止成功、全 writer の停止確認、既存の root ディレクトリ準備の後に、image 内の `/usr/local/bin/node /app/src/server-state-transfer.mjs to-server` を UID/GID 0:0 で呼ぶ。通常の server entry は引数を受け取らず UID1001 で起動するため、保守ではこの固定 Node entry を明示する。

移行先は既存 component と同じ `/srv/bellteam`。引数は `to-server` または `to-legacy` 一つだけで、外部 path・code・設定を指定できない。実 UID/GID と実効 UID/GID は root を要求する。エラーは code だけを出し、文書本文・headers・path を出さない。移行が失敗したら installer は終了し、Cursor 更新と新旧本体の起動を行わない。途中ファイルや marker は既存 component の再開契約に従う。

逆方向も現在の正本から移す。昔の backup を戻して予定・AI停止状態・Bot 増減を巻き戻す処理は加えていない。installer の自動逆移行も行わない。

移行後の同じ root 保守口で、本体5状態と APNs 親を UID/GID1001 へ準備する。上位は0711、内部 dir0700/file0600、call-bridge と socket の親は0711。data/bots/shared/tools の席側祖先は1000:1000/0711を保つ。HOME・CLI資格・Bot文書・memory/RAG・外側BugHubは再帰対象にしない。全対象のリンク/特殊ファイルを先に拒否し、metadata変更はNOFOLLOWで開いた同一inodeへ行う。逆方向は現在の内容を変えずUID1000へ戻す。

逆移行で旧側へ戻った初期化印・台帳・予定・画像・共有文書もUID1000へ戻す。Bot project は戻った固定の metadata と画像だけを扱い、文書やmemoryを再帰しない。固定の文書pathにdirectoryが置かれた場合も拒否する。実 filesystem の順逆移行を結合し、最新のBot増減・予定・AI停止状態が残ることを確認する。

検証は人工 Docker の installer 呼出し順序・移行失敗の終了 code と後続未実行、実 filesystem 上の component の順逆移行・最新状態・故障時の保持、CLI の不正引数・非 root identity 拒否。所有準備の人工filesystem試験ではchownだけを記録に置き換え、mode変更・範囲除外・link拒否・inode交代・handle回収は実 filesystem で確認した。root CLI と実UID変更のcontainer実行、独立 bind mount、制限された backup、fresh install supervisor、PGID receipt、4 CLI と停止時間は別の未完工程。これらを揃えてから段2全体を受け入れる。

## 制限された移行前控え

固定root入口は内容移行より前に /srv/bellteam-maintenance-backups のroot専用親を要求する。5状態と旧Bot台帳/予定/画像/初期化印・4共有文書だけを各方向の before-to-server / before-to-legacy へ新規保存する。HOME/CLI資格・席docs/memory/RAG・外部BugHub・APNs鍵本文は控えに含めない。APNs原本はその場に保ち、既所有準備の対象のまま。root専用親の祖先/ACL/排他/独立bindはhost担当と別途確認する。

親0700/実行者UIDGID一致、内部dir0700/file0600、symlink/hardlink/special拒否、容量不足と書込み/sync/元更新は移行前に終了する。全FDを閉じ、コピーと親directoryのsync後にのみprivate complete.jsonを確定する。失敗した控えは消して再作成せず不完全のまま保持し、既存complete/partialの同方向控えも自動上書きしない。再開は残った正本・控えと停止状況を担当が判断する。戻しは常に最新stateのto-legacyであり、この控えの自動restoreではない。控えの秘密本文/長さ/hashは通常結果へ出さない。

現在のinstallerは専用backup bindをまだ持たず、固定入口はその不足を読書き前に拒否する。通常serviceへbackup bindやroot資格を渡す追加はしていない。専用保守Composeとfreshcreate/独立bind/実root受入/容量・保持期間・回収担当の確定が残るので、Draft NOTDEPLOYABLEを維持する。

## 独立6領域への内容移動

固定保守口は旧view /srv/bellteam-legacy と新view /srv/bellteam が同じdata祖先inodeであることを先に確認する。新viewの6targetだけは別の専用host sourceを重ねる。各6leafのsource/targetが同inodeなら拒否し、mounted root自体はrmdirしない。旧新両viewをbackup親のlegacy/server別区画へ控え、両方成功するまで内容を移さない。途中世代に片方だけ残った現在値も隠さず保存するためである。

forwardは6領域移動→既台帳予定画像transfer→新側所有、reverseは最新metadata transfer→6領域を旧側へ移動→旧側所有。異なる同名内容は衝突として両方残し、暗黙上書きや旧backup復元をしない。既moveFile/moveTreeの内容確認・fsync・途中再開契約を共有し、通常のmetadata移動では従来どおり元subdirを退役する。固定root CLI以外からpath/コードを渡す口は作っていない。

この段階は普通の人工filesystemでの内容・順序の受入であり、二つのdata viewと6独立bindの実mount受入ではない。固定prepare/maintenance Compose、writer分母/排他・専用親ACL/祖先alias・通常側への旧view/backup非露出・外側socket重ね順は未実装で、既installerは依然この保守口を実行できない。全体NOTDEPLOYABLEを維持する。

## 空の専用6領域を先に準備する部品

`compose.state-prepare.yaml` は通常serviceとmergeせず、host担当が既にroot:root0700で用意・排他した専用親だけを `/srv/bellteam-state-parent` へRW bindする。HOME/data/backup/資格/port/environment/env_file/Docker socketは渡さず、固定 `/usr/bin/env -i PATH=... node /app/src/server-state-prepare.mjs` だけを起動する。imageの既定entryを使わず、追加引数・実/実効UIDGID0以外は親へ触る前に拒否する。networknone/RO/NNP、CPU1/RAM2GiB=swap/PIDs512、tmpfs64MiB。chmodを元root所有の間に済ませてから1001へchownするため、cap_drop ALLから追加するcapはCHOWNだけとし、実kernel/Compose互換は別受入で確認する。

専用親に未知の内容や記録のない既存leafがあれば取り込まず終了する。空の場合だけstate/rooms/owner/logs/bellteam-settings/apnsの6dirを711・1001:1001へ準備し、同期後に親とleafのdev/inodeをroot専用600の `.prepared.json` へ確定する。既存はこの記録・inode・owner/modeが一致する場合だけ再利用し、inode交代や途中失敗を再帰chownや初期化で隠さない。失敗時は完了印なし・FDを閉じて未完を保持し、通常起動へ進めない。既存stateの内容は読まない。

人工FS確認ではchownとそのowner stat値だけを置換し、mode/inode/link/fsync/FD closeは実filesystemで確認した。CLIのroot拒否も人工identityで確認する。新YAMLはsource静的確認まで、実Compose parse/実UID/capability/mountは未受入。通常installerの接続、二view維持・writer分母・新旧通常非同時起動を含む全構成は未完成で、DraftNOTDEPLOYABLEを維持する。

## 二viewと6bindの固定保守構成

`compose.state-maintenance.json` はComposeが読めるJSON形式で、通常serviceを継承しない別の固定root serviceだけを定義する。旧dataを `/srv/bellteam-legacy` と `/srv/bellteam` の両方へ渡し、新viewの6targetへprepared専用leafを重ね、backup親を保守口へだけ渡す。すべてbindのcreate_host_path=falseで、未知親をDockerに作らせない。HOME/CLI資格/通常env/port/socketは供給しない。entryはenv-i固定Node、既存CLIのto-serverを既定とし、最新逆移行は同入口へto-legacy一引数だけを指定する。通常installerへの接続と通常service側6bindの供給は、まだ行わない。

旧UID1001/0700の内容へのアクセスと内容移動にはDAC_OVERRIDE、既所有処理のchownとchown後chmodにはCHOWN/FOWNERを必要とするため、この保守serviceだけcap_drop ALLから3capを付ける。RO/networknone/NNP、CPU1/RAM2GiB=swap/PIDs512を宣言する。これらはsource上の必要権限であり、実kernel/Compose互換の受入は別工程。通常serviceへrootや追加capを渡さない。

`assert-state-writers-stopped.sh --maintenance` は固定normal Composeとこの保守Composeの正規化metadataを既存parserへ渡す。writer planに旧data/HOME/Cursor・新6sourceとbackupを含め、別名bind/local volume backingも既canonical照合で拒否する。正常serviceの6bindが一つでもあれば全6が必要で、保守側の欠測/RO/余分なmountも拒否する。JSON側はproject名を宣言せず、確認時に既存Cursor volumeのproject名を変えない。planへ環境/資格は出力しない。

これはwriterのDocker分母と保守source宣言まで。host専用親のACL/祖先差替え/別alias、host上の非参加writer、prepareからbackup/移行/通常起動までの同一排他、通常側legacy/backup非露出と外側socket重ね順は別の未完条件である。lockや停止snapshotだけで移行中の排他成立とせず、実UID/rootcontainer/独立bindとfreshinstall等が揃うまでwhole NOTDEPLOYABLEを維持する。
# Normal state mounts (2026-10-26 source delta)

The repository and public normal Compose files now bind the same six prepared
`runtime/server-only/state-data` leaves at the maintenance targets. All six use
`create_host_path: false`; none expose the legacy or backup view. The existing
HOME/Cursor/Throughline and optional external Bridge/socket definitions remain
in place. An unprepared installation must not create these leaves implicitly.

The shared writer-plan parser checks normal/maintenance source correspondence,
the shared legacy-data backing, separation from old data/HOME and other leaves,
and backup non-exposure, including a readonly backup bind at another target.
These are configured paths; host canonical identity, ancestor ACL/alias safety,
actual mount ordering and a retired old-state view still require real acceptance.

The old installer is still missing the fixed prepare/maintenance flow and shared
exclusion. This branch remains Draft NOTDEPLOYABLE. These source changes do not
authorize applying the normal Compose files or starting either server view.

## 呼出し元の通常Composeを保つ（2026-10-26）

保守writer検査は、呼出し元が明示した `COMPOSE_FILE` の末尾へ固定 `compose.state-maintenance.json` を追加する。未指定時はこの配布の既定 `compose.yaml` を使い、`COMPOSE_PATH_SEPARATOR` と既存 `COMPOSE_PROJECT_NAME` を保持する。旧実装の固定 `-f compose.yaml` は通常側の明示overlayを落としていたため、実際のsource分母を検査できないことがあった。

新しい人工CLI反例は二つの通常ファイルと区切り `:` / `;` を使い、projectを保持した合成先と、config失敗時に後続を発行しない境界を確認する。Docker実行の代わりに固定metadataだけ返すfakeを使う。実Compose renderや `.env` のみからの別 `COMPOSE_FILE` 選択を受け入れた証拠にはしない。次の固定installer/host actorは通常file列を明示して、この境界へ接続する。

区切りの仕様は [Docker Composeの公式資料](https://docs.docker.com/compose/how-tos/environment-variables/envvars/) を参照した。全writerの実排他・host親の安全性・通常起動までの呼出しは引き続き未完成で、whole NOTDEPLOYABLEを維持する。

## Host排他部品（2026-10-26、まだcaller未接続）

内部専用 `distribution/internal/sec014-host-control.py` はEmma合意の固定root親とsec014.lockを扱う。rootでない通常入口はhost pathへ触る前に拒否する。既準備root0700親、root0600/regular/nlink1の固定lockをNOFOLLOW/CLOEXECで開き、非blocking flockを一回取得し、同inodeのFDをcontext全区間で保持する。lockを削除/replaceして作り直さない。子へexec継承させず、通常public installerは変更しない。

forward/reverseは同lockを使う。phase印はprepare/writer停止/移行/bind確認/起動/結果確認の順だけを許し、全部の正のreceiptをcallerが確認した後だけcompletedへ進める。component自体は各phaseを実行せず、Pythonの正常returnや親死亡によるlock解放を完了にしない。不完全journalがあれば両方向の新処理を拒否し、先行journalや未完daemonを上書きしない。

この一回移行の記録はdirectionごとに保持し、同directionの再発行は完了済みでも拒否する。将来の別移行は、最新state/既journal/世代を照合する復旧計画を完成させてから扱う。自動journal削除や古いbackupの復元は加えていない。

新人工は普通の一時filesystemと実kernel flock/forkを使うが、metadataの期待UID/GIDだけ試験利用者へ注入する。固定root入口の実UID/chown/capabilityや主機root親を受け入れた意味ではない。FD非継承、双方向排他、順序違い・親/lock inode差替え・link/hardlink/owner/mode拒否、親死亡後のincomplete保持を確認する。

実Docker/installer固定flow・全writer分母/非参加writer停止・通常deploy/復旧/backup回収の参加接続・host祖先ACL/alias・実mount照合は未接続。配布packagerへこの未完成host部品を加えず、public installerも変更しない。whole NOTDEPLOYABLEのまま、次はこの部品を固定host actorの正のphase receiptへつなぐ。
