# Web受付（web-gateway）

責任者：アドミ。ブラウザ版は2026-11-22に終了した（Owner判断）。このmoduleに残るのは、ネイティブアプリが使う**公開入口**（web-gateway）だけで、画面コードと画面の配信は無い。履歴は[廃止した画面の記録](../../../archive/web-ui/README.md)。

[接続情報](module.json)から[全体図](../../feature-map.md)を生成する。[担当・変更手順](../../module-ownership.md)に従い、使用先の[integration](../integration/README.md)と接続する。

正本は[公開受付が返すもの・内蔵版戻し](gateway-builtin.md)（受付が通す経路、お知らせ、版交換の内蔵版選択/採用、更新adapter）。固定資材のreader/配置は[runtime](../runtime/web-gateway-release.md)、Owner認可・共通排他・ledgerは[integration](../integration/README.md)が所有する。

| 公開窓口 | 入力 | 出力・所有 |
| --- | --- | --- |
| `gateway` / `createHttpGateway({socketPath, assetVersion})` | アプリからのHTTP | `/api/*`と`/healthz`は業務processへそのまま転送。それ以外は410の終了のお知らせ（版を`x-bellteam-gateway-version`に載せる）。認可は業務processだけが持つ |

## 担当範囲

- `src/http-gateway.mjs`、`src/http-gateway-entry.mjs`、`src/http-gateway-process.mjs`（受付の子process、版交換）
- `src/web-gateway-control.mjs`、`src/web-gateway-release.mjs`、`src/web-gateway-update-adapter.mjs`、`src/web-gateway-install-plan.mjs`（固定資材の選択・採用・更新adapter。読み書きの境界はruntime/integration）
- 無いもの: 画面コード（`web/`）、画面の資材表、静的ファイル配信、Web通知の画面側。Web通知の送出と`webPush`設定は通知/usageの契約で、別工程。
