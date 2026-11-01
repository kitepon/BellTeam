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

候補取得より前に、旧本体のcontainer IDと実image IDを `runtime/backups/image-before-deploy.XXXXXX/container-image.txt` へ記録し、そのimage IDを `image.tar` へ保存する。`image.tar.sha256` は保存bytesの照合用で、標準の `sha256sum -c` はrepoの作業directoryから使う。控え先は毎回別の0700 directory、fileは0600で、ログへ `previous-image=` と保存先を出す。inspect/save/hashに失敗すれば候補取得・Cursor更新・本体再作成へ進まず、途中の控えも削除しない。

これはimageの保全だけで、整合したdata/HOME/Cursor volumeの復旧点ではない。queue控えやquiet①②も全writerの排他・DBとfile全体の同時点を証明しない。更新前に今回の整合復旧点と最新dataの確認方法を別に確定する。設置固有の夜間backupはDBごとのonline backupとfile走査であり、Cursor volumeの `state/` の控えを更新前CLI全体の保存へ代用しない。復元用imageの読込み・実際の戻しは本adapterに追加せず、最新dataとの互換性と実行許可を別に確認する。反映には現在のオーナー指示と、今回の停止・復旧条件を使う。

同じ控え先には、元のfull container IDを使った `/home/bell/.local` のmount type/nameを `cursor-volume.txt` に保存する。内部overlayの固定volume `bellteam_cursor-cli` と一致する場合だけ、その同じCIDでbell利用者として全内容を `cursor.tar` へ読み出し、`cursor.tar.sha256` を残す。CLI本体・symlink・modeとstateを含むfile保全で、夜間のstateのみの控えとは異なる。mount確認・tar・hashが失敗すれば途中原本を残し、候補pull/Cursor更新/upへ進まない。候補715から抽出する更新scriptを変更しなくても、この保全はhost checkoutのadapterが先に行う。

file保全は既quiet①より前に行い、quiet①→Cursor更新→quiet②→upの間へ長いarchive処理を挿入しない。tarは稼働volumeの読取りで、同時書込みの排除や一貫したsnapshotを作る処理ではない。今回dataの復旧点には既backupの世代・manifest（対象data/home、DB/fileと除外/失敗）と、上記の元CID/image・Cursor控えがどの停止・排他区間に対応するかを結ぶ必要がある。各DBの整合やarchive SHAだけで全体の同時点を補完せず、対応を確認できなければ整合復旧点は未成立のままとする。旧控えの自動復元・volumeの自動作成や書換えは追加しない。

`scripts/update-cursor.sh`を実行する際も、上記環境とrepoの作業directoryを維持する。同script内の `docker compose config` が同じ2file/project/外部volumeを読む必要がある。選択imageから抽出したupdater用composeは本体composeへmergeせず、既存scriptの `-f` 指定で単独実行する。共有update-cursor.sh自体の変更はこの差分に含めない。

本overlayは事前試験/本体review向け。profile適合以外の初期認証・既存不明席回復、両arch、整合backup/volume復元、既存停止許可と稼働条件を省略するものではない。反映時は対象と試験結果をセンチへ渡し、トロニーが本体互換と反映条件を照合する。


imageを指定しない正規deployも同じadapterを使います。repoの`compose.yaml`で従来どおり`build --pull --no-cache`し、`config --images`で得たbuild tagをローカルIDへ解決してから、上記内部normal/prepare/maintenanceへ渡します。この場合registryからの再pullは行いません。明示した商用immutable imageの経路は従来どおりpullし、quiet対象必須を維持します。build経路のquiet指定は従来どおり任意ですが、今回の段2本番実行では既承認のquiet条件と具体窓を満たします。

保存世代には実行した専用`compose.state-maintenance.json`も0600で保持します。新しい.envからmaintenanceを再合成せず、同世代の固定image/二view/backup対応を逆移行の入力に使います。これだけで旧本体の起動設定を保存したとは扱いません。移行用imageと切戻し後の通常起動用imageは別に記録し、最新dataを既専用口の`to-legacy`で戻してから、対応が確認できた旧normal/旧imageで再開します。順逆どちらの失敗でも、停止・元data・途中backupと選択設定を保ち、無根拠のupや自動rollbackは行いません。実旧normalの保存と最新世代での逆移行・health受入は未完です。
通常quiet判定は、探索した複数Botが同じsessionを指す場合、そのidle結果を共有せず既存のunclassifiedへ分類する。queueが空でも、その状態では更新へ進まない。Bot設定/sessionを自動変更したり停止したりする処理は追加しない。これは当該snapshotの対応付けだけで、全writer排他や後続の再spawn抑止の証明ではない。

