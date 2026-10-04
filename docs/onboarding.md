# 初回設定と追加機能

コンテナを起動するとWeb画面と基本の管理操作を使える。Macから同じマシンへ、iPhone・iPadから同じネットワークのマシンへ直接接続できる。Cloudflare Accessを設定した接続では、その認証を使う。

初回に利用者が画面で選ぶのは、最初に使うClaude・Codex・Grok・Cursorのハーネスと、その公式認証だけとする。案内役のプロフィールは配布物に含め、選択したハーネスを割り当てた案内botを作る。認証はAitermが公式CLIを起動し、利用者は公式サイトで認証する。BellTeamはハーネスごとの認証コマンド、画面の解釈、資格情報を所有しない。

認証後は案内botが会話を始め、利用者の希望に応じて設定する。案内botは設定の取得・更新・初期設定の完了をBellTeam MCPで行い、秘密の入力には既存の専用入力カードを使う。Webとサーバーは無料で、初期設定完了後もすべてのメンバーとの会話、Bot間の配送、予定の実行を購読なしで使える。Appleアプリでは初期設定完了まで案内botとの会話を無料で使い、その後の通常の会話と予定操作には共通の月額購読を使う。

設定画面とMCPは同じ追加機能の設定を使う。未設定の機能は無効にし、ほかの機能の起動を止めない。設定済みの機能の認証・入力・通信・応答が異常な場合は、その機能のエラーを表示する。保存したBellTeam内の設定は起動中に反映する。

Cloudflare Accessを有効にしてもLANの直接接続を維持する。公開ドメインでの接続はCloudflare Accessで認証する。通話MCPの登録変更では、稼働中のメンバーは現在のターンが終わってから閉じ、次のメッセージで更新した登録を読む。コンテナの再起動は要らない。

| 追加機能 | 必要な設定 | 無効時の動作 |
| --- | --- | --- |
| 返信者の自動選択 | TypeSafeのAPIキー | 返信者を手動指定する |
| 通話 | 通話MCPの接続先と合言葉 | 通話MCPを登録しない |
| 外部接続 | Cloudflare Accessのチームドメインとaudience、公開URL | 直接接続を使う |
| 診断連携 | 診断APIの合鍵 | 外部の診断APIを開かず、内部の診断記録を残す |
| 通知 | 運営の通知送信サービスの接続先 | 通知を送らない |

Appleの秘密鍵は運営の通知送信サービスが持つ。利用者のコンテナへ配布しない。通知送信には、通知先の端末トークンに登録した本人のApple購入情報を用い、独自の利用者IDや配送キューを追加しない。

## API

`GET /api/setup`は`phase`（`select_harness`・`authenticate`・`ready`）、`harness`、`harnesses`（`id`と`name`の配列）、`guideBotId`、`complete`、`auth`を返す。`auth`はAitermの公開認証結果を使い、`status`（`waiting`・`authenticated`・`blocked`・`failed`）、`url`、`user_code`、`input_required`、`message`を返す。未開始の`auth`はnull。

`POST /api/setup/harness`は`{harness}`を受け取り、公式認証を開始する。`POST /api/setup/auth/input`は必要なときだけ`{text}`または`{key}`を公式認証端末へ渡す。`POST /api/setup/start`は認証の実効結果を確認し、案内botとの会話を開始する。`POST /api/setup/complete`は初期設定を完了する。これらの応答は`GET /api/setup`と同じ形にする。

`GET /api/session`は既存の`authenticated`と、`authMode`（`local`・`cloudflare`）を返す。

`GET /api/settings`は`{settings:[...]}`を返す。各設定は`id`、`title`、`enabled`、`status`（`unconfigured`・`disabled`・`enabled`）、`fields`を持つ。各fieldは`key`、`label`、`secret`、`value`、`configured`を持ち、秘密の`value`は常に空にする。機能IDは`routing`・`callBridge`・`cloudflare`・`diagnostics`・`notifications`とする。

`PATCH /api/settings/<id>`は`{enabled,values,secretRequestId?}`を受け取り、`{setting}`を返す。画面からは秘密の入力欄で値を登録できる。MCPからは秘密の生値を受け付けず、`request_secret`で提出された`toolId=bellteam-settings`の`secretRequestId`を使う。秘密の値と保存先は設定の応答へ返さない。

機能のfieldsは、routingが`apiKey`、callBridgeが`url`・`token`、cloudflareが`teamDomain`・`audience`・`publicUrl`、diagnosticsが`key`、notificationsが`relayUrl`とする。

## 保存と反映

追加機能の正本は永続領域の`shared/tools/bellteam-settings/settings.json`とする。既存の環境変数は初回に移行し、保存済みの設定を次回起動時に上書きしない。ハーネスと案内botの対応は`shared/onboarding.json`に保存し、Botのプロフィールは既存のBot保存先を使う。

Aitermの認証入口が公開され、BellTeamの配布物がそれを利用できること、空の保存領域から追加機能の未設定を許容して起動すること、ハーネス選択・公式認証・案内botの実際の返答を一続きで確認することを受入条件とする。
