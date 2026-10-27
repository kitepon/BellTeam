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

同じ控え先には、元のfull container IDを使った `/home/bell/.local` のmount type/nameを `cursor-volume.txt` に保存する。内部overlayの固定volume `bellteam_cursor-cli` と一致する場合だけ、その同じCIDでbell利用者として全内容を `cursor.tar` へ読み出し、`cursor.tar.sha256` を残す。CLI本体・symlink・modeとstateを含むfile保全で、夜間のstateのみの控えとは異なる。mount確認・tar・hashが失敗すれば途中原本を残し、候補pull/Cursor更新/upへ進まない。候補715から抽出する更新scriptを変更しなくても、この保全はhost checkoutのadapterが先に行う。

file保全は既quiet①より前に行い、quiet①→Cursor更新→quiet②→upの間へ長いarchive処理を挿入しない。tarは稼働volumeの読取りで、同時書込みの排除や一貫したsnapshotを作る処理ではない。今回dataの復旧点には既backupの世代・manifest（対象data/home、DB/fileと除外/失敗）と、上記の元CID/image・Cursor控えがどの停止・排他区間に対応するかを結ぶ必要がある。各DBの整合やarchive SHAだけで全体の同時点を補完せず、対応を確認できなければ整合復旧点は未成立のままとする。旧控えの自動復元・volumeの自動作成や書換えは追加しない。

`scripts/update-cursor.sh`を実行する際も、上記環境とrepoの作業directoryを維持する。同script内の `docker compose config` が同じ2file/project/外部volumeを読む必要がある。選択imageから抽出したupdater用composeは本体composeへmergeせず、既存scriptの `-f` 指定で単独実行する。共有update-cursor.sh自体の変更はこの差分に含めない。

本overlayは事前試験/本体review向け。profile適合以外の初期認証・既存不明席回復、両arch、整合backup/volume復元、既存停止許可と稼働条件を省略するものではない。反映時は対象と試験結果をセンチへ渡し、トロニーが本体互換と反映条件を照合する。
