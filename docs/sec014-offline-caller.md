# 段2の停止中移行の呼出し

Draft PR42 の途中工程。利用者分離全体はまだ NOTDEPLOYABLE であり、この変更だけを main や本番へ出さない。

公開 installer は Compose の停止成功と既存 writer 検査の後に、選択image内の固定 `state-prepare` serviceを引数無しで実行し、成功後だけ固定 `state-maintenance` serviceへ `to-server` を渡す。どちらも通常projectを明示した専用file単独で、通常serviceへのroot/entrypoint指定とHOME/data親の一括chownは行わない。実排他の維持と通常再開の受入は未完であり、検査snapshotだけを実行許可にしない。

2026-10-27のprepare接続は、host担当が準備済みの絶対 `BELLTEAM_STATE_PARENT` と既backup/legacy入力を使う。専用親をinstaller/Dockerに自動作成させず、既prepareのroot:root0700/空親又は記録一致の条件を維持する。prepare失敗時の途中leafや印は残して終了し、移行/Cursor/通常起動へ進めない。二つの固定fileは同じ受入imageから抽出する。入力の再読取とwriter lifetime/respawnの共通排他は未接続で、以下の過去工程の記述を全体の実受入へ読み替えない。

installerは選択imageを資材抽出より前に一度ローカルimage IDへ解決し、既 `BELLTEAM_SERVER_IMAGE` として渡す。抽出・固定prepare/maintenanceはこのIDを使い、標準normal Composeもこの値を補間する。保守writer検査は通常設定が選ぶimageの解決IDとcallerの選択IDを照合し、異なればreaderやprepareへ進まない。名前が同じtagを再解決して別imageを使うことを防ぐ限定差分で、配布manifest/sourceの受入やconfig/対象pathのlifetime固定を追加しない。独自overlayが後からimageを上書きする場合や外部設定の変更、writer再起動は別の未成立条件のまま。

移行先は既存 component と同じ `/srv/bellteam`。引数は `to-server` または `to-legacy` 一つだけで、外部 path・code・設定を指定できない。実 UID/GID と実効 UID/GID は root を要求する。エラーは code だけを出し、文書本文・headers・path を出さない。移行が失敗したら installer は終了し、Cursor 更新と新旧本体の起動を行わない。途中ファイルや marker は既存 component の再開契約に従う。

逆方向も現在の正本から移す。昔の backup を戻して予定・AI停止状態・Bot 増減を巻き戻す処理は加えていない。installer の自動逆移行も行わない。

移行後の同じ root 保守口で、本体5状態と APNs 親を UID/GID1001 へ準備する。上位は0711、内部 dir0700/file0600、call-bridge と socket の親は0711。data/bots/shared/tools の席側祖先は1000:1000/0711を保つ。HOME・CLI資格・Bot文書・memory/RAG・外側BugHubは再帰対象にしない。全対象のリンク/特殊ファイルを先に拒否し、metadata変更はNOFOLLOWで開いた同一inodeへ行う。逆方向は現在の内容を変えずUID1000へ戻す。

逆移行で旧側へ戻った初期化印・台帳・予定・画像・共有文書もUID1000へ戻す。Bot project は戻った固定の metadata と画像だけを扱い、文書やmemoryを再帰しない。固定の文書pathにdirectoryが置かれた場合も拒否する。実 filesystem の順逆移行を結合し、最新のBot増減・予定・AI停止状態が残ることを確認する。

検証は人工 Docker の installer 呼出し順序・移行失敗の終了 code と後続未実行、実 filesystem 上の component の順逆移行・最新状態・故障時の保持、CLI の不正引数・非 root identity 拒否。所有準備の人工filesystem試験ではchownだけを記録に置き換え、mode変更・範囲除外・link拒否・inode交代・handle回収は実 filesystem で確認した。root CLI と実UID変更のcontainer実行、独立 bind mount、制限された backup、fresh install supervisor、PGID receipt、4 CLI と停止時間は別の未完工程。これらを揃えてから段2全体を受け入れる。

## 制限された移行前控え

固定root入口は内容移行より前に /srv/bellteam-maintenance-backups のroot専用親を要求する。5状態と旧Bot台帳/予定/画像/初期化印・4共有文書だけを各方向の before-to-server / before-to-legacy へ新規保存する。HOME/CLI資格・席docs/memory/RAG・外部BugHub・APNs鍵本文は控えに含めない。APNs原本はその場に保ち、既所有準備の対象のまま。root専用親の祖先/ACL/排他/独立bindはhost担当と別途確認する。

親0700/実行者UIDGID一致、内部dir0700/file0600、symlink/hardlink/special拒否、容量不足と書込み/sync/元更新は移行前に終了する。全FDを閉じ、コピーと親directoryのsync後にのみprivate complete.jsonを確定する。失敗した控えは消して再作成せず不完全のまま保持し、既存complete/partialの同方向控えも自動上書きしない。再開は残った正本・控えと停止状況を担当が判断する。戻しは常に最新stateのto-legacyであり、この控えの自動restoreではない。控えの秘密本文/長さ/hashは通常結果へ出さない。

installerはimage-owned専用保守serviceからbackup bindを供給する。通常serviceへbackup bindやroot資格を渡さない。prepare/実排他、freshcreate/独立bind/実root受入/容量・保持期間・回収担当の確定は残るので、Draft NOTDEPLOYABLEを維持する。

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

The installer still lacks the prepare flow and shared exclusion through normal
restart. This branch remains Draft NOTDEPLOYABLE. These source changes do not
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

## 正のphase receiptを扱う固定caller（sourceのみ）

内部のsec014-host-actor.pyは既host_controlの親lockFDを全区間保持し、全writer確認→prepare→両viewbackupを含む現在directionの移行→bind確認→許可された片方normal起動→結果確認の6メソッドだけを正順で呼ぶ。各結果は同direction/image/actor PID出生/phaseとverified状態、工程固有の証拠SHA集合がそろった時だけroot専用0600 sidecarへO_EXCLで保存・fsync・metadata再読し、その後でjournalのphaseを進める。拒否/例外/receipt保存失敗では後続を呼ばずincompleteを保持する。最新reverseも同lock/別directionであり、旧backupの自動restoreはしない。

証拠SHAは実証拠の参照形式であって、値を受け取るだけで証拠本文の意味やOwner裁定を独立確認したものではない。executorはtrustedな内部製品実装が実artifact/host担当原本/個別許可を検証してからreceiptを生成する責務を持つ。このdeltaは固定順序とreceipt保存のconsumerだけで、その実executor、Docker PID/terminal/CIDunknown照合、host source/許可の検証と全writer参加は未実装。production CLI、public installerへの接続、packager追加は無い。actorモジュール自体を実行しても本番処理を開始しない。

