# BellTeamの通知

BellTeamはメンバーの返信（直接会話・ルーム）、秘密情報の入力要求、選んでほしいことをApple Push Notification service（APNs）へ送る。アプリを閉じていてもiOS・iPadOS・Macが通知を表示する。送信元がユーザー・予定である投稿と、Bot同士の直接連絡は通知しない。

通知にはメンバー名・ルーム名と固定の案内だけを載せる。会話本文、入力依頼の説明文、入力された値は載せない。アプリがメンバー一覧を読むと、各Botのアバター（512pxのJPEGなどの data URL）を App Group へ Bot ID ごとに保存する。通知サービス拡張はそのキャッシュだけを読み、送り主の名前とアバターを Communication Notification として表示する。ルームの通知（`roomName` があるもの）は、ルーム名をグループ名にした会話として表示する。送り主か保存済みアバターが無い、読み込み・寄付・書き換えに失敗した、または拡張が時間切れになった時は、サーバーが付けた title と body のまま届く。拡張は理由をOSのログへ記録する。アプリのアバター保存失敗はOSのログと既存の`IOS_PUSH_FAILED`診断へ記録し、会話の利用は続ける。App Group設定が不正な時はエラーとして記録し、別のグループへ切り替えない。拡張は通信しない。

通知をタップすると対象の会話を開く。未完了の入力要求なら専用の入力画面も開く。Cloudflare Accessの認証が切れていればログイン後に開く。別の接続先から届いた通知では画面を移動しない。

アプリを開いて同じ会話を見ている間はバナーと音を出さない。ほかの会話を見ているときは表示する。設定画面で登録状態を確認し、iPhoneの通知設定を開ける。ログアウト・接続先変更では端末登録を解除する。表示の可否と時刻はiOSの通知許可・集中モード・通知要約にも従う。

## 配布者の設定

Apple DeveloperのApp IDでPush Notificationsを有効にし、そのアプリのTopicと環境に対応したAPNs署名キーを発行する。TestFlightとApp Storeはproduction、Debugはdevelopmentを使う。App Store Connectのアップロード用APIキーとは別のキーである。

各コンテナの永続領域`/srv/bellteam/shared/tools/apns/`に秘密鍵と`config.json`を置く。ホストからは`runtime/data/shared/tools/apns/`に対応する。設定例の値はすべて各配布者のものに置き換える。

```json
{
  "teamId": "自分のTeam ID",
  "topic": "自分のBundle ID",
  "keys": {
    "production": { "keyId": "APNsのKey ID", "file": "AuthKey_production.p8" },
    "development": { "keyId": "APNsのKey ID", "file": "AuthKey_development.p8" }
  }
}
```

使わない環境の項目は省略できる。秘密鍵と設定はコンテナの実行ユーザーが読める権限にし、ファイルを0600にする。Gitやコンテナイメージには含めない。設定後は通常のデプロイで読み込ませる。設定がないコンテナでは通知送信は無効で、iPhoneの設定画面に未設定と表示する。

アプリの署名時には`BELLTEAM_APP_BUNDLE_IDENTIFIER`・`DEVELOPMENT_TEAM`を対応する値へ指定する。`PRODUCT_BUNDLE_IDENTIFIER`をビルド引数で上書きしない。アプリ、通知拡張、App Group が次の ID で揃う。

- アプリ: `BELLTEAM_APP_BUNDLE_IDENTIFIER`（リポジトリの既定は `dev.kitepon.bellbot`）
- 通知拡張: `<アプリの Bundle ID>.NotificationService`（既定は `dev.kitepon.bellbot.NotificationService`）。iOS・iPadOS・Mac Catalyst で同じ ID（`DERIVE_MACCATALYST_PRODUCT_BUNDLE_IDENTIFIER` は NO）
- App Group: `group.<アプリの Bundle ID>`（既定は `group.dev.kitepon.bellbot`）

Apple Developer の Certificates, Identifiers & Profiles で、署名の前に次を行う。

1. App Group を作る。Identifier は `group.` にアプリの Bundle ID を付けたもの。
2. 既存のアプリ用 App ID で、Push Notifications に加えて App Groups（そのグループ）と Communication Notifications を有効にする。
3. 通知拡張用の App ID を作る。Bundle ID はアプリの Bundle ID に `.NotificationService` を付けたもの。App Groups（同じグループ）を有効にする。Communication Notifications と Push Notifications は拡張には付けない（Communication Notifications はアプリ本体だけが持つ。拡張の App ID ではポータルが付与しない）。
4. アプリと拡張の、Development と Distribution（TestFlight / App Store）のプロビジョニングプロファイルを作り直す。Mac Catalyst も同じ Bundle ID を使う。Xcode の Automatic Signing で `-allowProvisioningUpdates` を使う場合も、先に App ID と App Group と capability がポータルにないとプロファイルを更新できない。

