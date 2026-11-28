# 公開版の購読仕様

合意した仕様と実装の責務を記録する。準備状況・検証結果・続行条件は [subscription-setup.json](subscription-setup.json) が正本。2026-11-24 に廃止した運営 Worker（Durable Objects）時代の設計・実測経緯は [archive/subscription-worker-history.md](archive/subscription-worker-history.md) に退避した。

## 契約と利用権

- 利用者がサーバーを設置・運用し、AI 各社も本人の契約で利用する。
- 自己ホストのサーバー本体は無料で、Bot 間の配送や設定済み予定の実行に購読を求めない（ブラウザ版 Web UI は 2026-11-22 に終了済み）。
- 料金は購入元（App Store・Google Play・Stripe）を問わず **月 980 円（税込）、最初の 1 か月無料**。購読は 1 つの購入元で足り、どの購入元の購読も全アプリ（iPhone・iPad・Mac・Android・Windows・Linux）で利用できる。台数制限はない。購入画面の並び順・文言は [クライアント契約](billing-client-contract.md) に従う。
- アプリの入手とセットアップ、最初のハーネス公式認証、案内役との初期設定、閲覧・書き出し・管理・削除操作は無料。初期設定完了後のアプリからの通常会話、質問回答、秘密入力の提出・取消、セッション再起動、予定の作成・編集・手動実行に購読が必要。
- 期限切れでもデータを削除せず、アプリの有料操作だけを止める。設定済みの予定や Bot 間配送は継続する。自動更新の停止だけでは支払済み期間を短縮しない。

## 購読確認の責務（自前サーバーを持たない方針）

- **運営 Worker の廃止（2026-11-24、契約 1.42）**：ログイン・課金確認に自前の運営サーバー（Durable Objects Worker）を持たない方針へ移行し、本体リポジトリから運営 Worker を取り除いた。既配布の 1.0.x アプリが参照する旧検証 Worker だけが一時的に残存する（停止時に撤去予定：`a540-old-verify-stop`）。
- **Apple アプリ（iPhone / iPad / Mac）**：StoreKit で本人の購入・復元・取引更新を受け取り、検証済みの現在の利用権と猶予期間から有料操作を判定する。起動・復元・取引更新・前面復帰・有料操作の直前に確認し、共有サーバーの `entitled` で別の Apple Account のアプリを解錠しない。`AppStore.sync()` は利用者が復元を選んだ時だけ呼ぶ。商品とアプリの識別子は [product.json](../services/subscriptions/product.json) が正本。
- **マルチ端末確認（ローカル形式・a540）**：Windows / Linux / Android 等では、`login-billing` のローカル形式により、購読済みスマホと同一 LAN 内で QR コード経由の直接暗号化通信を行って利用権を確認する（詳細は [linux-architecture.md](linux-architecture.md)・[android-architecture.md](android-architecture.md)・[windows-architecture.md](windows-architecture.md)）。
- **初回の未確認時の扱い**：`GET /api/subscription` に失敗してサーバーの権利区分が未確認の時は、StoreKit 等の有効な利用権または初期案内の権利がある場合を除き有料操作を止めて「確認できない」と案内する。未確認を未購入と断定せず、送信前入力を保持する。
- **開発者免除**：オーナーの開発・運用環境では `BELLTEAM_SUBSCRIPTION_ACCESS_MODE=developer` で購読を免除し、「開発者として利用中」と表示する（`entitled` を有効と偽らない）。一般配布版はこの免除を受け付けない。

## サーバー API と互換契約

- サーバー側の購読状態は `shared/subscription.json` に保存する。`GET /api/subscription` は `entitled`・`source`・`isTrial`・`state`・`autoRenewing`・`validUntil`・`error`・`billingSources`・`canPurchase` を返す（`canUseAI` は常に `true` で、有料操作の範囲は各アプリが判定する）。
- 二重請求防止：いずれかの購入元で課金中（解約予約中の支払済み期間・支払い再試行を含む）の間は `canPurchase: false` とし、重複購入を抑止する。
- 認証済み API は、購読がなくても会話・画像の閲覧と全件 JSON 書き出し（`GET /api/bots/:id/export`、`GET /api/rooms/:id/export`）を許可する。
- 通知登録では、端末トークンに本人の購入情報を紐づけて検証し、独自の利用者 ID や配送キューを追加しない。
- 環境切替は `BELLTEAM_SUBSCRIPTION_ENVIRONMENT`（通常 `Production`、TestFlight 試験時は `Sandbox`）で明示し、自動切替しない。照会先の定義は [endpoints.json](../services/subscriptions/endpoints.json) が正本。
- 既存の Stripe / Google Play 検証 API（`POST /api/subscription/stripe/checkout|verify|manage`、`POST /api/subscription/google/verify`）は旧クライアント・互換仕様として残存するが、新規の認証・課金確認は運営 Worker を使わないローカル形式へ移行済み。

## 公開・審査の現在状況と続行条件

- iPhone と Mac の署名付きビルドはオーナー用 TestFlight グループへ配布し、内部テスト開始と App Store 版へのビルド割当を確認済み。
- Apple の実購入・更新・復元・失効は未検証であり、公開・課金完了とは扱わない。
- App Store Connect API は管理用 Mac の MCP から利用可能。価格の 980 円・初回 1 か月無料への更新、年齢区分・審査画面・審査用接続環境の整備、TestFlight での購入・復元確認が残項目（詳細は [subscription-setup.json](subscription-setup.json)）。
- ソースは非公開で、一般配布の Docker イメージと設置用ファイルは未認証で取得できる。