### quietの探索前後と不明結果（source確認範囲）

通常のcheckDeployQuietは、前queue→初回席探索→turn読取→最終席探索→後queueの順で判定する。各入力の既処理は次のとおり。これは現sourceの確認で、新しい実観測や追加試験の結果ではない。

| 変化・失敗 | 既処理 |
| --- | --- |
| queue取得失敗・前後itemsが配列でない | 例外としてCLIの固定警告/exit2へ進み、更新を続行しない |
| 席一覧そのものの読取失敗 | 例外として止まる |
| 各PIDのENOENT/ESRCH以外の読取失敗 | 初回/最終unknownを合算しquiet=false |
| 既候補Botのprofile欠測・不正 | session=nullの席を残しunclassifiedにする |
| turn読取の失敗・不明・idle以外 | running又はunclassifiedとしてquiet=false |
| 初回席の最終消失又はsession/candidates差 | 既turnをnullへ戻して初回席を残し、unclassifiedにする |
| 最終探索だけに現れたBot | 席を追加してturnをnullとし、unclassifiedにする |
| 前後queueで別Botを発見 | queuedとしてquiet=false |

候補の照合はsessionとPID/PPID/start tick/executableのmetadataで行う。各PIDが探索中に消えた時のENOENT/ESRCHは、その探索では候補へ加えない。初回に拾えた候補の後の消失は上記の再照合で保留するが、両探索の間だけに存在したprocessや、探索対象外のexe/cwd・writerを捕捉したとは言わない。自席exceptの除外も維持する。

今回のsource照合では、これらの失敗をquiet成功へ扱う追加の修理対象は見つからなかった。queueやidleのsnapshotを実行区間全体のwriter停止/respawn抑止・整合dataCursor復旧点・本人の安全解除へ代用しない。CLIはquiet不成立時もexit2、呼出shellはset-e又は&&でCursor/upへ進めない。新しいobserver/hostlock/runnerや再採取は追加しない。

### FF前の旧通常設定の控え（段2・source確認範囲）

正規`deploy.sh`はremote clean/fetch後、FF前に旧CIDのCompose labelから既知のroot compose・公開+内部overlay・既保持normalのいずれかを選ぶ。labelのproject/working-directoryと明示env-fileを使い、旧Config.Image/profile bindの値で一回だけconfigを読む。推測のCompose再構成や、更新先normalを旧設定とする扱いはしない。暗黙.envは標準Composeのworking-directory規則に従い、未記録のshell環境は復元しない。config-hashが一致しなければFFへ進まない。

控えは新しいrepo直下`.bellteam-compose.XXXXXX`（0700）に作り、旧inspect/model/入力由来を0600で残す。標準JSONでdollarを正規化し、保存modelに対する標準Compose hashを旧labelと照合する。hashには除外fieldがあり、実runtime全体・外部file/inode・writer lifetimeの同値証明にはしない。未知の入力由来や不一致では固定警告だけを出して控えを保持する。既存世代は上書きしない。

固定`/app/src/distribution-profile.mjs`のreadonly bindは、同じ旧CIDのbell利用者からmode0644と内容を読み、private世代内にcodeとして保持する。切戻し用modelのこのbindだけを控えへ向け、imageを実inspectのraw Imageへ固定して`previous-normal.json`をrenameで公開する。元Config.Image/元modelは別に保持し、raw imageをOCI configへ補正しない。profile以外の外部file内容や実mount aliasは保存したと扱わない。

FF後は同じ控えの絶対pathを既adapterへ内部引数として渡す。adapterは既旧CID/image控えとStartedAtを照合し、private directory/fileの所有者・modeも確認して、`image-before-deploy.XXXXXX/previous-compose.path`へ対応を残す。秘密model本体を共有data側backupへ写さない。不一致なら候補取得・image/Cursor控え・停止へ進まず、元控えを保持する。低水準adapterを直接呼び、この引渡しを省いた場合を完全な旧設定保全とは呼ばない。

これは保存と受渡しのsource契約だけで、実label起点の復旧、最新二view backup後のto-legacy→対応旧normalでの再開/health、全writer停止維持、実親UIDACLaliasmountや正式image実CLI隔離の受入は未完。自動rollback/upは追加していない。whole Draft NOTDEPLOYABLE・未反映を維持する。


### 保存した新旧modelの対応（source確認範囲）