アプリの entitlement は Push Notifications（`aps-environment`。Mac は `com.apple.developer.aps-environment`）、App Groups、Communication Notifications（`com.apple.developer.usernotifications.communication`）。Mac は従来どおり App Sandbox と外向き通信、利用者が選んだファイルの読み書きも含む。拡張の entitlement は App Groups だけ。Mac の拡張は App Sandbox も含む。アプリの Info.plist の `NSUserActivityTypes` に `INSendMessageIntent` を入れる。

## 送信と記録

メッセージ・入力要求の保存時に一度だけ送信する。過去の会話を起動時に再送しない。通知用の待機列や定期ポーリングは持たない。端末登録は`state/push-devices.json`へ保存し、トークン更新・ログアウト・APNsの失効応答で更新する。

認証済みAPI:

- `GET /api/notifications`: 通知設定の有無と対応環境。
- `POST /api/notifications/devices`: `token`・`environment`・`server`・任意の`previousToken`で端末登録。
- `POST /api/notifications/unregister`: `token`で登録解除。

APNsへの送信失敗は`SERVER_PUSH_FAILED`（その通知1件が届かない。`warn`）、通知の機能を開始できなかった失敗は`SERVER_PUSH_UNAVAILABLE`（`high`）、iPhoneの登録失敗は`IOS_PUSH_FAILED`として既存のBughub診断へ渡す。診断にはエラー種別だけを記録し、端末トークン・秘密鍵・署名JWTを含めない。送信を自動で繰り返さない。APNsへの接続は使い回し、5分使わなかった接続は閉じて次の送信で新しく開く（長く使わなかった接続は途中の経路で切れていて、次の送信が`APNS_CONNECTION_FAILED`になるため）。認証トークン（署名JWT）は50分ごとに一度だけ作り、端末の数だけ同時に送る時も同じトークンを使う（同じ接続へ違うトークンが続けて届くと、APNsが`TooManyProviderTokenUpdates`の429で拒むため）。APNsが受理しても端末への表示を保証するものではない。

## Appleの仕様

- [APNsへのアプリ登録](https://developer.apple.com/documentation/usernotifications/registering-your-app-with-apns)
- [トークン認証でのAPNs接続](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns): HTTP/2とES256署名のJWTを使用する。署名トークンは1時間以内に更新する。
- [通知リクエスト](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns): 通常の通知は`alert`、通知先はアプリと環境に対応する端末トークン。
- [秘密鍵の作成](https://developer.apple.com/help/account/manage-keys/create-a-private-key/): APNsキーは環境・Topicに対応させる。Topic はアプリの Bundle ID のままにする。拡張の Bundle ID は Topic にしない。
- [Communication Notifications](https://developer.apple.com/documentation/usernotifications/implementing-communication-notifications): 通知サービス拡張が `INSendMessageIntent` を寄付し、`updating(from:)` で表示を書き換える。原文は [保存資料](../rag/communication-notifications/raw/implementation.md) にある。
- [App Groupの登録](https://developer.apple.com/help/account/identifiers/register-an-app-group/): 登録とApp IDへの割り当てはApple Developerの画面で行う。
- [Modifying content in newly delivered notifications](https://developer.apple.com/documentation/usernotifications/modifying-content-in-newly-delivered-notifications): `mutable-content` が 1 の通知だけ拡張が動く。

## 実機確認の現在地

送り主のアバター付き通知をTestFlightへ内部配布した。Macへ署名付きアプリを導入し、共有先へのアバター保存と実APNs通知の受信を確認した。オーナーの実機でもトロニーの顔が通知アイコンに表示され、「問題ない」と確認された。通知を押してアプリが開くことも確認済み。端末の種類は不明。端末別の実機確認は未確認。現在値は [配布記録](subscription-setup.json)、残る実機確認は [作業の現在地](communication-notifications.md) に置く。

端末別の確認では、通知を許可した端末の登録、アプリを閉じた状態での受信、通知の種類ごとの会話や入力画面への移動を観測する。同じ会話を開いている間のバナー抑制も実機で確認する。許可操作はiPhoneの利用者が行う必要がある。

送り主のアバターと名前（Communication Notification）は、上の App ID・App Group・プロファイルを作り直したビルドで確認する。拡張が無い、またはアバターがまだ保存されていない端末では、title と body のまま表示される。