新6人工は普通のFS/current UIDの既_hold注入とfake executorだけ。実kernel flockの全工程保持、順逆direction、未知/不完全proof/出生image不一致、receipt I/O失敗・置換拒否と起動前終了を確認した。実root UID/caps/Compose/mount/host祖先ACL・alias・非参加writer停止/通常非露出/socket/freshinstallPGID4CLI停止時間の実受入に拡張しない。whole Draft NOTDEPLOYABLEを維持する。

### Written receipt identity delta

SEC014-RECEIPT-WRITTEN-IDENTITY-1 showed that equal JSON in a replaced inode passed readback. The caller now holds the original written FD open through fsync/readback, and binds its original dev/inode/owner/mode/nlink/size/mtime/ctime to the held FD, a reopened FD and the linked path before advancing the journal. Equal-content substitution is refused. The original ordinary-FS rename/recreate counter body and assertions are retained; its old-source fail becomes a new-source pass with phases empty/start0/incomplete. A normal forward/reverse focused case also passes. Old six/eight/FULL suites are not repeated. This is a source identity delta, not real root/Docker/proof-meaning or deployment acceptance.

## Prepare proof producer (source only)

`distribution/internal/sec014-prepared-proof.py` reads the existing fixed
state-data `.prepared.json` and all six actual directory identities. The public
function requires real/effective root UID/GID and the fixed host path; only the
private filesystem test function injects another path/owner. It compares the
existing preparation schema, exact leaf names, parent and leaf dev/inodes,
owner/mode and linked/held metadata while keeping all leaf FDs open. Changed
receipt bytes/inodes, substituted directories or unknown parent contents refuse
confirmation. It reads preparation metadata only, without opening leaf contents
(including APNs files).

The returned canonical metadata bytes are a source for the future executor's
`six_prepared_leaves` proof. The caller must retain those bytes as an artifact
before pinning their hash; this module does not substitute a hash for host ACL,
ancestor aliases, writer exclusion or Owner approval. It has no CLI, Docker or
phase/journal integration, and cannot complete a transaction. The fixed prepare
command/terminal receipt and the remaining five actual phase executors are still
unconnected. The four new ordinary-filesystem tests use injected current UID/GID;
there is no real root/chown/capability/mount acceptance. Whole Draft NOTDEPLOYABLE.

### Initial fstat failure

The leaf FD is now registered for cleanup immediately after a successful open,
before the first fstat. SEC014-PREPARED-FSTAT-FD-1 injects EIO at that first
fstat on an ordinary filesystem: the unchanged counter changed from one leaked
FD to zero, while preserving the original exception. Its body and FD assertions
are retained in the new regression test, with only the source location adapted.
The prior four tests/FULL are not rerun. This does not connect the actual host
executor or establish real root/mount/authority acceptance.


## Prepare evidence handoff into the phase caller (source only)

`prepared_phase_receipt` retains the preparation metadata producer's exact UTF-8
bytes and SHA, together with a typed positive prepare terminal, in a 0600
O_EXCL artifact under the held transaction parent. Its artifact SHA becomes
`six_prepared_leaves`; the existing phase consumer saves the phase receipt before
confirming the journal. Artifact saving shares the existing receipt write-FD,
fsync and held/reopened/linked fullstat checks. Equal-JSON inode replacement,
write failure, invalid terminal or changed prepared leaves cannot confirm it.
The function itself does not advance a phase. A subsequent writer refusal leaves
the transaction incomplete with only `prepared` confirmed.

The terminal input is a trusted internal executor contract, NOT a terminal
producer or an external authority receipt. Its schema binds direction, actor
PID/birth, selected image, positive client PID/birth, exact created container ID,
fixed uniquely named prepare Compose argv, exited/exit0 and unknown=false.
The future producer must independently observe those facts, pin the Compose
source and process environment, and retain the client/daemon originals before
calling this consumer. The host-parent proof argument still checks SHA syntax
only: the trusted executor must verify the original host ACL/alias/parent/writer
conditions before supplying it. No actual child, daemon or host authority was
verified by this source change. Do not manufacture these inputs from exit0 alone.

Six new ordinary-filesystem tests cover artifact bytes/terminal retention under
the same kernel lock, bad terminals, changed leaves, artifact fsync failure,
same-content different-inode replacement, and prepare-to-writer refusal in the
existing phase caller. They inject current UID/path only into the metadata
reader and provide synthetic terminal inputs. No Docker/root/host probe, normal
startup, public installer, packager or production CLI connection. The actual
fixed prepare executor/terminal producer and host-original verification remain
the next source work; whole Draft NOTDEPLOYABLE.

## Fixed prepare child/daemon producer (private source only)

`distribution/internal/sec014-prepare-executor.py` implements the prepare slice
using the existing actor/control and metadata reader. It accepts no arbitrary
Docker command/path: its four slots are the shared fixed Compose prepare run,
selected-field inspect of the unique actor/direction name, no-force rm of that
verified stopped CID, and exact-CID absence. The original Compose bytes are
pinned. Client environment is a fresh six-key map with empty private
DOCKER_CONFIG, /dev/null env-file and the selected image/fixed state parent;
normal service configuration, HOME/data/credentials/ports/socket are not supplied.
The selected SEC014 image ID/ref must come from separate accepted inputs: the
new e52 runtime candidate is not a substitute for a SEC014 image acceptance.

A selected phase is at most 120 seconds. The run client is bounded by 60 seconds,
the three remaining clients by ten each, all under the absolute monotonic/UTC
window with a one-second reap reserve. Every slot rechecks its host verifier and
time before/after its durable O_EXCL claim and immediately before Popen. The
parent retains the existing lock; close_fds/CLOEXEC keep it out of children.
stdout/stderr are drained concurrently with 32KiB/4KiB caps; only byte counts and
hashes are retained for stderr. PID/birth and WNOWAIT terminal originals are saved
before real wait/reap. Failure/unknown latches this runner and leaves the journal
incomplete; it neither kills an unknown child nor issues normal cleanup afterward.

CLI exit0 alone cannot produce a prepared phase. The selected daemon observation
must match image, unique name/CID/project/service, root env-i entry, init and
exited/PID0/exit0/OOMfalse/restart0, caps/network/RO/resource limits and the sole
fixed state-parent bind (plus the declared tmpfs). Native Created/Started/Finished
bytes must place this container within the run-client issue/terminal interval.
The raw projected observation, terminal SHA chain, rm result and absence are
retained before the existing six-leaf metadata artifact/phase consumer is used.
No normal phase is started by this module. Current Docker field representations,
real capabilities/root/mount behavior have not been accepted by the synthetic
fixtures, and unexpected real forms must be held rather than silently corrected.

The host-check callable is a PRIVATE ARTIFICIAL/INTERNAL integration seam. It is
not a host-original authenticator: a SHA returned by a lambda is not authority.
There is no public prepare function, CLI, installer/packager connection or live
executor factory. Before such a connection, the trusted issuer/raw bytes/current
revocation/source/actor/namespace/lock/writer bindings and numerical freshness
must be accepted from Emma's host-owned source contract (source-only proposal
4ff5461d, handoff31069a64). Those producer/trust/numerical conditions are not
implemented or installed; unavailable means child0. Do not build an unagreed
registry/signature service or issue a Root accepted=true receipt as a fallback.

