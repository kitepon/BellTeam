# 運営の通知中継

利用者のコンテナはAPNsの秘密鍵を持たず、利用者のサーバーが、アプリから受け取ったプッシュ券（ticket、login-billing 0.10.0）と通知をこのサービスへ送る。券は封がしてあって中身は読めず、サーバーはパスを持たない。このサービスはWorkerの `POST /auth/v1/ticket/check` へ `{ ticket }` を渡し、答えの `entitlements`（このアプリの商品が apple・google・exempt で期限内か）と `value`（アプリが券に結んだ端末トークンのSHA-256、小文字16進）だけを見る。`value` が送り先の端末トークンのハッシュと違えば、他の端末へは送らない。券が無効・期限切れなら401（`TICKET_INVALID`・`TICKET_ENDED`）、端末違いは401（`TICKET_DEVICE_MISMATCH`）、契約が無ければ402（`SUBSCRIPTION_REQUIRED`）、Workerに届かなければ502（`SUBSCRIPTION_CHECK_FAILED`）を返す。APNsの要求は `ticket`、FCMの要求は `proof: { ticket }` で送る。

追加の利用者ID・端末台帳・配送キューは持たず、失敗の再試行もしない。端末登録は利用者のコンテナが既存の保存先で所有する。サービスのエラーはコンテナへ返し、既存の通知診断へ記録する。会話本文・秘密入力値・Appleの鍵は通知の送信データへ含めない。

## 起動

リポジトリ直下で `npm ci` し、`node services/notifications/index.mjs` で起動する。運営のHTTPS公開先からこのNode.jsサービスへ転送する。`HOST` と `PORT` はNode.jsの待受設定に使う。

`BELLTEAM_APNS_DIRECTORY` は運営が保存した `config.json` と `.p8` ファイルのあるディレクトリを指定する。形式は既存の [APNs設定](../../docs/push-notifications.md) と同じ。鍵は鍵ごとに `{keyId, file}`（`.p8`）か `{keyId, reference}`（`op://<保管庫のID>/<アイテムのID>/<フィールド>`、値は `.p8` の全文）を選べる。referenceを使う時は `op`（PATH上か `OP_CLI_PATH`）と `OP_SERVICE_ACCOUNT_TOKEN` を起動環境に置く。鍵を替える時は `config.json` を書き換えてサービスを再起動する。購読の確認には `BELLTEAM_TICKET_CHECK_URL`（Workerの `POST /auth/v1/ticket/check`、例 `https://bellteam-login-test.kitepon.dev/auth/v1/ticket/check`）が必要で、Workerの仕様は [ログイン・課金Worker](../subscriptions/README.md) に従う。ProductionとSandboxの中継はそれぞれ別のWorkerを指す。中継はApple・Googleの鍵もkKeyも持たない。鍵と環境変数の値をリポジトリや利用者向けイメージへ含めない。

利用者は追加機能の通知設定へこのサービスのルートURLを登録する。通知設定の変更時は `GET /v1/notifications/status` で実接続とAPNsの設定済み環境を確認する。`POST /v1/notifications/send` は `{signedTransaction,device,payload,id}` を受け取る。`device` と `payload` は `src/push-notifications.mjs` の共通実装が生成する。

BellTeamは `await notifications.configure({enabled,relayUrl})` で保存済み設定を起動時と変更時に反映する。既存のAPNs設定がある個人環境は初回だけ通知ONへ移行し、relayURLが空なら直送する。画面でOFFを保存すると次回起動もOFFを守る。空の公開volumeは未設定・OFFから始まる。relayの接続確認と送信の失敗は `notifications.status().error` と既存の `SERVER_PUSH_FAILED` 診断へ残す。

## 運営の公開先

本番の中継は `https://bellteam-push.kitepon.dev`（main-server の独立したサービス `bellteam-push`、`HOST=172.18.0.1`、`PORT=18920`、Cloudflare Tunnel と Caddy の先）。券だけを受け、`BELLTEAM_TICKET_CHECK_URL=https://bellteam-login.kitepon.dev/auth/v1/ticket/check` を向く。Appleの課金鍵は持たないので、旧形の `signedTransaction` の要求は受けない。`GET /v1/notifications/status` は認証なしで、`BELLTEAM_TICKET_CHECK_URL` があれば200、無ければ503（運営の死活確認に使う）。APNsの鍵は起動時に1回だけ読んでメモリに持つ。再配置は main の `services`・`src`・パッケージ定義を `/home/kite/bellteam-push` へ置いて `npm ci --omit=dev` し、再起動を依頼する。

## Android（FCM）

`BELLTEAM_FCM_DIRECTORY` に運営のFirebaseサービスアカウントの設定（`config.json` と鍵のJSON、形式は [fcm-push](../../docs/architecture/modules/usage/fcm-push.md) の「Server configuration」）を置くと、`POST /v1/notifications/fcm/send` が有効になり、`GET /v1/notifications/status` に `android:true` が付く。無ければ従来の応答のまま。`{proof,device,id,message}` を受け取り、`proof`（購読確認サービスがそのまま受け取る1つの証明）を検証入口へ変更せず渡して、有効な購読だけを送る。`message` は閉じた形（利用者の端末のtokenとserver、固定チャンネル）だけを通す。Appleの経路は変えない。

## 検証の根拠

APNsの認証キーと送信ヘッダーはAppleの [token-based connection](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns) と [notification requests](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns) に従う。購読は [Apple公式ライブラリ](https://github.com/apple/app-store-server-library-node) の `SignedDataVerifier` と `Get All Subscription Statuses` を既存の検証入口から使う。

自動試験は `node --test test/push-notifications.test.mjs test/notification-relay.test.mjs`。実際のApple照会、公開relayへの接続、端末の通知表示は未確認。
