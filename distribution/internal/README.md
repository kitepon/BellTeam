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