Eight new focused tests use temporary ordinary filesystems and fake Docker
protocol responses emitted by dedicated Python clients. They test the fixed
four-command denominator/minimal env/terminal-before-reap/metadata phase order,
running/extra-mount/old-container rejection, output limit, terminal save failure,
claim-I/O expiry with no retry, and missing host-original refusal. Initial six,
then the necessary fixed-slot/terminal-save seven, then native-birth/entry checks
with final eight are kept as separate logs, not counted as 21 distinct cases.
Old actor/prepare/control/FULL successes are not repeated. Whole Draft remains
NOTDEPLOYABLE; real host/root/Docker/key operations and normal startup are zero.


## Bounded writer snapshot metadata consumer (source only)

`distribution/internal/sec014-writer-snapshot.mjs` reuses the existing
`stateWriterPlan`, `stateWriterVolumes`, `stateWriterSources` and
`assertStateWritersStopped`. It extracts only the mount plan from in-memory
Compose input; credentials are not copied into the plan or metadata result.
The fixed list/projection/volume argv has maxima of 128 container IDs, 128
volumes, 64 mounts per container and 512 canonical paths, at most 130 Docker
commands. Excess, duplicate/missing IDs, mismatched raw byte counts/SHA,
nonzero/unknown terminal, arbitrary argv and unredacted volume metadata refuse
intake. All actual commands remain unissued: this module does not spawn.

The result is explicitly `docker-writer-metadata-only` and produces no phase
receipt. It cannot prove host writer participation, nonparticipating writer
stop/respawn suppression, or the two actual normal-container identities from
Docker mount overlap alone. Canonical path inputs are observations requiring a
separate trusted host producer, not a host alias/ACL verification by this module.
The real finite collector, source/Compose/image/transaction bindings, parent-FD
lock through all observations and host authority/lifecycle for the writer phase
remain unconnected. The existing prepare-only 57 slots/11-ready contract is
unchanged and must not be reused for this phase. No CLI/factory/installer change,
Docker, host observation, actual root/mount/ACL or normal start was added.
Whole Draft NOTDEPLOYABLE remains in force.

The container projection now includes actual `HostConfig.RestartPolicy.Name`.
Stopped `always`, `on-failure` and `unless-stopped` containers remain potential
writers, with the same canonical bind and volume-backing checks. Missing or
unknown policy is unavailable, not proof of absence. A successful caller stop
can exempt only its exact pre-stop Compose CID with `unless-stopped`; the
installer, internal adapter and manual recipe pass that CID through the private
`BELLTEAM_STOPPED_CONTAINER_ID` handoff. The shared plan's optional
`stoppedContainer` is caller context, and the serialized snapshot consumer rejects
it. This remains a snapshot: later manual starts, external managers and the
complete maintenance interval still require separate exclusion evidence.

### Remaining lifetime contract at the normal and maintenance entries

The caller-stopped CID handoff ends at the writer snapshot. The following
current entries have no shared admission or held exclusion spanning that
snapshot, both backups, transfer/ownership changes and the selected restart:

| Entry | Current behavior and missing connection |
| --- | --- |
| `distribution/server/install.sh` and `scripts/deploy-image.sh` | Stop, inspect, prepare, transfer and `compose up` are sequential commands; another installer or normal start does not participate in their interval. |
| Internal manual recovery recipe | The selected CID is stopped and checked before backup/inverse/restart; another caller can still start the same or another normal generation. |
| `scripts/server-start.c` and `src/supervisor.mjs` | The fixed UID1001 entry executes Node, whose static bootstrap import runs before runtime construction or `start()`. Neither entry consults a maintenance transaction. |
| `src/bootstrap.mjs` | Settings, owner/user rules and Bot registry initialization, seat environment/configuration and global instructions run before the HTTP/background-loop lifecycle. A check added only to `runtime.start()` would be too late. |
| `src/application-services.mjs` and `src/application-runtime.mjs` | Service initialization precedes `AiControl` construction; AI pause admits/stops managed work but does not exclude every state writer or bootstrap initialization. |
| `backupServerState` and `migrateServerState` | Both require the offline caller to maintain exclusion. File identity checks can reject observed changes but do not hold other writers stopped for the interval. |

The existing `sec014-host-control.py` transaction serializes callers that use
its fixed root-owned control path. Normal entries and the installer/adapter
above do not join it, and the public packager does not ship the internal
controller. Its lock or a phase receipt therefore cannot prove these writers
are excluded. The remaining product contract must cover all supported start,
update and recovery paths before their first write and retain ownership until
the selected normal restart/result is resolved, including interrupted callers.
Root owns that product connection and writer denominator; Emma retains the
agreed OS/shared-runtime and known host-manager facts. This source gap does not
request a new host helper or authorize stopping other jobs. It remains a
prerequisite for whole-Draft deployment; no actual writer-lifetime acceptance
has been performed.

## Installer maintenance mount inputs (source only)

The existing writer `plan` CLI consumes default `docker compose config --format
json` output, whose serializer doubles every dollar. It restores one such layer
before the existing JSON parse, so literal dollar-containing host paths match
Docker inspect paths. Direct `stateWriterPlan(config)` callers still supply the
actual model; Docker inspect/canonical metadata is never unescaped.

Direct config output is not used as the frozen model. With official Compose 5.6.1,
reloading either JSON or YAML `config` output changes a label key containing `$`
because the output escapes keys while input interpolation only handles values.
An offline `.env`-selected, different-first-file-directory case preserves values,
mounts and project but changes the effective service hash. `--no-interpolate`
leaves original variables unresolved. Do not use that round-trip as a normal
startup model or infer configuration lifetime/writer exclusion from this fix.

The installer now captures normal, image-owned prepare and image-owned maintenance
models before stopping the service, in its existing private temporary directory
with umask 077. It restores Compose's global dollar escaping, pins the normal
image to the selected local ID, and serializes only string values with dollar
escaping. Label keys stay literal. Project selection comes from the same normal
capture and is exported with its frozen `COMPOSE_FILE` for stop, writer check,
Cursor update, normal up and port lookup. Prepare/maintenance retain separate
standalone models, and their parent/state source correspondence is checked before
stop. A render/parse/correspondence failure does not stop the existing service.

The checker merges the frozen maintenance model with that same frozen normal
model for its existing mount checks; each actual state service uses its own file.
Original Compose inputs are not reread after the captures. External files named
by the model (for example secret/config file contents) and host inode identity
are not frozen. The normal model is now retained at the caller-owned absolute
installation path `.bellteam-compose.XXXXXX/normal.json`, in a fresh 0700
directory with a 0600 file. A same-directory rename publishes the complete model;
no existing generation is adopted, replaced or removed. Before the first stop
attempt, a failure removes the unpublished generation. From the stop attempt
onward, even failure retains the selected model so the container's Compose
configuration label remains readable after installer cleanup. Temporary assets
and prepare model still expire; the exact dedicated maintenance model is retained
beside normal for a later inverse operation. This proves neither crash durability nor
reconstruction of external file contents. Private backup must include retained
models separately; the existing data/home backup does not automatically include
this installation directory. Active or recovery generations must not be removed.

