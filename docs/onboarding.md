# 初回設定と追加機能

コンテナを起動するとネイティブアプリ（iPhone・iPad・Mac・Windows・Linux・Android）から同じマシンまたは LAN 経由で直接接続できます（ブラウザ版 Web UI は 2026-11-22 に終了済み。公開入口はアプリ向け API/SSE ゲートウェイとして稼働）。Cloudflare Access を設定した公開ドメインからの接続では Access 認証を使います。

初回に利用者がアプリ画面で行うのは、最初に使うハーネス（Claude・Codex・Grok・Cursor）の選択、必要な CLI の導入（`/home/bell/.local`）、および公式認証だけです。案内役のプロフィールは配布物に含め、選択したハーネスを割り当てた案内 bot を作ります。認証は Aiterm が公式 CLI を起動し、利用者は公式サイトで完了します。BellTeam はハーネスごとの認証コマンド、画面解釈、資格情報を所有しません。

認証後は案内 bot が会話を始め、利用者の希望に応じて設定します。案内 bot は設定の取得・更新・初期設定の完了を BellTeam MCP で行い、秘密の入力には専用の入力カード（`request_secret`）を使います。サーバー本体・案内役との初期設定・閲覧・書き出し・管理操作は無料です。初期設定完了後の各アプリからの通常会話と予定操作には共通の月額購読（月 980 円・税込、最初の 1 か月無料）を使います。詳細は [公開版の購読仕様](subscription.md) を参照。

設定画面と MCP は同じ追加機能の設定を使います。未設定の機能は無効にし、ほかの機能の起動を止めません。設定済みの機能の認証・入力・通信・応答が異常な場合は、その機能のエラーを表示します。保存した BellTeam 内の設定は起動中に反映します。

Cloudflare Access を有効にしても LAN の直接接続を維持します。直接接続の Owner は同じネットワーク（コンテナ内を含む）の相手だけとし、公開アドレスから直接つないだ相手は Host に何を名乗っても Owner にしません（SEC-049）。通話 MCP の登録変更では、稼働中のメンバーは現在のターンが終わってから閉じ、次のメッセージで更新した登録を読みます（コンテナ再起動不要）。

| 追加機能 | 必要な設定 | 無効時の動作 |
| --- | --- | --- |
| 返信者の自動選択 | TypeSafe の API キー | 返信者を手動指定する |
| 通話 | 通話 MCP の接続先と合言葉 | 通話 MCP を登録しない |
| 外部接続 | Cloudflare Access のチームドメインと audience、公開 URL | 直接接続を使う |
| 診断連携 | 診断 API の合鍵 | 外部の診断 API を開かず、内部の診断記録を残す |
| 通知 | 運営の通知送信サービスの接続先 | 通知を送らない |

Apple の秘密鍵は運営の通知送信サービスが持ち、利用者のコンテナへ配布しません。

## API

- `GET /api/setup`：`phase`（`select_harness`・`authenticate`・`ready`）、`harness`、`harnesses`（`id` と `name` の配列）、`guideBotId`、`complete`、`auth` を返す。`auth` は Aiterm の公開認証結果（`status`: `waiting`・`authenticated`・`blocked`・`failed`、`url`、`user_code`、`input_required`、`message`、未開始時は `null`）。
- `POST /api/setup/harness`：`{harness}` を受け取り、公式認証を開始する。
- `POST /api/setup/auth/input`：必要なときだけ `{text}` または `{key}` を公式認証端末へ渡す。
- `POST /api/setup/start`：認証の実効結果を確認し、案内 bot との会話を開始する。
- `POST /api/setup/complete`：初期設定を完了する。
- `GET /api/session`：`authenticated` と `authMode`（`local`・`cloudflare`）を返す。
- `GET /api/settings`：`{settings:[...]}` を返す。各設定は `id`、`title`、`enabled`、`status`（`unconfigured`・`disabled`・`enabled`）、`fields` を持つ。各 field は `key`、`label`、`secret`、`value`、`configured` を持ち、秘密の `value` は常に空。主要機能 ID は `routing`・`callBridge`・`cloudflare`・`diagnostics`・`notifications`・`onePassword`・`thinkingDisplay`。
- `PATCH /api/settings/<id>`：`{enabled,values,secretRequestId?}` を受け取り `{setting}` を返す。MCP からは秘密の生値を受け付けず、`request_secret` で提出された `toolId=bellteam-settings` の `secretRequestId` を使う。秘密の値と保存先は応答へ返さない。

主要機能の fields：
- `routing`：`apiKey`
- `callBridge`：`url`・`token`
- `cloudflare`：`teamDomain`・`audience`・`publicUrl`
- `diagnostics`：`key`
- `notifications`：`relayUrl`

## 保存と反映

追加機能の正本は永続領域の `shared/tools/bellteam-settings/settings.json` とします。既存の環境変数は初回に移行し、保存済みの設定を次回起動時に上書きしません。ハーネスと案内 bot の対応は `shared/onboarding.json` に保存し、Bot プロフィールは既存の Bot 保存先を使います。

受入条件：Aiterm の認証入口が公開され BellTeam の配布物がそれを利用できること、空の保存領域から追加機能の未設定を許容して起動すること、ハーネス選択・公式認証・案内 bot の実際の返答を一続きで確認すること。
