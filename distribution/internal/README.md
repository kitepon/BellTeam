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

内部adapterは、候補image取得/選択image由来の更新資材抽出→既存quiet①→Cursor updater→既存quiet②→同imageのcompose up/recreate、の順を使う。quiet②までは旧本体を止めない。商用installerのstop→Cursor→upをそのまま実行せず、publicの停止順も変更しない。

候補取得より前に、旧本体のcontainer IDと実image IDを `runtime/backups/image-before-deploy.XXXXXX/container-image.txt` へ記録し、そのimage IDを `image.tar` へ保存する。`image.tar.sha256` は保存bytesの照合用で、標準の `sha256sum -c` はrepoの作業directoryから使う。控え先は毎回別の0700 directory、fileは0600で、ログへ `previous-image=` と保存先を出す。inspect/save/hashに失敗すれば候補取得・Cursor更新・本体再作成へ進まず、途中の控えも削除しない。

これはimageの保全だけで、整合したdata/HOME/Cursor volumeの復旧点ではない。queue控えやquiet①②も全writerの排他・DBとfile全体の同時点を証明しない。更新前に今回の整合復旧点と最新dataの確認方法を別に確定する。設置固有の夜間backupはDBごとのonline backupとfile走査であり、Cursor volumeの `state/` の控えを更新前CLI全体の保存へ代用しない。復元用imageの読込み・実際の戻しは本adapterに追加せず、最新dataとの互換性と実行許可を別に確認する。保存容量の既条件やホスト開始不可は緩和しない。

同じ控え先には、元のfull container IDを使った `/home/bell/.local` のmount type/nameを `cursor-volume.txt` に保存する。内部overlayの固定volume `bellteam_cursor-cli` と一致する場合だけ、その同じCIDでbell利用者として `scripts/archive-live-volume.py create /home/bell/.local` を実行し、`cursor.tar` と `cursor.tar.sha256` を残す。`raw/` はCLI本体・symlink・mode・stateを含む走査対象の物理コピー、`sqlite/` はSQLite online backup、最後の `manifest.json` はDB相対path/inode/deviceと可変物理コピーの上限/実収録bytesを記録する。通常fileは読取り前後の変更を拒否する。regular fileのSQLite headerとidentityで特定したDBと正確な同pathのWAL/SHM/journalだけ、取得開始時FDサイズまでの有限観測を一時fileへ収録し、その実bytesをtarへ入れる。truncateによるshort readは観測長として記録する。可変物理コピーはDB整合復元用でも、元fileの全時点・完全bytesでもない。整合DBは別のonline backupで保存する。

DB/sidecarのlinkやSQLite hardlink、DB identity変更、通常file/DBの走査前後のnamespace変更、通常file変更、SQLite backup/quick_check/120秒期限・一時領域・tar・hash失敗では途中原本を残し、候補pull/Cursor更新/upへ進まない。openはnonblockingとFD regular型確認を併用し、FIFO化で待ち続けない。read-onlyのSQLite backup自体もWAL/SHMを生成するため、初期header/identityで特定したDBに対応するexact sidecarだけは生成・削除・再生成を許容し、manifestのsidecar_changesへ前後のdevice/inode（不在はnull）を記録する。終了時に存在するsidecarは単一regular fileに限り、link/FIFO/aliasは拒否する。rawは初期走査時に存在したfileの観測であり、後からできたsidecarの全bytesを保存したとは扱わない。復元には引続き論理DBだけを使う。初期sidecarの物理読取り前の消失などは失敗するため、全writer/全状況での前進保証はない。複数DBと通常fileは同時点のsnapshotではない。writer停止や再試行の反復で条件を作らない。

隔離復元の確認には、archive SHAを照合した上で `python3 scripts/archive-live-volume.py restore /absolute/path/cursor.tar /absolute/path/new-staging` を使う。復元先は存在しない通常directory名とし、既存volume/実DBへ試験目的で戻さない。manifestに対応したraw DB/sidecarは復元namespaceへ最初から入れず、通常file/CLI/link/modeと論理DBだけを新stagingへ構築する。重複member/不正path/親symlinkによる外部参照・欠けたDB・壊れたsnapshotは拒否する。raw全体へsnapshotを重ねる復元は禁止する（古WALでデータが後退し得る）。元raw証拠はarchive内に残る。復元fileの所有者は実行者になり、実際のvolumeへ戻す時のbell UID/GIDへの対応は、停止・戻しの既手順と併せて確認する。新archive形式を旧tar展開blockへ渡さない。自動のvolume差替えや実DB復旧は行わない。

file保全は既quiet①より前に行い、quiet①→Cursor更新→quiet②→upの間へ長いarchive処理を挿入しない。tarは稼働volumeの読取りで、同時書込みの排除や一貫したsnapshotを作る処理ではない。今回dataの復旧点には既backupの世代・manifest（対象data/home、DB/fileと除外/失敗）と、上記の元CID/image・Cursor控えがどの停止・排他区間に対応するかを結ぶ必要がある。各DBの整合やarchive SHAだけで全体の同時点を補完せず、対応を確認できなければ整合復旧点は未成立のままとする。旧控えの自動復元・volumeの自動作成や書換えは追加しない。

`scripts/update-cursor.sh`を実行する際も、上記環境とrepoの作業directoryを維持する。同script内の `docker compose config` が同じ2file/project/外部volumeを読む必要がある。選択imageから抽出したupdater用composeは本体composeへmergeせず、既存scriptの `-f` 指定で単独実行する。共有update-cursor.sh自体の変更はこの差分に含めない。

本overlayは事前試験/本体review向け。profile適合以外の初期認証・既存不明席回復、両arch、整合backup/volume復元、既存停止許可と稼働条件を省略するものではない。反映時は対象と試験結果をセンチへ渡し、トロニーが本体互換と反映条件を照合する。

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