The formatter refuses a saved directory lexically inside a declared normal
bellteam bind source before copying the secret-bearing model there. This is not
a realpath, host mount alias, named-volume backing or inode identity proof. Git
and Docker build exclusions keep retained generations out of those inputs; they
are not access controls. Real placement and exposure acceptance remains pending.
No writer lifetime/respawn exclusion or real migration/startup acceptance is
established.

The installer extracts `compose.state-maintenance.json` from the selected image
along with its existing writer-check script. It passes that image selection as
`BELLTEAM_SERVER_IMAGE` and calls the existing `--maintenance` check after stop.
The checker first normalizes the caller's full configuration in memory, then
merges its image-owned Compose file by absolute path using standard Compose.
This preserves `.env`-selected overlays, project and resolved paths as well as
explicit `COMPOSE_FILE` input, without writing normal environment data. A two-file
installation therefore does not need a second, independently selected copy.

Compose must receive `BELLTEAM_LEGACY_DATA`, `BELLTEAM_STATE_PARENT` and
`BELLTEAM_MAINTENANCE_BACKUP_PARENT` from the installation's existing environment
or the installation directory's `.env`, all as absolute host paths. The second
render explicitly keeps that directory for `.env` lookup; settings supplied only
by another directory's `.env` must be explicitly supplied here. Normal mounts are resolved using their
original first-file base before merging. The second render uses
`--no-path-resolution` so relative maintenance inputs remain relative and the
existing writer-plan absolute-path validation rejects them before inspection or
maintenance runs, rather than silently interpreting them against stdin's cwd.
The planned old/new views and backup enter the existing mount check;
missing inputs or an unavailable image-owned file stop this path. No host parent
is created or adopted by this change. These inputs must match the actual normal
mounts, and the state parent must already satisfy the prepare contract.

This connects the writer-check denominator and fixed maintenance invocation.
The prepare entry, writer exclusion through migration, respawn suppression and
the normal restart remain unconnected. A passing metadata check is not that exclusion.
The new fake-Docker cases stop at rendering and establish no real Compose
interpolation, writer stop, prepared parent, migration or normal-start acceptance.

## Installer fixed maintenance invocation (source only)

After the existing writer check, the installer reads the normal Compose project
name from normalized YAML, using the same selection as the existing updater.
It runs only the image-owned maintenance file with that explicit project and
the installation project directory, then invokes
`compose run --pull never --rm --no-deps -T state-maintenance to-server`.
Normal Compose services are not merged into the run's maintenance configuration.
It supplies neither a user nor an entrypoint override: the existing fixed
service owns root identity, env-i, the two views, six leaves, backup, resource
limits and capabilities. It does not inherit normal HOME, credentials or env.
The old root normal-service runs and broad parent chown are removed. Unknown
HOME/state/backup parents are not created or recursively adopted here.

Project read failure, writer refusal or maintenance failure stops before Cursor
update and normal up. Existing partial migration data is not cleaned by the
installer; only extracted scripts are removed by its existing staging trap.
Four new fake-Docker cases cover invocation/model inputs and those failures.
They do not execute the migration CLI or establish actual data preservation.

Project and maintenance inputs are read again for the run; no configuration/writer lock is
held by this change. Prepare, actual unchanged input/mount identity, continuous
writer/respawn exclusion and safe normal restart remain required work. A fake
successful invocation does not make this Draft deployable or authorize a real run.

Six new artificial Node cases cover the bounded metadata intake and never execute
Docker or call old tests. They are ordinary in-memory fixtures; their synthetic
PID/startTicks fields are not actual child terminal/host authority evidence.

## 2026-10-27 検査した設定を後続へ渡す入力の境界

fd2855cの通常installerについて、既存のplan/CLIと実行側の接続をsourceだけで照合した。検査結果をprepare・移行・通常起動へ渡す既存入力は、この呼出経路には無い。ここで新しいplanner/runner/lock/receiptを作らず、接続済みと扱わない。

| 段階 | 既入力・出力 | 後続へ残る不足 |
| --- | --- | --- |
| installerのimage選択 | 通常Composeから選び一度local image IDへ解決、既BELLTEAM_SERVER_IMAGEへexport | imageの限定結合であり、設定file内容・mount source・writer排他は固定しない |
| writer checkerのplan | normal config JSONとimage-owned maintenanceを合成しstateWriterPlanへ渡す。plan.jsonはrootsとvolumeのみ | rootsは正規化/重複除去されたsource集合で、targetとの対応・project・image・設定file/補間入力を保持しない |
| checkerのverify | container/volume metadataとcanonical pathで検査し、成功時はwriters:0をstdoutへ返す | stagingのplan.json等はtrapで削除し、installerは終了codeだけ使う。後続の設定一致や排他を表す入力は返さない |
| projectの選択 | installerが検査後にnormal config YAMLを別途読みprojectを取得 | 検査時のconfig/projectとの一致を表す値は受け取らない |
| 固定prepare | 専用file/同project/installation directory、BELLTEAM_STATE_PARENTを補間 | 親は固定container pathで検査される。checkerのhost sourceとの対応は渡らない |
| 固定maintenance | 専用fileを再補間しlegacy/state/backupの絶対host入力を9bindへ配置 | CLIは固定container path/2view identityとbackup親を検査するが、checker planを受け取らない |
| Cursor更新/normal up | updaterはnormal configを再読取、最後もnormal Composeを使用 | 検査時のproject/mount/volume/configと同じであることや、終了までwriterが再開しないことは未結合 |

通常Composeのfile列・順序・project directory・.env/明示環境の補間により、各呼出の入力が決まる。BELLTEAM_LEGACY_DATA、BELLTEAM_STATE_PARENT、BELLTEAM_MAINTENANCE_BACKUP_PARENTが同名であっても、.env又はfileが途中で変われば同じ値を意味しない。現sourceはこの変更を検出したり防いだりするものではない。checkerが読んだ正規化source集合から、後続の役割別mountを再構築してよい契約も無い。

必要な製品入力は、検査したnormalのproject/imageとtarget→source/volume対応、prepare親、maintenance両view/6leaf/backupが、後続に実際に渡る設定へ対応すること。Rootが既Compose入力を保つ方法を実装・互換確認し、製品として渡す責任を持つ。設定の読取成功やsnapshot SHAだけを、外部file/host path/inodeの不変又はwriter lifetime/respawn排他へ代用しない。

host担当の責任は既承認範囲の専用親/root:root0700/ACL/alias/mount等の準備・管理。新しい専用host原本発行や旧補助の再導入は依頼しない。配布image/sourceの受入はセンチと接続し、Rootは実両normal identity、二viewbackup/移動、許可内再開と最新data healthまで持つ。現在の入力結合・全writer/respawn抑止が未成立なら、このDraftを通常起動可能な完成品とは扱わない。

