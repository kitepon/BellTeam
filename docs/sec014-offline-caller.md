# 段2の停止中移行の呼出し

Draft PR42 の途中工程。利用者分離全体はまだ NOTDEPLOYABLE であり、この変更だけを main や本番へ出さない。

公開 installer は Compose の停止成功と既存 writer 検査の後に、選択image内の固定 `state-maintenance` serviceへ `to-server` を渡す。通常serviceへのroot/entrypoint指定とHOME/data親の一括chownは行わない。実排他の維持と通常再開の受入は未完であり、検査snapshotだけを実行許可にしない。

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

内部のsec014-host-actor.pyは既host_controlの親lockFDを全区間保持し、prepare→全writer確認→両viewbackupを含む現在directionの移行→bind確認→許可された片方normal起動→結果確認の6メソッドだけを正順で呼ぶ。各結果は同direction/image/actor PID出生/phaseとverified状態、工程固有の証拠SHA集合がそろった時だけroot専用0600 sidecarへO_EXCLで保存・fsync・metadata再読し、その後でjournalのphaseを進める。拒否/例外/receipt保存失敗では後続を呼ばずincompleteを保持する。最新reverseも同lock/別directionであり、旧backupの自動restoreはしない。

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

## Installer maintenance mount inputs (source only)

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
