# 審査用サーバーとDexのCA更新

審査用の既存Composeへ、受入済みimageを選ぶ追加ファイルを最後に重ねる。対象は別々のprojectで、サーバーは `bellteam-review` の `bellteam`、Dexは `bellteam-review-login` の `dex`。追加ファイルが指定するのはimageだけで、既存の設定・資格情報・DB・保存先・user・entrypoint・portは元のComposeを使う。

サーバーは通常のBellTeam配布で受け入れた製品imageを使う。DexのCA修理sourceは [Dockerfile.dex](Dockerfile.dex)。[10月25日の隔離結果](../../../docs/evidence/2026-10-25-sec021-review-ca-preparation.md)は履歴であり、その候補の現在の存在や今回の配備許可を示さない。現物受入で得た参照をそれぞれ `BELLTEAM_REVIEW_SERVER_IMAGE` / `BELLTEAM_REVIEW_DEX_IMAGE` へ指定する。既定のtagや保存済みのlocal image IDへの代替は設けない。

## 反映前

担当がそれぞれの現在のimage・Compose file順・project・service・設定と最新データの保存・戻し方を確認し、受入済みsource/imageを結ぶ。候補のOS束はG3・AAA無し/G1保持、サーバーのNode同梱根もG3無しを確認する。配布担当の事前受入、審査作業との調整、各対象の既存承認、ホストの開始条件が揃うまでは以下を実行しない。専用host補助の起動・発行・復元は使用しない。

反映時には、各projectの既存 `.env` の他の値を保ち、以下の3キーだけを追記または更新する。imageの空欄は受入原本の正確な参照で埋める。設定全体を例で上書きしない。これにより次回の通常 `docker compose up` も同じ追加ファイルとimageを使い、一回だけの `-f` 指定が消えて旧CAへ戻ることを防ぐ。[Composeの `.env` とfile選択](https://docs.docker.com/compose/how-tos/environment-variables/envvars/)を使用する。

`runtime/apple-review/server/.env` の対象キー：

```dotenv
COMPOSE_PROJECT_NAME=bellteam-review
COMPOSE_FILE=compose.yaml:compose.override.yaml:../../../distribution/apple-review/sec021/compose.bellteam-ca.yaml
BELLTEAM_REVIEW_SERVER_IMAGE=
```

`runtime/apple-review/identity/.env` の対象キー：

```dotenv
COMPOSE_PROJECT_NAME=bellteam-review-login
COMPOSE_FILE=compose.yaml:../../../distribution/apple-review/sec021/compose.dex-ca.yaml
BELLTEAM_REVIEW_DEX_IMAGE=
```

既存のComposeを先頭に置き、bind先等の相対pathの基準を変えない。[標準マージ規則](https://docs.docker.com/compose/how-tos/multiple-compose-files/merge/)に従い、追加ファイルは最後に置く。実行元はそれぞれのproject directoryとし、shell側の同名変数や `COMPOSE_FILE` で保存値を上書きしていないことを確認する。

条件成立後に、対象ごとに一回ずつ通常の更新を行う：

```sh
cd /home/kite/BellTeam/runtime/apple-review/server
docker compose up -d --no-deps --no-build --pull never bellteam
```

```sh
cd /home/kite/BellTeam/runtime/apple-review/identity
docker compose up -d --no-deps --no-build --pull never dex
```

上は保存済みの配置に対応する手順で、現在の配置の再確認を省略しない。必要なimage取得は受入対象の参照へ限定し、更新の前に済ませる。更新時の [`--pull never`](https://docs.docker.com/reference/cli/docker/compose/up/) は確認済みimageが無い場合の自動取得を止める。合成設定での事前確認には `config` を使い、実設定の展開結果や秘密を通常ログへ出さない。`down`、volumeの削除、DBや資格情報のコピーは更新手順に含めない。

失敗・時間切れ・終端不明では、その時点の結果を保存して止める。別imageへの自動代替、同じ更新の再送、作成済みcontainerの自動削除はしない。戻しは確認した元のimage参照と既存の最新設定・データを使い、別途の許可範囲で同じ追加ファイルへ指定する。古いCAへ戻した対象をSEC021対応済みにしない。

## 反映後

対象ごとに実際のimage・起動時刻・OS束と必要なNode同梱根、審査用の通常接続を確認する。imageの受入だけでなく設定と最新データの保持も確認し、Anchorへ対象別の証拠を渡す。稼働中の確認前は2対象をopenのまま扱う。