今回はsource修理/新試験/実Compose/host操作0、文書だけの境界固定。旧合格や他PRからGOを補完せず、wholeNOTDEPLOYABLE・本番未反映・既開始不可/承認停止を維持する。親死亡・例外・daemonunknownでnormal0/journal保持、Owner直接再開とKikoeru除外の既条件も変えない。


### Internal image adapter transition

The internal image adapter now captures the same three model roles and pins the
selected local image ID before either quiet observation. It preserves the existing
quiet1/Cursor/quiet2 order while the old normal service is alive, then stops it,
runs the existing maintenance writer check, dedicated prepare and transfer, and
starts from the retained normal model. Its six normal state sources are explicitly
mapped to the same selected private parent as prepare and maintenance. The
image-unspecified build entry now dispatches through the same adapter: build
the root Compose source with pull/no-cache, resolve its generated image tag to a
local ID, then select the internal runtime models without a registry pull.
Snapshot/caller order is not whole-lifetime exclusion:
competing deploy/manual-start/recovery paths and actual host identities still
require product acceptance. Neither entry implements automatic migration rollback.
The fixed serializer is repeated at the two independent entrypoints so the public
2-file installer gains no internal runtime dependency or new dispatch interface.


### Inverse recovery input boundary

Both public and internal callers retain the exact executed standalone maintenance
model at `.bellteam-compose.XXXXXX/compose.state-maintenance.json`, mode0600,
beside the selected normal. Successful exit or failed normal startup does not
remove the pair. A later inverse must use this saved model and its pinned migration
image, with the selected normal's actual project, rather than reinterpret a newer
.env. The maintenance image that knows the state transfer format is distinct from
the pre-upgrade normal image that should run after inverse migration.

The inverse acts on the latest two views and invokes the existing `to-legacy`
operation, which takes both view backups before mutation. Reusing an old archived
data generation would lose changes made after the forward migration. Success of
the inverse and actual view identity must be established before starting an old
normal configuration whose mounts/image correspond to the original runtime.
The regular internal deploy now captures a separate original runtime/model before
source fast-forward and binds it to the actual old image archive. The selected
normal/maintenance generation retains `recovery.json` with the exact original
Compose path, image archive path and old state layout. This is an input binding,
not a recovery executor or a runtime acceptance result.

The existing writer planner checks both saved normal models against the same
maintenance views. Project, HOME and Cursor volume must correspond, the original
startup image must match its archive, and extra mounts hiding state subpaths are
rejected. A legacy layout needs the existing latest-data `to-legacy` transition
before old normal startup. An already-private layout must retain those same six
state sources and must not run `to-legacy` before restarting a normal that reads
them. Latest two-view backup/format compatibility for that restart remains an
unconnected operation. Neither layout is a production recovery acceptance.
Binding stop/check through inverse/restart, testing latest-data inverse/health,
actual source identities and preserving current HOME/Cursor data remain unfinished.
No automatic inverse or startup-on-failure is introduced here.


The seat-side launch error envelope retains the existing fixed error fields plus
only `authenticationPreflightFailure` and `returnedMcpError` validated projections.
This preserves the main diagnostic contract without serializing arbitrary Error
properties or the seat environment. Private-tool MCP bodies remain excluded by
the existing validator. This is a metadata boundary check, not real UID/SDK/runtime
launch acceptance.

## 2026-10-28 既controlのnormal読取roleと引渡し

内部host_controlはroot身元のまま、合意済みcontrol親root:1001/0750、既lockとnormal参照journal0640を検査する。receipt/prepared等の既private検査は0600のまま。既存の不正mode/owner/inodeを自動修正しない。新規lock/journalだけにroleを付け、同じlock inodeを保持する。private _holdのpath/owner/group注入は通常FS試験用で、製品入口はgroup1001固定。

固定actorはwriters_stopped→prepared→migrated→binds_confirmedの順で実receiptを保存する。選択normalのcreate結果（fullCID/raw image ID/起動相関）を既trusted executorから受けた後、同journalへadmissionをdurable保存してEXからSHへ変更し、その選択identityをstart/result両callbackへ渡す。EX→SHの原子性は仮定せず、切替中の別actorも未完journalで拒否する。journal保存に失敗すればSHへ移らない。started/verified確認は引渡し前に進まない。

normal読取側がatomic replaceで旧inodeへ留まるfile bindを使わず参照できるよう、既lockの内容に現在のdirectionと改行をEX保持中に保存する。引渡し以後、そのtransaction内でdirectionを変更しない。後続通常入口は同inodeのSH取得後、このselectorが指定するjournalとadmissionをbootstrap前に検査する必要がある。現差分には固定C/supervisor/Compose/実executorへのその接続はまだ無い。実normalがSHを保持して起動した、又は全writer区間が受け入れられたとは扱わない。

現在のcontrolは既direction一回記録のALREADY_RECORDED契約を保持している。日常の再作成/再更新を接続する前に、既保存normal/backup世代と完了journal/receiptの寿命を結ぶ必要がある。同じ起動相関のまま新CIDを許したり、履歴を削除して通したり、新ID/別controller/helperで置換しない。親死亡後の未完拒否は、公開済みの選択normal起動が必ず取消される保証ではない。

## 2026-10-28 完了記録と既保存normal世代の寿命（内部sourceのみ）

既host actorの `run_actor(..., saved_normal=...)` とcontrol入口は、既callerが保持する絶対normal設定を明示的に受ける。対象は既 `.bellteam-compose.XXXXXX/normal.json` 又は `previous-normal.json`。0700親・同ownerの0600単一link通常file・symlink無しを検査し、raw SHA、file/親inodeとownerをjournalのnormal欄へ保持する。normalのbind source配下に世代を保存する構成は拒否する。この対応はpath/設定の保持で、実mount alias/実全writerの受入ではない。

次回は同じ既lockのEXを取ってから、全先行journalがcompleted/全phase済みで、元normalが同一bytes/inode/ownerであることと全6receiptを検査する。記録先は**先行journalが所有するnormal世代**の固定 `sec014-control-history/`。新しい起動IDや別lockは作らず、元journal・6receipt・存在するprepare evidenceを元inodeのまま移し、file内容/owner/modeを変更しない。history親だけroot専用0700、新normal側の親も既normalもchown/chmodしない。未対応の旧journal、同世代再使用、既history、途中journalは自動消去/上書きせず拒否する。

移動の前に、既lock内容をdurableな `archiving` にする。移動中に失敗/親死亡ならその値が残り、新actorは拒否する。完了後に新incomplete journalをdurable保存して初めて通常directionへ戻す。EX→SHと同じく、lock解放だけを完了にしない。将来のnormal読取入口もこの未完selectorを受け入れてはならない。別FSへのrename失敗も自動copy/deleteせず未完として保持し、手動の原本照合が必要になる。archive途中の自動再開CLIは追加しない。

