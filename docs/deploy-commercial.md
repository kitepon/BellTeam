# 受入済み商用イメージを内部へ反映する

BellTeam更新前は、内部本番を含め必ず配布担当センチへ対象SHA・image・差分を渡し、必要な事前試験と結果を受け取る。可能な限り商用コンテナを内部で先に利用し、内部受入の結果を外部への同じdigestの昇格へ返す。

正規入口は引き続き`scripts/deploy.sh`一回。imageを指定しない従来のbuild経路も残る。内部の停止・再作成の個別許可とメンバーの稼働条件は維持し、試験合格だけを本番実行許可とはしない。

## 反映前に揃えるもの

- cleanなmain checkoutと、センチが受け入れた`repo@sha256:完全digest`。候補imageのsource revision/distribution.jsonと対象Git SHAの対応、arch・CLI実版・必要な試験結果を照合する。latestタグや別の再buildを代用しない。
- [内部Compose差分](../distribution/internal/README.md)の保存先、既存HOME/data/Throughline追加bind/Cursor volume、内部profileの固定SHA/hash。imageが同じでも実効profileは内部で異なることを記録する。
- 整合したデータの復旧点と旧image、Cursor volumeを含む戻し方。処理待ち一覧の控えだけを全データbackupと呼ばない。
- 既存の稼働条件と反映担当。作業中の席を止めてquietを作らず、結果不明の配送も別に正規復旧へ渡す。

## 実行経路

通常の候補作成workflowは、各archの `server-image-ca-<arch>-<attempt>` に、CA採取に使用したlocal image IDを含む `image-built.json`、OS bundle原bytesをbase64・Node同梱根と採取Nodeの既定CAを別のPEM配列として保存した `roots.json`、push後の同image IDとRepoDigestsを含む `image-published.json` を保存する。`server-image-index-<attempt>` は登録したindexのraw JSON・source・参照を保存する。どちらもworkflowのrun/attemptに属する資料で、失敗時の不完全な資料も残る場合がある。

反映担当とセンチは、image ID・arch・source label・roots内のdistribution sourceと、公開index/各manifest/configの対応を照合して同じ製品imageへ結ぶ。OS bundleとNode同梱根の内容を判定し、必要な通常TLSと製品互換を確認してから受け入れる。資料の存在だけではCA合格やreview固有設定への互換・配備許可にならず、過去imageの不足原本を補完しない。Node同梱根のPEM配列は [tls.rootCertificates](https://nodejs.org/api/tls.html#tlsrootcertificates) の取得結果で、稼働環境の追加根や実効TLSの確認とは分ける。

`roots.json` の `nodeDefaultRootsPem` は、同じ固定local image IDから起動した採取プロセスでの [tls.getCACertificates("default")](https://nodejs.org/api/tls.html#tlsgetcacertificatestype) の原PEM配列。`nodeBundledRootsPem` は従来の同梱根として別に保持する。採取には製品設定・稼働volumeを渡さず、配備先の環境変数/起動flag/追加CA・アプリが明示するca設定や後から変更する既定根を再現するものではない。CA採取失敗を同梱根で代替せず、既workflowの失敗と不完全artifactとして扱う。通常TLSの実接続と、稼働設定に対応するCA受入は反映前に別途確認する。

受入済みdigestと観測から除く実行担当Botを環境変数へ指定し、正規入口を呼ぶ。

```sh
BELLTEAM_DEPLOY_IMAGE='ghcr.io/kitepon/bellteam-server@sha256:受入済みの完全digest' \
BELLTEAM_DEPLOY_QUIET_EXCEPT='bot-実行担当' \
sh scripts/deploy.sh
```

入口はcommitをGitHub mainへpushし、本番checkoutをff-onlyで取り込んで処理待ち一覧を控える。指定image経路は本番側で切り離した`scripts/deploy-image.sh`へ進み、次の順で一度反映する。

1. 公開compose＋内部overlayをrepo絶対pathで指定する。projectはbellteam、内部profileは同checkoutのsrc/distribution-profile.mjs。
2. 指定digestを取得し、そのimageからCursor更新scriptとupdater用composeを読み出す。本体を停止しない。
3. 既存quiet①→抽出したCursor updater→既存quiet②→同digestのcompose up。再buildせず、up時も別imageをpullしない。
4. 既存のdeployログ/exit、health、実CLI版とBot状態を返す。反映担当は実image/source/profile/永続状態も照合する。

抽出updaterは同じrepo cwd/COMPOSE_FILE/project/image/profile環境を引き継ぐ。共有update-cursor.shは書き換えず、内部adapterで既存2地点のquietを維持する。public installerのstop→Cursor→upと同じ停止順だとは説明しない。

取得・抽出・quiet①の失敗ではCursor/upを実行しない。Cursor失敗/quiet②失敗ではupしない。旧本体は入替前まで稼働するが、Cursor更新を試みた後のvolumeは変更されている場合がある。旧imageだけで全CLIが元に戻るとはせず、受入済みの復元手順を使う。結果不明時に入口を二度呼んだり、旧本文を自動で送り直さない。