停止直前の`keep_saved=true`後に`saved-compose=`で出るprivate世代は、normalと実行maintenanceを保持する。正規deployから旧設定を受けた場合は、同世代の`recovery.json`（0600/rename公開）に`previousCompose`、`previousImageArchive`、`stateLayout`を残す。元設定やimage控えをlatest globから選ばず、このexact対応を使う。通常up失敗でもこの世代を保持し、stop前の公開失敗では新世代だけを除去して元設定と旧archiveを残す。

既存writer plannerに新旧normalと保存maintenanceを渡して、legacy data/六state/backup分離を照合する。project/HOME/Cursor volumeも一致させ、旧通常imageを同archiveと照合する。state targetの祖先や子へ未知のmountが重なる構成は旧/新とも拒否し、Cursor更新・停止へ進まない。字面での対応であり、実alias/mount/inodeや全区間writer排他は別の未受入条件である。

| stateLayout | 旧通常設定の読取り先 | 復旧の条件 |
| --- | --- | --- |
| legacy | 保存maintenanceと対応するlegacy root。六private state bindなし | 最新の両viewを控える既`to-legacy`が成功してから、対応する旧normalで通常再開 |
| server | 保存maintenanceと同じ六private state source | `to-legacy`を実行しない。最新二view backupと旧imageのformat互換を確認して、同じ私有stateを読む保存旧normalへ戻す。sourceは下記明示復旧へ接続、実機format互換は未受入 |

legacyの既逆移行口は、保存`compose.state-maintenance.json`を単独指定した`docker compose ... run --pull never --rm --no-deps -T state-maintenance to-legacy`。使うimageはその保存modelの移行用imageであり、旧normal起動imageではない。停止維持・writer検査・実view対応を揃えてから実行し、既処理が最新両view backup後に移す。途中失敗時はupへ進まない。成功後の通常再開は`previousCompose`の旧raw image/profile/bindを使い、新しい.envやcheckoutから再合成しない。過去data/Cursor tarを最新データへ自動復元する処理も追加していない。

ここではrecovery executorや新しい公開引数を追加していない。実stop→検査→逆移行→旧normal再開/healthの製品接続・受入、server layoutの最新backup/restart経路、現在HOME/Cursor保全、全writer lifetimeと実親UIDACLaliasmount、正式image実CLI隔離停止時間は未完。保存recordの存在を本番復旧成功やwhole Draftの配備可へ補完しない。


### 選択した保存世代の手動復旧（source検査用・実機受入前）

この固定手順は、今回の保存世代・実親/両view・全writer停止維持と、移行image/旧imageのformat互換をRootが受け入れ、現在HOME/Cursor/私有modelの別backupを確保した後に使う。過去のimage/Cursor archiveは最新dataや現在のHOME/Cursorの控えではない。現段階ではこれらが未受入なので、本番でこの手順を実行しない。新しい公開CLIや復旧helperを設置する手順ではない。

root保護されたrepoの作業directoryで、当回ログの`saved-compose=`に出た絶対pathを`saved`、既quiet対象を`quiet_except`へ明示する。以下は明示的な手動復旧の一回分であり、deploy失敗から自動では呼ばない。legacyは既CLIが最新二view backup後に逆移行し、serverは同じmaintenance serviceのenv-i/固定Nodeで既backup APIだけを順に呼ぶ。serverのbackup名に使う`to-legacy`は既APIの保存namespaceで、transfer CLIの呼出しではない。既complete/partial backupは上書きせず失敗する。どちらも失敗すれば起動へ進まない。

<!-- sec014-manual-recovery -->
```sh
set -eu
: "${saved:?saved-composeの絶対pathを選ぶ}"
: "${quiet_except:?quiet対象Botを選ぶ}"
sudo -n /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/root LANG=C.UTF-8 \
  /bin/sh scripts/deploy-image.sh --recover "$saved" "$quiet_except"
```

一回のhealth応答は通常再開の全受入ではない。起動直後の未応答も未確認として止まり、upや逆移行を再送しない。実際の旧CID/raw image/選択model、最新dataの通常readbackと各CLIを別に確認する。途中失敗では元/新設定・現在data・部分backupを保持する。staging以外をこの手順のcleanupで削除しない。現時点のsource検査はDocker効果をfakeにした呼出し/拒否の確認であり、実stop/UID/mount/backup/逆移行/health成功と全区間writer排他を証明しない。


### 固定normal入口へ渡す内部設定（段2・未配備）