caller対応は、内部 `scripts/deploy-image.sh` と公開 `distribution/server/install.sh` が既に保存するnormal世代、内部manual recoveryのexact previousCompose/previousImageArchive/recovery.jsonとの対応を使う。保存世代はkeep_saved後に残す既仕様を維持する。**この差分は上記shellへPython actorを接続したものではない**。manualで過去世代を再利用する場合も既historyを消して通さず、既保存設定の新しい世代とその実旧CID/image/復旧対応を実callerが成立させる必要がある。公開installerのhost依存無し全区間ownerは依然未解決。旧receiptの存在だけで新writer checkや新backupを省略しない。

新有限6caseは実通常FSで、同方向3回の保存/同lock inode維持、未完拒否、設定変更/再使用/history衝突、rename途中失敗後の全元inode保全と次actor拒否、設定mode/actor入力接続、旧normal親の途中置換への書込み拒否を検査する。試験利用者のUID/GIDとfake executorであり、実root/1001・C/Node/Composeの寿命受入ではない。既旧fixtureは変更した入口の引数だけ追従し、旧成功群を再走しない。whole DraftはNOTDEPLOYABLE、未merge・未反映。

## 2026-10-28 固定normal入口のSHとbootstrap前admission（sourceのみ）

既server-start.cはUID/GID/補助group1001と引数無しの条件を保ち、標準libc closefromでstdio以外の継承FDを閉じる。固定/run/bellteam-maintenanceのroot:1001/0750親とroot:1001/0640単一link lockをO_RDONLY/NOFOLLOWで開き、同inodeのSHを非待機取得する。固定FD3へ移してNodeのexecに継承し、そのprocess終了まで保持する。環境中の任意FD番号を信頼せず、新しいlock/helper/公開CLIを作らない。既seat-exec.cもclearenvだけに依存せずclosefrom(3)し、既UID/GID降格・stdio・argvを維持する。

supervisorはserver UID1001時に、最初のbootstrap/application/lifecycle import前にFD3のmetadata・readonly flag・/proc/self/fdinfoの当process所有FLOCK/READを確認する。固定親/lock inode、direction selector、bounded journal snapshot、schema・phase/status・actor出生と選択admissionの形式を照合し、BELLTEAM_NORMAL_ADMISSION_TOKENが同journalの選択tokenと一致する時だけ進む。archiving/無admission/phase不足/選択外/不正metadataはimport前に126で拒否する。許すphaseはhandoff公開後の4/5/6で、6だけcompleted。SHで次のEXを防ぐ間のatomic replaceによる完全な旧journal snapshotも読めるよう、開いたjournalのnlink0は許し、複数linkは拒否する。tokenは検査後に環境から消し、既runtimeEnvironmentのserver-only除去にも含める。既legacy UIDのsupervisorは従来どおり起動する。

このtokenは起動相関であり、normal内部から実fullCID/raw imageを証明する秘密ではない。同Config cloneやroot/sudo管理者・未参加legacy writerを排除する証明へ転用しない。実executorは既frozen normalへtokenを入れる時点（normal SHAをjournalへ保持する前）と、選択create/start/fullCID/raw image/healthを対応させる必要がある。現差分ではCompose control mount/token投入と実deploy/installer/manual executorへの接続は未完。公開installerの依存無しownerも未解決のまま、UID1001でgateがあることだけで公開起動成功とは扱わない。準備/保守の固定root入口をnormalの成功として数えない。

新7人工FS caseは、EX中のbootstrap拒否、archiving/不一致token/phase不足拒否、phase4/5/6各normalのSH寿命とroot解放後の次EX拒否・終了後取得、普通Node stdio3本の子へlockFD非継承、不正mode/symlink拒否、C無しNode拒否、既legacy起動、seat-execのraw継承FD閉鎖を検査する。Cは固定pathとUID/GIDを試験利用者へ置換し、seatの権限syscallもtest linker shimで置換。実privileged1001/container/4CLIの試験ではない。元は7メソッド中legacy1pass/他6fail（subTest含む11assertion failures）、修理後7pass。初期fixtureはbootstrap markerで直ちにSIGTERMを送りshutdown handler前の-15となったため別log保存し、実ready到達を待つ最終同bytesを採用した。旧成功群/Full再走や実host/daemon/container/build/deploy/CLI/他job停止は0。wholeDraft NOTDEPLOYABLE。


## 内部frozen normalと選択admissionの対応（10/28）

内部adapterは最初のCompose操作より前に標準cryptoで新しい64桁hex tokenを生成する。継承された値は採用せず、内部overlayの環境へ渡す。同overlayは既control `/home/kite/BellTeam/runtime/server-only/maintenance-control` を `/run/bellteam-maintenance` へreadonly bindし、create_host_path:falseとする。既root:1001/0750・lock/journal0640・receipt0600の分担は変えず、host parentや共有祖先を作成・補正しない。

既frozen model生成は、同じtokenと固定readonly mountを検査してからnormal.jsonへ保存する。既controlのnormal読取は元file/親/全bytes SHAとともに、このraw image.Idとtokenを保持する。選択結果のimage/tokenが保存normalと違う場合はadmissionを書かずEXを維持したまま拒否する。既actorはそのsaved_normal recordを選択のprepare、実start、結果確認へ渡す。tokenは起動の相関であって秘密鍵や実CID/image独立証明ではない。

新有限6メソッドは旧source0pass6fail（subTestを含む11assert失敗）→修理6pass。実普通FS/実flock/Python/NodeだがUID/GIDは試験利用者を注入し、Docker/Compose/実root1001は使わない。内部shell前段のtoken生成と、実Node freeze codeの希望token不一致拒否も通常processで確認する。旧fixtureは引数位置と必須normal項目だけ追従し旧成功群/Fullを再走しない。

実shellはまだactorを呼ばず、直接stop/prepare/maintenance/upの順である。create/start/inspect/actualCID/healthを持つ既通常executor全体は未接続であり、saved_normalを引数へ渡しただけを実受入にはしない。公開installerの依存無し全区間owner、手動復旧の新保持世代とexact旧CID/image対応、実mount/UID/ACL/全writerは引き続き未成立。内部overlayだけを公開解決として配布しない。whole Draft NOTDEPLOYABLE。

## 実phase出力の対応と移行結果のbackup参照（10/28）

