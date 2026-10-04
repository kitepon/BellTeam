# 運営の通知中継

利用者のコンテナはAPNsの秘密鍵を持たず、通知先端末に登録された本人の署名付き購入情報と通知をこのサービスへ送る。共有サーバーに保存された別の端末の購入情報は使わない。このサービスは `services/subscriptions/worker.mjs` の公開検証入口を呼び、Appleの署名検証と最新の購読状態の照会を行う。有効な購読だけを `APNsProvider` へ渡し、APNsのHTTP 200を確認してから `{accepted:true}` を返す。APNsが受理した後の端末への表示は端末で確認する。Webの会話とサーバーの予定実行は、この通知の購読確認にかかわらず無料で継続する。

追加の利用者ID・端末台帳・配送キューは持たず、失敗の再試行もしない。端末登録は利用者のコンテナが既存の保存先で所有する。サービスのエラーはコンテナへ返し、既存の通知診断へ記録する。会話本文・秘密入力値・Appleの鍵は通知の送信データへ含めない。

## 起動

リポジトリ直下で `npm ci` し、`node services/notifications/index.mjs` で起動する。運営のHTTPS公開先からこのNode.jsサービスへ転送する。`HOST` と `PORT` はNode.jsの待受設定に使う。

`BELLTEAM_APNS_DIRECTORY` は運営が保存した `config.json` と `.p8` ファイルのあるディレクトリを指定する。形式は既存の [APNs設定](../../docs/push-notifications.md) と同じ。購読確認には `APPLE_ENVIRONMENT`・`APPLE_ISSUER_ID`・`APPLE_KEY_ID`・`APPLE_PRIVATE_KEY` が必要で、意味と取得方法は [購読確認サービス](../subscriptions/README.md) に従う。ProductionとSandboxの購読確認はそれぞれ別の実行環境にする。鍵と環境変数の値をリポジトリや利用者向けイメージへ含めない。

利用者は追加機能の通知設定へこのサービスのルートURLを登録する。通知設定の変更時は `GET /v1/notifications/status` で実接続とAPNsの設定済み環境を確認する。`POST /v1/notifications/send` は `{signedTransaction,device,payload,id}` を受け取る。`device` と `payload` は `src/push-notifications.mjs` の共通実装が生成する。

BellTeamは `await notifications.configure({enabled,relayUrl})` で保存済み設定を起動時と変更時に反映する。既存のAPNs設定がある個人環境は初回だけ通知ONへ移行し、relayURLが空なら直送する。画面でOFFを保存すると次回起動もOFFを守る。空の公開volumeは未設定・OFFから始まる。relayの接続確認と送信の失敗は `notifications.status().error` と既存の `SERVER_PUSH_FAILED` 診断へ残す。

## 検証の根拠

APNsの認証キーと送信ヘッダーはAppleの [token-based connection](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns) と [notification requests](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns) に従う。購読は [Apple公式ライブラリ](https://github.com/apple/app-store-server-library-node) の `SignedDataVerifier` と `Get All Subscription Statuses` を既存の検証入口から使う。

自動試験は `node --test test/push-notifications.test.mjs test/notification-relay.test.mjs`。実際のApple照会、公開relayへの接続、端末の通知表示は未確認。