内部overlayはreadonly control directoryとBELLTEAM_NORMAL_ADMISSION_TOKENを要求する。tokenはdeploy-image.shが同dispatchの最初のCompose操作より前に生成し、同じ値/mountをfrozen normalへ保存する。actor側が使うraw image/tokenはその元file SHAへ対応し、実選択値が違えばSH公開しない。host parentをDockerへ作らせず、既合意metadataのままとする。部品契約の詳細はdocs/sec014-offline-caller.md。正規内部adapterと明示復旧はprivate actorへsource接続済みで、実create/start/healthを検証する処理を持つ。公開installer基盤と実Host/正式imageの受入は未完。


### 保持世代からのprivate writer metadata収集（未配備）

`sec014-writer-collector.py`の`_Writer`は、同`run_actor`の`executor_factory(tx)`で保持したtxを受け、既`_writer_config`から既Node planner/verifierへ渡す。固定immutable refのimage inspectで返るraw ID（128B上限）を選択IDと照合してから、固定Docker LIST/inspect/volume inspectをそれぞれ8320B/1MiB/16KiBで取得する。imageのargv/raw/terminalも同じnative所有・保存・verifierへ渡し、最大command数はimageを含め131。stderr4096B、各10秒と全体期限の小さい方を使う。prepareの4slotやcapは変えない。Nodeは固定システム検索パスで解決し、固定プログラムへ有限metadataだけを渡す。

各native clientのclaim/spawn/terminal/rawを既O_EXCL0600保存で保持し、全clientのpid/startTicksを検査する。既Node verifierの消費とobservationの保存を終えるまでreapせず、成功後に同childだけwaitする。失敗はunknownを保存して後続を止め、Docker再送・kill・cleanupをしない。実canonicalを収集し、observed path欠落を拒否、planned path未作成は既存祖先をresolveしてsuffixを戻し、dangling symlink祖先は拒否する。

新focused試験は普通FS/flockと専用Python子のfake Docker protocolで、同held factoryからphase0へ呼ぶ。実Docker/固定ホスト権限の証明ではない。返却は既metadata-only/all authority falseのまま、phase receiptへ昇格させない。private compositeは固定maintenance/normal create/start/inspect/healthへsource接続済み。hostauthority、実daemonでのimagepair/親ACLmountと全writer区間は未受入。whole Draft NOTDEPLOYABLE・未merge未反映を維持する。

失敗時のnative childはcollectorだけでなく同txが保持し、`run_actor`はfactory/phaseの例外処理後も未回収childを持つtxをprivate failure ownerに残す。これによりfactory-local objectとtracebackの破棄/GCでPopenのdestructorが暗黙reapしない。自動kill/retry/owner解放は行わず、actorプロセスの寿命中に保持する。明示復旧は同actor/childの既存claim/終端記録を照合してから実行する。欠測/unknownは保持し、試験のfixture teardownを実回収と扱わない。新しい試験は別のPopen強参照もwait差替えも持たず、factory失敗→例外処理→GC後も同childがWNOWAIT可視であることを確認する。

failure ownerはnative client参照と同control FDを保持する。kernel lockの寿命は保有processに従い、process終了後もincomplete journalが次actorを拒否する。元actor/全childの終端と作用が確認できた明示復旧だけが、その原本を保持したまま後続処理へ進む。

明示復旧は正規root adapterの `--recover` からだけ実行する。保存pair/現在CIDの選択・root preflight→quiet→exact stop→元lockのEX→元actor/child終端確認→新二view backup→layout別回復→保存旧normal create/exact start/healthの順を同じactorへ接続する。data配置と旧imageのtoken/SH対応を別判定し、旧no-control imageへ新token/SH/UIDを付けない。旧imageが実token/SHを持つ時だけ、そのtokenと旧consumer互換の通常journalを同FDで引き継ぐ。持たない時はEXを健康確認まで保持し、専用 `recovery-to-legacy.json` と `legacy-recovered` を残す。これはlegacy runtimeのwriter排他を保証しない。次の保守にもexact stopと全writer検査が要る。

未完/unknown/非零mutationは元journalを削除せず停止し、同回復を再発行しない。成功時も元forward原本は変更せず、専用完了とreceipt chainを次の入口が確認してからinodeごと元generation履歴へ保存する。途中の履歴移動は `archiving` のまま止まり、新actor/normalを許可しない。隔離Python試験は実Node/child/lock/saveを用いるがDocker応答とHost policyはfixtureで、実Host/正式image全区間/停止時間/public受入は未成立。