| phase | 既実装から読めるもの | それだけでは確認できないもの |
| --- | --- | --- |
| writers_stopped | 既writer CLIのexit、Docker表・volume/canonical metadataの検査。snapshot APIはphaseReceiptProduced:falseを明示する。 | 全host writerの寿命、両normalのexact停止とrespawn排他。CLIのstagingは終了で消える。 |
| prepared | prepareのstatusと `.prepared.json`、6leafのinode/owner/mode。既prepare executorは実container terminalとmetadataを保存する。 | 未接続host_check、現内部shellの固定root実行との対応。既executorは静的Composeを読み、saved normalと同じrendered prepareを使っていない。 |
| migrated | `migrateServerState` のdirection/status/ownershipと、今回からlegacy/server双方のbackups参照。 | 実maintenance CID/image/mountとfrozen normalの対応、移行後の全データ比較。 |
| binds_confirmed | 既plannerのmount宣言と、prepare metadataの固定6leaf。 | 実createのmount source/target、normal非露出とsocket境界。 |
| started | 現shellのcompose up終了だけ。 | 選択fullCID/raw image/tokenと実startの同一性、別normal不在。 |
| verified | 現shellにはactorへ渡す実health/data/child検証結果が無い。 | health、最新データ、未知child無し。up成功を代用しない。 |

`backupServerState` は従来の `status:created` に加え、同じ呼出しのroot/destinationと、既 `complete.json` のpath/device/inode/sha256を返す。完了fileのbytesやschemaは変更せず、write/sync後に採取した同inodeがcloseと親directoryのsync後も同じprivate通常fileであることを確認する。同bytesの別inodeを含む変更は `SERVER_STATE_BACKUP_RECEIPT_CHANGED` で拒否し、未知のfileや控えを消さない。既write/sync/close失敗の伝播は維持する。

`migrateServerState` は両backupの実返却を `backups.legacy/server` へ残してから従来どおり移行し、既direction/status/ownershipと一緒に返す。2回目backupの失敗で移行を始めない順序は不変。CLIはこの返却を既JSONへ出す。private設定やバックアップ本文を出力せず、新しいschema/ID/公開CLI/保存fileを作らない。

これは既backup完了fileの参照であり、内容全体のhash/restore成功・host側source inode・actualCID/image・全writer排他の証明ではない。後続executorはfrozen設定と実containerのmount対応を照合してから当該artifactを読む必要がある。任意hashやexit0からphase-receiptのverifiedを合成しない。actor全接続、静的prepareから保存済prepareへの対応、normal create/start/inspect/health、公開installer全区間ownerとmanual復旧は引き続き未完で、whole Draft NOTDEPLOYABLE。

### 保存prepare設定の寿命（10/28 07:02UTC）

内部deploy-imageはrenderしたprepare JSONを既saved generationのcompose.state-prepare.yamlへ保存し、同fileをCompose実行に使う。staging cleanup後もnormal/maintenanceとともに、成功・prepare失敗・up失敗のいずれでも実行設定を保持する。file名のyamlは従来の名前で内容はrender済みJSON。umask077の0600を維持し、normalの秘密をprepareへ混ぜない。

新一試験（3終端条件）を同bytesで旧0pass1fail/ENOENT→新1pass0fail。既fake Docker/実shellとNode/普通FSを使い、実daemon/Compose/hostは0。保存はphase verified receiptではなく、既prepare executorのstatic Compose参照・actorのofficial ref/rawimage対応・全phase実container照合は未接続のまま。normalの既control recordだけで兄弟prepare設定までbind済みとは扱わない。次は既actor/prepare関数へこの保存pathと同入力を明示し、任意hashやexit0での代用なしに実executorを接続する。

### 保存prepareの記録

保存normalの兄弟`compose.state-prepare.yaml`がある世代では、既control読取がそのroot-owned private fileのpath/SHA/device/inode/親identity/owner/raw imageをnormal記録へ保持する。prepareはJSONとしてrender済みで、単一state-prepare serviceのraw imageはnormalと一致する必要がある。tx.checkは兄弟fileも再読し、同bytes別inodeやsymlink・raw image不一致を拒否する。兄弟fileのない従来世代のnormal記録は維持する。

これは保存記録の接続であり、prepare executorの実行許可ではない。固定YAMLのCOMPOSE_SHAをrender済み設定の全実行条件の検証へ置き換え、official digest参照とraw imageの対応を実authorityへ結び、actor argv/terminalと同一設定を使う接続は未完。全体はNOTDEPLOYABLEのまま。


### 保存prepareと実callerの同入力接続（10/28）

内部adapterはraw imageへ解決する前の指定immutable refを、保存normal/prepareの既Compose拡張`x-bellteam-image-ref`へ保持する。controlはofficial refの形式とnormal/prepare間の同じref/raw pairを検証し、既normal記録にprepareの全serviceを保持する。actor.argv/terminal/chainは同じ保存generationを使い、tx.checkの再読を通す。

executorは既固定YAMLのSHA検証を残した上で、保存render JSONのentrypoint/user/readonly/network/caps/security/tmpfs/唯一の親bind/資源制限を固定条件と照合する。canonical mem-limitの数値/数値文字列とCPU1/1.0のみを同値として扱い、未知条件は実client前に拒否する。実client claimへofficial refとraw IDを併記し、raw指定の実container inspectを照合する。既host_check.bind_imageの実authorityは依然必要で、省略・疑似成功へ変更しない。

新しい保存JSON path反例は旧1fail→新1pass、指定ref保持の実shell+fake Docker反例も旧1fail→新1pass。新executor専用5件は既filesystem/実Python子+fake Docker protocolで成功、実daemon/host0。初回は再利用fixtureの別module例外型の相違で成功case1errorとなり、その原本を保持してfixtureの同一例外型へ直している。旧成功群/Full再走なし。

実Composeが作る保存JSONとの実機照合、writer/host authority全接続、normal create/start/inspect/healthと全区間の実受入はまだ。保存設定接続のsource修理を全phase受入へ広げず、whole Draft NOTDEPLOYABLE/未merge未反映を維持する。

### held txへの実行器生成の接続（10/28）

内部`run_actor(direction, image, executor_factory, saved_normal=...)`は既host_controlでtxを保持してから`executor_factory(tx)`を一回呼ぶ。実行器はこのtxをprepareへ渡せる。生成後も同generationを再照合し、生成失敗・同bytes別inodeへの置換ではphaseを進めない。immutable imageが不正ならfactoryを呼ばない。既caller一箇所もfactoryへ合わせ、既`_run`のphase順・receipt先保存・失敗伝播は維持する。

新しい同bytes反例は旧0pass1failから新1passへ移り、新4件と変更caller1件を確認した。保存世代/実kernel lock/実Python子を使い、Docker protocolとwriter/host authorityは人工のまま。prepare後で意図的に止め、後段の実起動や最終完了を合成しない。公式Compose5.6.1の生成JSONとの有限確認は別工程で成立したが、production同版・実hostauthority・通常shellからのactor接続・normal create/start/inspect/healthは未完。whole Draft NOTDEPLOYABLE、未merge未反映を維持する。

## 2026-10-29 Saved generation input for every phase

The existing actor now passes the same held `saved_normal` record to the writer, prepare, migration and bind executors as well as selection/start/result. Selection/admission and phase order are unchanged; the legacy transaction without a saved normal still supplies no such field. This is an internal input binding, not a writer or host-authority producer.

