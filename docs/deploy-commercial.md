# 受入済み商用イメージを内部へ反映する

BellTeam更新前は、内部本番を含め必ず配布担当センチへ対象SHA・image・差分を渡し、必要な事前試験と結果を受け取る。可能な限り商用コンテナを内部で先に利用し、内部受入の結果を外部への同じdigestの昇格へ返す。

正規入口は引き続き`scripts/deploy.sh`一回。imageを指定しない従来のbuild経路も残る。内部の停止・再作成の個別許可とメンバーの稼働条件は維持し、試験合格だけを本番実行許可とはしない。

## 反映前に揃えるもの

- cleanなmain checkoutと、センチが受け入れた`repo@sha256:完全digest`。候補imageのsource revision/distribution.jsonと対象Git SHAの対応、arch・CLI実版・必要な試験結果を照合する。latestタグや別の再buildを代用しない。
- [内部Compose差分](../distribution/internal/README.md)の保存先、既存HOME/data/Throughline追加bind/Cursor volume、内部profileの固定SHA/hash。imageが同じでも実効profileは内部で異なることを記録する。
- 整合したデータの復旧点と旧image、Cursor volumeを含む戻し方。処理待ち一覧の控えだけを全データbackupと呼ばない。
- 既存の稼働条件と反映担当。作業中の席を止めてquietを作らず、結果不明の配送も別に正規復旧へ渡す。

## 実行経路

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
