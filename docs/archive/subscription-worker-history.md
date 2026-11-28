# 購読検証の旧運営 Worker / Durable Objects 経緯（2026-11-24 廃止）

[subscription.md](../subscription.md) から分離した、2026-11-24 に運営の Worker（Durable Objects）をリポジトリから取り除く以前の設計・実測履歴。ログイン・課金確認に自前サーバーを持たない方針（a540、契約 1.42）への移行に伴いアーカイブした。

## 旧運営 Worker（Cloudflare Durable Objects）による照会方式

- 運営の Cloudflare Worker（Durable Objects）が Apple App Store Server API・Stripe・Google Play Developer API の最新購読状態を照会し、利用者のサーバーは検証結果だけを保存する方式だった。
- 2026-11-24 に本体リポジトリから運営 Worker（Durable Objects）を取り除いた（取り付け済みの 1.0.x アプリが読む旧検証 Worker だけが残存し、停止時に削除予定：`a540-old-verify-stop`）。
- 以降の新しいクライアント（Windows / Linux / Android 等）は、購読済みスマホと同一 LAN 内で直接暗号化通信するローカル確認方式（`login-billing` ローカル形式、QR コード経由）へ移行した。

## 2026-10 時点の旧 Worker 実測記録

- 無料の Durable Objects へ本番と Sandbox の照会口を配置し、不正なリクエスト・署名へのエラー応答を確認した。購入専用キーの secret 登録を完了。
- 購入専用キーによる Sandbox API への実通信は試験用取引 ID に `4040010`、存在しないキー ID に `401` を返し、認証疎通を確認。Production は未公開アプリのため `401`（[Apple 担当者の説明](../../rag/subscriptions/raw/apple-production-api-before-release.md)）。
- CPU 試験の数値・レポートは [report.json](../../experiments/subscription-worker-probe/report.json) が正本。通常の Worker では証明書検証が無料枠 CPU 上限を超え、Durable Objects では公開データ検証が成功（Object 内 CPU 集計は 2 期間とも空で未測定）。
- Stripe の実通信は未検証のままローカル形式へ方針転換した。