One new focused test reuses the existing generation fixture with a real ordinary filesystem/transaction lock and synthetic phase receipts. The exact test fails at the first writer callback before the fix because the saved record is missing, and passes all six phase callbacks plus selection after the two-line transfer change. No old test groups were rerun. Actual image pairing, fixed parents/ACL/mounts, participating/nonparticipating writer lifetime, daemon phases and the normal shell caller remain unconnected. Whole Draft NOTDEPLOYABLE, unmerged and undeployed; no host operation or retired helper is introduced.


## 2026-10-29 Saved maintenance model in the held generation

The private generation reader now also captures an existing sibling `compose.state-maintenance.json`: its exact bytes hash, file and parent identity, owner, selected raw image and service. Existing transaction rechecks therefore reject changed model bytes or a same-byte replacement before the next phase. The bounded no-follow/private-file reader is shared with prepare; prepare keeps its fixed project/service checks. Maintenance has no fixed project name in the existing renderer, so no project name is invented. Its raw image must match the current normal; an optional immutable reference must match if present, while the existing renderer need not add one. Current generations without the sibling remain compatible. `previous-normal.json` continues to represent its own image without adopting the current migration service.

One new six-case ordinary-filesystem/flock test has identical before/after bytes: old source 1 pass/5 failures, repaired source 6 passes. It covers the held record, same-byte replacement, changed raw model, wrong selected image, symlink rejection and previous-normal separation. Existing test groups were not rerun. This only preserves and checks generation input: it does not validate maintenance execution conditions, prove writer exclusion or produce real host authority. The existing shell still uses its staging copy; production composite/normal shell connection, writer lifetime and later daemon phases remain unconnected. Whole Draft NOTDEPLOYABLE, unmerged and undeployed; no host/daemon operations or retired helpers.


## 2026-10-29 Internal forward checker and migration consume the saved maintenance file

The internal forward adapter previously copied the saved maintenance model into temporary staging. The selected-image checker resolves its maintenance file relative to its own script parent, so it read that different inode; migration used the staging copy too. The adapter now places the existing extracted checker under the new generation's `scripts/` and calls it there, and migration directly uses the sibling saved model. The redundant rendered-model copy is removed. The checker logic, arguments, fixed image selection, quiet/stop/prepare/transfer/start order and failures are unchanged. The private generation directory and retained checker remain 0700/0600 under the existing umask. Publication failures still occur before the stop and use existing cleanup.

The new focused test uses the existing real-shell/fake-Docker fixture and the actual checker's relative-path expression. It records path/inode/SHA on an ordinary filesystem at writer-check and transfer. The identical test source fails all three cases before the fix (same bytes, different file identity) and passes success, writer refusal and transfer failure after the fix; the Node runner counts the parent plus three children as four. No previous test groups were executed. The fixture records only the selected model path/inode/SHA in addition to its existing synthetic model. Writer refusal still prevents prepare/transfer/start; transfer failure still prevents startup.

This connects the internal forward path to the existing saved-file record; it does not introduce a host-control transaction into the normal shell or make a metadata snapshot prove writer lifetime. The complete Docker writer checker/daemon is not executed by this fixture. Commercial install and documented manual recovery keep their existing copy contracts and are not adopted into the retained actor by this change. Maintenance execution-condition validation, actual image/parent authority, interval-wide writers and later normal phases remain unconnected. Whole Draft NOTDEPLOYABLE, unmerged and undeployed; no new CLI, controller, lock, identity scheme, host operation or retired helper.


## 2026-10-29 Held writer configuration for the existing metadata planner

The private transaction now exposes `_writer_config()` while held. It uses the existing bounded no-follow/private generation read and compares the same normal/maintenance file identities and hashes through `check`, then returns only the mount fields consumed by `stateWriterPlan` and the referenced normal volume names. The models collector is private, transient and absent from the transaction record; default `_normal`/`check` callers and saved journal fields remain unchanged. Only string mount type/source/target, boolean read_only and string volume names can leave this projection. Environment, credentials, tokens, labels and driver options are not forwarded. Missing maintenance, changed generations or nonscalar projected fields refuse the input; the same transaction is checked again before returning.

The new focused test calls this input from the actual held `run_actor` factory, passes the projection to the existing Node `writerSnapshotPlan` and `verifyWriterSnapshot`, and saves the local Node output with selected generation path/hash/inode references and actual Node exit0. Docker terminal/canonical records in this test are synthetic. Authority flags remain false; the factory intentionally stops before phase0, leaving the real transaction incomplete. The other new cases refuse a same-byte maintenance replacement and a nonscalar source. Final identical test bytes give old0pass3fail and new3pass; ordinary filesystem/kernel flock and local Node only, no old test groups or Docker operations.

The first evidence-only rerun used an isolated old actor without its prepared-proof dependency and failed to import; that harness error and an initial log-prefix parse error are preserved separately. After adding the unchanged dependency and correcting the evidence parser, the final old run has all three intended assertion failures and the captured new output passes the metadata/no-secret assertions. Neither harness failure is claimed as the product counterexample.

This is the private saved-input seam for a future real producer, not a production composite or authority implementation. Real Docker bundle acquisition/terminal lifetime, actual immutable-ref/raw-image binding, maintenance execution conditions, host parents/ACL/mount authority, interval-wide writers, normal shell transactions and later normal phases remain unconnected. Whole Draft NOTDEPLOYABLE, unmerged and undeployed. No public CLI, helper/controller, new lock/identity scheme, host/daemon operation or retired path is introduced.


## 2026-10-29 Writer planner raw-image input consistency

The held writer projection also needs the image used by each saved service. The previous mount-only projection dropped those values, while `writerSnapshotPlan` accepted a selected raw image ID without checking either configured service. A well-formed different raw image in normal or maintenance could therefore be tagged as the selected one in a metadata plan. The projection now preserves that already-validated image string; the private planner requires the normal image and, when present, maintenance image to equal its selected raw ID before planning. Its signature, command list/budget, output schema and metadata-only flags are unchanged. A normal-only observation remains supported with its own matching raw image. Existing fixtures now provide that real input field.

The exact new three-case test fails two wrong-image refusal cases and passes the valid case before the fix, then passes all three after it. It covers valid-but-different raw IDs, absent IDs and passing an official reference in place of the raw ID, plus matching and normal-only inputs. Only three affected caller cases were also checked: held factory/local Node projection, credential-free metadata snapshot and serialized stopped-container-exception refusal. Old test groups were not rerun. Python AST2, Node syntax4 and diff checks pass; all Docker terminal/canonical records remain synthetic and the held factory still stops before phase0.

This only binds configured raw-image inputs to the declared selected raw ID. It does not verify the official-ref-to-daemon-image relationship, authenticate a serialized plan, produce a real Docker terminal bundle or grant host writer authority. Maintenance fixed execution conditions, parent ACL/mount authority, interval-wide writers, production composite/normal shell transactions and later phases remain unconnected. Whole Draft NOTDEPLOYABLE, unmerged and undeployed; no new controller, public CLI, lock/identity scheme, host/daemon operation or retired helper.
