# BellTeam 現行設計

本書を BellTeam の現行設計の正本とする。本書は**現在成立させている製品契約**のみを記録し、未実装の項目は実装済みとして扱わない。すでに退役・方針転換された過去の経緯や移行ログは [archive/current-design-history-202611.md](archive/current-design-history-202611.md) に退避している。

- 機能の関係・データ所有・実関数への入口：[全体機能図](architecture/feature-map.md)、[全体データフロー](architecture/data-flow.md)、[担当と変更手順](architecture/module-ownership.md)
- ドキュメント全体の索引：[docs/README.md](README.md)

---

## 製品とHTTPの責務

### プロセス構成とライフサイクル
- プロセス入口 `src/supervisor.mjs` は設置の bootstrap を読み、runtime の構築・開始・signal 待ち・終了を接続する。
- `application-services.mjs` は Bot / 会話 / 予定 / 記憶などの公開 factory を既存順で接続し、会話固有の writer・回答表示 callback・部屋/自主回答の組立ては `conversation-services.mjs` に置く。
- `usage/application-features.mjs` は任意機能の設定反映と診断 server / Bridge socket / CLI 登録への接続を所有する（既存の `application-features.mjs` は互換 export を持つ）。設定保存の応答と現在ターン後の反映を区別する。
- `application-runtime.mjs` はこれらと公開/内部 HTTP・MCP を接続し、`start` で機能反映・通信口と監視を開始、`close` で予定・監視・HTTP・任意機能・transport・通知を順に閉じる。factory の import や構築だけで通信口や背景監視を開始しない。

### 外部 OSS との境界
BellTeam は各 OSS の公開 CLI / MCP / API を使うアプリケーションであり、Aiterm・Steer・Throughline・mcp-lazy・RTK・testgate・call-bridge・Approval Box・Lattice の実行判断や製品状態を所有しない。各 OSS は BellTeam の台帳や内部パスがない環境でも単独で導入・起動・操作・更新できることを保つ（接続契約の正本は [data-flow.md](architecture/data-flow.md)）。

### HTTP / MCP 入口と責務分離
- 公開入口は `web-gateway`（[modules/web/README.md](architecture/modules/web/README.md)。ブラウザ版 Web UI は 2026-11-22 に終了済みで、ネイティブアプリ向け `/api/*` と `/healthz` を本体へ転送し、それ以外は 410 を返す）と、`src/http-server.mjs` の `createBellTeamServer`（認証・要求ログ・共通失敗応答・接続終了）。
- 機能受付は `http-application-api.mjs`（設定・初期設定・認証・利用契約・オーナー・共通イベント）、`http-bot-api.mjs`、`http-room-api.mjs`、`http-delivery-api.mjs`、`http-schedule-api.mjs`、`http-conversation-api.mjs`、および `usage/http-api.mjs`（`createUsageApi`）・`usage/mcp-tools.mjs` へ分ける。HTTP と MCP へ業務判断や保存処理を二重実装しない。
- 入出力表現は `http-response.mjs`、要求ログは `http-request-log.mjs`、画像配信は `http-assets.mjs`、失敗写像は `http-errors.mjs`、会話統合・ページ・画像 URL 表現は `http-messages.mjs`、SSE 接続・通知集約・監視解除は `http-events.mjs` が持つ。

### Bot 設定適用・削除・実行状態
- **設定変更と停止**：`bot-administration.mjs` の `BotAdministration` が持つ。稼働中への設定適用は保存した希望値と区別し、`configurationApplication`（`pending` / `failed` / `accepted`）を HTTP と MCP（`get_self` / `get_bot`）へ公開する。`accepted` は CLI による変更受付であり実ターンの測定証明ではない。本体再起動後に状態が無い時も希望値を適用済みと表示しない。`not_applied` / `not_started` は開始前拒否のみを表し、`outcome_unknown` / `possible` は結果不明として保存したファスト希望を無条件に戻さず自動再送しない。
- **削除**：`members/deletion.mjs` へ委譲する。active は席終了 → 部屋参照整理 → 台帳退役/専用 cleanup、既 pending は native を起動・停止せず同じ削除を再開する。CLI 設定同期は cleanup 試行後に一回行い、同期失敗を削除完了と別に記録する。受付 202 は cleanup 完了を意味しない。
- **Aiterm 接続**：`src/aiterm-transport.mjs`（MCP 接続寿命・失敗は `aiterm-client.mjs`、待機プロセス実行は `aiterm-wait-process.mjs`、Throughline 文脈読取は `throughline-context.mjs`）。通常の `createManagedTransport` は Aiterm へ直接配送し、記録の取得や保存のために通常配送・停止を止めない。個別停止と全体停止は `agent_stop` へ直接渡し、送信受付は `stop_sent` として返す。
- **席状態・配送ジョブ・活動正本**：
  - 同じ Bot の席操作状態（現在 session 対応、停止時点 version、発行待ち席変更、不明返却、停止待ち）は `bot-session-state.mjs` の `BotSessionState` が所有する。
  - 一回の配送事実と停止結論は `delivery-job.mjs` の `DeliveryJob` だけが決める。受理済み送信を停止で成功へ丸めず、未送信の実行登録だけを `not_sent` で閉じる。
  - 席で起きていることの正本は `seat-activity.mjs` の `SeatActivity`（配送 job、受付済み配送と `SeatTurnWatch`、追い終えたターン、進行中操作）。
  - 停止の二経路（一括停止と実行登録ごとの中断）は `execution-transport.mjs` の共通骨格を使う。
- **セッション結果ログ**：`agent_launch` と `pty_close` の返却後に `BellTeam session result:` を stderr へ記録する（Bot/session/launch ID、返却有無、isError、既知 schema・状態のみ。本文・認証情報・env 値・任意エラー文は含めない）。このログは観測であり、席状態の正本や配送許可・再試行条件にはしない。

---

## 公開認証

- **API 通信診断ログ**：POST・PUT・PATCH・DELETE は `BellTeam write:`、GET・HEAD は `BellTeam read:`（受付時 `started` と終了時 HTTP 状態または `aborted`・所要時間）を残す。本文・クエリ・Cookie・認証ヘッダーは記録しない。`/healthz`・静的ファイル・MCP は対象外。SSE は接続受付と閉鎖のみ記録する。
- **アクセス制御**：未設定のコンテナでは同一マシン・LAN からの HTTP 接続を許可する（直接接続の Owner は同一ネットワーク内のみ、SEC-049）。Cloudflare Access を有効にした公開ドメインでは `Cf-Access-Jwt-Assertion` の署名・発行元・audience・期限を検証し、未認証を拒否する（LAN 直接接続は維持）。`/healthz` は監視用、`/api/session` は接続確認用に未認証でも状態を返す。
- **コンテナ内 MCP の内部 HTTP 入口**：BellTeam MCP（`/mcp`）と通話 MCP（`/mcp/call-bridge`）は loopback 専用 HTTP 入口へ直結し、席ごとのプロセスを起こさない（経緯：[plan_mcp-http-consolidation-20261004.md](archive/plans/plan_mcp-http-consolidation-20261004.md)）。
  - 席の識別は各 CLI が持つ `AITERM_SESSION_ID` を `X-Bellteam-Seat` ヘッダーへ写して伝える。アカウント切替席 `<botId>-<1st|2nd>-<base36>`（[harness-accounts.md](architecture/modules/execution/harness-accounts.md)）は後ろ 2 区切りを外して Bot ID へ対応付ける（実行記録には元のセッション名を残す）。
  - 台帳に無い名札（席が起こした子等）には `BELLTEAM_SEAT_UNRESOLVED`（**400**）を返す（Claude Code が 403 を認証要と誤認して共有キャッシュ `~/.claude/mcp-needs-auth-cache.json` に書くため 403 にしない）。通話ブリッジも名札なしでは中継しない。
- 追加機能の設定は永続領域へ保存し、初回設定・公式認証・案内 bot・追加機能の仕様は [onboarding.md](onboarding.md) に従う。

---

## iPhoneアプリ

SwiftUI 製アプリを `ios/BellBot/` に置く。App Store で公開・配布し、公開 API と同じ経路を使う（独自アクセスキーや iPhone 専用認証情報は持たない）。

### 全体停止と個別停止
- **全体停止**：`GET/PATCH /api/ai-control` で ON/OFF を操作。本体が正本・受付抑止・予定制御を持ち、Aiterm の `agent_stop`（`pause_goals=true`）へ接続する。停止処理中・確認済み・一部未確認を分け、通信断では再送せず正本を読み直す（詳細：[ai-control.md](ai-control.md)、[control-and-state.md](architecture/control-and-state.md)）。
- **個別停止**：処理中のメンバーへ確認ダイアログ無しで `POST /api/bots/:id/stop` を呼ぶ。通常経路は `202 {botId, status: "stop_sent"}`（送信受付であり終了証明ではない）、互換 adapter で中断・session 保持確認時は `200`、失敗や不正結果は `502 BOT_STOP_UNCONFIRMED`。通信断でも POST を自動再送せず、メンバー・会話・予定・下書きを残す。

### 初回導線・アバター・表示仕様
- **初回画面**：未接続時は「はじめて使う」と URL 入力を表示し、[server-installation.md](server-installation.md) をアプリ内同梱で閲覧可能にする（GitHub URL と依頼文のコピー・共有対応）。
- **アバター**：正方形切り抜き（1〜3 倍拡大）。大画像は正方形切り抜き、iPhone の左上小画像は 88pt。既存メンバーの大小画像はプロフィール詳細の各表示領域から個別に変更・調整する。一覧は `?avatar=omit` と `avatarVersion`（16 桁）で差分取得し、`/api/{bots|rooms|owner}/<id>/avatar?v=<version>` は `immutable` / `If-None-Match` 304 に対応。
- **会話同期とスクロール**：正本はサーバー保存済みメッセージ。前面中は SSE（25 秒ごとのコメント行で維持、50ms 集約、Node keep-alive 125 秒）で更新し、再接続時は未取得差分を補完。初回 GET 失敗時は空表示にせず読込失敗＋手動再読込を出す。下端閲覧時と自己送信時のみ追従スクロールし、過去ログ閲覧中は新着ボタンを出す。
- **Markdown とテキスト表示**：共通 `MessageText`（EnrichedMarkdown、範囲選択・コピー・表列コピー対応、公開 theme のみ使用）と `SelectableText`（プロフィール等、再表示時も選択範囲維持）。
- **稼働状態・ファストモード・配送表示**：メンバー一覧は待機中＝緑、仕事中＝赤点滅（`GET /api/queue` の `running`）、オフライン＝灰。ファストモード（⚡ ファスト）は `GET /api/models` で対応確認し、変更時のみ送信。配送状態は同じ Bot・同じ状態を 1 行集約。
- **削除と通知**：メンバー削除は `DELETE /api/bots/:id` の 202 を受付表示し、一覧再取得で消えてから選択会話と下書きを片付ける。返信・ルーム投稿・秘密入力要求は APNs で通知（本文・秘密値を含めず、開いている会話は前面表示抑止、タップで対象会話・秘密入力を開く。詳細：[push-notifications.md](push-notifications.md)）。

### 診断送信（`POST /api/diagnostics`）
- MetricKit のハング・クラッシュ診断と共通通信処理の失敗（時間切れ・接続失敗・サーバーエラー・応答形式異常）を匿名化 `diagnostic_log` 付きで `POST /api/diagnostics` へ送り、本体は `runtime/data/logs/diagnostics.json` へ保存する（本文・URL・認証情報は含めない）。
- 通信失敗の重大度はアプリが利用者影響と復帰可否から付けた `severity`（`fatal` / `high` / `warn` / `info`）を使い、`info` は `user_impact=none` と `app_handling=...` がある時のみ参考記録（`resolved`）とする。圏外・通信制限・通話中・中断は報告しない。SSE 切断は 5 回連続失敗時のみ 1 件報告。前面復帰時は接続プールを破棄して読み直す。GET の `-1005` は 1 回のみ再取得し、POST は再送しない。失敗要求には `URLSessionTaskMetrics` を添付する。

---

## iPadアプリ

iPad は iPhone と同じアプリ（同一 App ID・コードベース）に含み、`BellBotApp` が端末に応じて Mac と同じ `DesktopWorkspaceView.swift` を開く。`NavigationSplitView`＋SwiftUI `inspector` で幅に応じた 3 ペイン配置を行い、縦横 4 方向・ウィンドウリサイズ・外付けキーボード（Return 送信、Shift/Option+Return 改行）に対応する。画面確認状況は [ipad-app.md](ipad-app.md)。

---

## Macアプリ

Mac Catalyst で iPhone 版と機能・通信を共有し、一覧・会話・詳細の 3 ペインと独立したメンバー編集ウィンドウを持つ。検索・キーボード送信・画像ドロップ/貼り付け・会話ごとの下書き保持に対応。構成・ビルド・導入は [mac-app.md](mac-app.md)。

> Windows（WPF / `BellTeam.Core`）、Linux（Avalonia / `BellTeam.Core`）、Android（Avalonia / `BellTeam.Core`＋Linux UI 共有）のクライアント設計は [windows-architecture.md](windows-architecture.md)・[linux-architecture.md](linux-architecture.md)・[android-architecture.md](android-architecture.md) を正本とする。

---

## 公開版の購読

サーバー本体は無料で、Bot 間配送・予定実行・初期設定（案内役との会話）・閲覧・書き出し・管理に購読を求めない（ブラウザ版 Web UI は 2026-11-22 終了）。各ネイティブアプリからの通常会話と予定操作は共通の月額購読（月 980 円・税込、初回 1 か月無料）を利用する。ログイン・課金確認に運営の自前サーバー（Worker）は持たない方針へ移行済み（2026-11-24）。詳細・準備状況は [subscription.md](subscription.md)・[billing-client-contract.md](billing-client-contract.md) を参照。

---

## 共通処理とハーネス固有処理

- UI・MCP・メッセージ・Bot 管理の操作とデータ形式は全 CLI 共通とし、CLI 固有の起動引数・入力方法・完了検出・確定回答取得は Aiterm のハーネスアダプタへ委ねる。
- **対応ハーネス**：Claude Code・Codex・Grok・Cursor の 4 種（新 CLI 追加時も共通側へ条件分岐を足さずアダプタ追加で対応）。
- **Antigravity の取り外し（a353、2026-11-17）**：規約リスクのため新規選択・認証・モデル一覧・起動から除外済み。保存済みデータに `antigravity` が残る環境でも本体は起動継続し、`src/retired-harness.mjs` を正本として読み取り側のみ許容しつつ、HTTP 境界で読み取り専用 `harnessNotice`（および `backgroundAgentNotice`）を返して利用者が 4 ハーネスへ変更できるようにする。起動試行時は `HARNESS_RETIRED`（`effect: not_started`）を返す。移行・新旧 IPC 互換の詳細経緯は [current-design-history-202611.md](archive/current-design-history-202611.md) を参照。
- **AI の認証と再ログイン**：初期設定後も設定の「AI の認証」から `/api/harness-auth`・`/api/harness-auth/<AI>`（`start` / `input` / `cancel`）経由で Aiterm の `agent_auth`（`relogin` 対応）を使い公式認証をやり直せる（購読不要）。開始時点で既存資格情報が消える AI（Codex 等）は `startWarning` で事前警告する。席の起動失敗時は Aiterm に残った端末を閉じ、自動再起動・再送はせず 500 に「認証が切れている可能性」を添える。

---

## 実装資産の永続化境界

### コンテナ・イメージ構成と更新
- 本体は `read_only: true` のコンテナで `node src/supervisor.mjs`（固定 C 入口 `/usr/local/libexec/bellteam-server-start` 経由、UID 1001）を起動する。書込可能領域は割り当てた外部保存先（`/home/bell`、`/home/bell/.local`、`/srv/bellteam`）と tmpfs（`/tmp`、`/run`）のみ。
- **AI CLI 非同梱（a451、2026-11-19）**：Claude Code・Codex・Grok・Cursor の CLI 本体はサーバー image に同梱せず、利用者がアプリの「AI の認証」から `/home/bell/.local`（`cursor-cli` volume）へ最新版を導入・更新する。`bellteam-update-cursor` は互換のため空入口として残る（SEC-014 先行段の旧 Cursor 更新履歴は [archive/current-design-history-202611.md](archive/current-design-history-202611.md)）。
- 一般配布 image は amd64 / arm64 ネイティブ CI で installer・初期設定・モデル候補・公式認証入口・個人設定非包含を検証後、`latest` / `preview` を公開する。installer は初回 pull 後 `--pull never` を維持する。
- 本番反映前の quiet 確認（`check-deploy-quiet`）は、ターン途中の席（`seatTurns` running / `observe` / Linux `/proc` による CLI 子孫プロセス・配送キュー確認）を保留対象（exit 2）とし、入力待ちの待機席自体は除外する。

### 永続保存の二系統と Bot 環境
- 永続的な実装資産の正本は次の二系統のみとする：
  1. Bot 固有資産：`/srv/bellteam/bots/<bot-id>/`（リポジトリ・成果物・`integrations/<tool-id>/`・`environment/`）
  2. 共有ツール本体（オーナー明示分のみ）：`/srv/bellteam/shared/tools/<tool-id>/`（有効化・利用設定は各 Bot が所有）
- `/app`、`/usr/local`、`/tmp`、`/root`、`/home/bell` と各 CLI グローバル設定は基盤更新で消失・上書きされる派生物扱いとする。
- 各 Bot の `environment/setup.sh` はコンテナ起動時に会話受付・予定開始前に順番に一度実行（結果を `setup.log` に残し、1 席の失敗で全体起動を止めない）。`environment/env.sh` は会話用 CLI 起動とコマンド予定の都度読み込む。手順の正本は [bot-environment.md](bot-environment.md)。

---

## Botプロフィールと送信者の人格

- プロフィールの正本は各 Bot プロジェクトの `bot.json` のみ（SQL や別索引へ複製しない）。保持項目は固定 Bot ID（Aiterm セッション ID にも使用）、最後に確認されたセッション ID、名前、CLI（`harness`）、モデル、エフォート、ファストモード、`profileText`、`personality`、`speechStyle`、`position`（役職）、`role`（役割・100 文字以内）。詳細手順は各 Bot の `docs/` に置く。
- 画面表示名は `名前 役職`（役職未設定時は名前のみ）。チャット上部の副表示は稼働状態のみ、ルーム上部は人数のみとし役割・目的本文は出さない。ルーム発言には左にアバターと代表色の枠を付ける。
- CLI・モデル・エフォートは作成後も設定画面および MCP `update_bot`（`PATCH /api/bots/<id>` と同一経路）で変更できる。保存は即時返却し、稼働中への適用は現在ターン後に裏で行う。モデル・エフォート候補は毎回 `GET /api/models`（Aiterm `agent_models`）からライブ取得し永続化・固定代用しない。`node scripts/update-models.mjs [harness]` は診断用。
- 直接メッセージには ID だけでなく送信者の名前・役職・役割・本文・画像有無を含め、会話ログにも送信時点の属性を確定記録する。送信者は MCP 呼出元から本体が確定し、ツール引数で指定させない。

---

## ユーザー規範

- 規範は二層とする：製品規範（`config/common-agents.md`）と、利用者固有のユーザー規範（`/srv/bellteam/owner/user-rules.md`、製品更新で上書きしない）。起動時指示は「オーナー情報 → ユーザー規範 → 製品規範 → Bot 固有」の順で生成する。
- `get_user_rules` は全 Bot が参照可能。書き換えはアプリ画面・`bellteam-owner` MCP（`src/mcp-owner-server.mjs`）・共通 MCP `update_user_rules` から即時保存でき、履歴が `owner/user-rules-history.jsonl`（`GET /api/user-rules/history`）と該当 Bot の会話へ差分付きで自動記録される。書き換え後は `src/global-instructions.mjs` で起動時指示を再生成し、再起動不要で次の配送から反映する。
- Cursor CLI はグローバル `~/.cursor/AGENTS.md` を読まないため、起動時に `~/.cursor/hooks.json` の `sessionStart` へ `integrations/cursor/instructions-hook.mjs` を登録し（`src/cursor-instructions.mjs`）、セッション開始ごとに全文を `additional_context` として渡す。

---

## キャラクターシート（設定画）

Bot が自分を描く時の正本は、オーナーが決定した設定画（`/srv/bellteam/bots/<bot-id>/assets/character-sheet/` 直下）とする。候補は `drafts/` に置き、オーナー決定後に直下へ移す。アバターとは別資産として管理する。API は `/api/bots/<id>/character-sheet`（直下画像のみ一覧）と `/api/bots/<id>/character-sheet/<file>`（実装：`src/character-sheets.mjs`）。

---

## オーナープロフィール

正本は `/srv/bellteam/owner/profile.json` のみ（アバター、名前、プロフィール、X URL、GitHub 公開プロフィール URL、名称付きその他 URL）。共通規範や長期記憶へ複製しない。API は `GET/PATCH /api/owner`、MCP は `get_owner_profile`。新規・復元セッション起動時および全配送直前に最新値（アバター本体除く）を自動添付し、再起動なしで反映する。

---

## ユーザーとBotの会話

- **入力とページング**：iPhone は Enter 改行・ボタン送信、Mac / iPad 外付けキーボードは Return 送信・Shift/Option+Return 改行。履歴 API は `limit`・`before`・`after` を持ち、最新から取得する。チャット上部の「Bot の画面」は Aiterm の画面読取そのままを 2 秒ごとに表示する。
- **送信と拒否分類**：送信は Aiterm `pty_send` へ直ちに渡し、UI は API 応答を待たず入力欄から外す（拒否時のみ理由コード表示＋入力復元）。Aiterm の入力未準備（`BOT_INPUT_NOT_READY`）や送信競合（`AGENT_SEND_BUSY` → `BOT_SEND_BUSY`）は HTTP 409 とし、500 診断へ入れず再送もしない。
- **合間の言葉と途中エラー表示**：ターン途中の出力（`aiterm/interim_words`）は 3 秒おきの `pty_observe` とターン完了後に取得し、`bellteam.interim-word.v1` として該当 Bot の会話画面に吹き出し表示する（他者への配送や Push 通知の対象外。思考テキストは非表示）。API エラーや利用上限（`rate_limited`）も可視化する。Bot 間 DM・通話・ルーム由来の最終回答も完了後に `pty_read(agent_transcript: true)` で `kind: "answer"` として会話画面へ表示する。`src/self-turns.mjs` が Throughline 記録から出す回答で、冒頭に合間の言葉と完全一致する重複がある場合は除去する。
- **明示送信**：`sendmessage(target="user", ...)` は通常ターン外の自発連絡や画像付き回答に使い、明示送信を確定回答として採用して通常出力を重ねない。空回答ターンは吹き出しを追加しない。

---

## Bot間の会話

- **共通入口**：`sendmessage(target, message, image?)`。非同期直接メッセージであり、Aiterm の継続セッション受理をもって送信完了とする（返答待ちしない）。通常最終回答は自動転送せず、返信したい Bot が自分で `sendmessage` を呼ぶ。
- **通話ブリッジ（GrokBot 等）**：全 4 CLI へ `call-bridge` MCP を標準登録し、内部入口 `/mcp/call-bridge` から認証ヘッダー（権限 600 ファイル）と `X-Call-Bridge-Caller-Id` を付与して中継する（上流 401 / 鍵欠落は 502 `CALL_BRIDGE_AUTH_FAILED` / `CALL_BRIDGE_AUTH_UNAVAILABLE`）。着信は UNIX ソケット経由で受け、外部送信者の所属と ID を保ったまま通常配送する。
- **BugHub セキュリティ所見 MCP**：全 Bot が使える 6 ツール（`bughub_{list,get,create,update,resolve,reopen}_security_finding`）を提供。`/srv/bellteam/state/bughub/{headers,endpoint}`（親 UID/GID 1001 0711、ファイル 0600）を呼び出しごとに読み、`x-bughub-security-token` と `x-bughub-actor` を付けて `/api/security/v1`（担当フラジャイル）へ中継する（未設定時は `BUGHUB_SECURITY_NOT_CONFIGURED`）。
- **一覧表示と未読**：Bot 間メッセージは会話本文へ複製せず 1 行の活動記録（タップ展開）として表示。メンバー欄とルーム欄は混ぜず、最後のアクション日時降順（状態変化・既読で並べ替えない）。未読は Bot からユーザーへの返答のみを対象とし、Bot 間活動や自己送信では未読にしない。

---

## 配送と追加指示

- 全配送（ユーザー会話・Bot 間・ルーム・予定）は BellTeam 内で待機させず `pty_send` へ即渡し、差し込み（`agent_steer`）か新ターン開始（`agent_dispatch`）かの判定は Aiterm に委ねる。
- 配送状態は `running` → `delivered` / `failed`（`AITERM_TURN_ERROR` / `AITERM_TURN_RATE_LIMITED` 含む）。Aiterm 0.60.0+ の差し込み（`aiterm/caller: "BellTeam"`）では返却された `event_cursor` / `wait_process` / `steer.placement`（`same_turn` / `next_turn` / `not_taken` / `unknown`）に従い完了・失敗・回答読取を判定する。
- `/queue` API と `list_queued_messages` は処理中項目を返す（互換名維持）。BellTeam 外から始まったターン（子結果による開始など）も 5 秒おきの `pty_list`（`_meta["aiterm/seat_turns"]`）で検知し `context: "self"` として稼働表示する（`src/seat-turns.mjs`）。

---

## オーナーへの報告漏れの確認と選択肢カード

- **報告漏れ確認（`src/turn-reports.mjs`）**：新規ターン完了時、オーナー向けの言葉が 0 件の「処理漏れ」（ルーム除く）をコードで検出し、メンバー宛て送信がある場合のみ TypeSafe Jev（`jev-latest`）へ `outcome`（< 0.35）と `substance`（< 0.5）の 2 軸で「中身の漏れ」を照会する。漏れ検出時は対象 Bot へ報告依頼を送る（再帰確認なし、Jev 失敗時はログのみ）。
- **選択肢カード（`src/owner-questions.mjs`）**：`ask_owner(question, options, allowOther)` で会話画面へ 1 回限りの回答カードを表示する（作成は内部 MCP API、回答は公開 API）。Bot は回答を待たずターンを終え、回答はユーザーメッセージとして届く。オーナー判断・承認が必要な場合は `request_decision`（Approval Box）の併用を規範で推奨する。

---

## チャット画像

- 1 回の送信で複数枚（`images` 配列、旧単一 `image` 互換、本文込み上限 96 MiB）に対応。対応形式は PNG / JPEG / WebP / GIF（非画像・symlink・25 MiB 超はエラー）。
- 送信時は一時ファイル経由で Aiterm の `image` 引数へ渡す（ハーネス固有手順は持たない）。会話表示用の実体は Bot 側 `/srv/bellteam/bots/<bot-id>/messages/assets/` またはオーナー側 `/srv/bellteam/owner/messages/assets/` へ永続保存し、API は `image_urls`（および旧互換 `image_url`）を返す。
- MCP `image` の相対パスはまず Bot プロジェクトから解決し、Grok の `images/<name>` のみ `src/bot-image-path.mjs` 1 か所限定で `~/.grok/sessions/` を参照する非公式依存を閉じ込める（[conversation/flow.md](architecture/modules/conversation/flow.md#第三者grok-cliへの非公式な依存)）。

---

## Botとプロジェクト

### セッション管理・休止・夜間再起動
- 1 Bot ＝ 1 プロジェクトフォルダ＋固定 Bot ID。配送時は `bot.json` の最後確認済みセッション ID へ直接送り、不達時のみ新規起動して 1 回だけ再送する。作成時はセッションを起動せず初回実メッセージで起動する。
- **アイドル休止**：2 分おきに `pty_observe` で観測し、入力待ち（`idle/composer_ready`）かつ起動後プロセス数＝0・子配送待ち＝0・配送なしが 10 分以上続いた Claude Code 席を `pty_close {hibernate: true}` で休止する（`AGENT_BUSY` 時はスキップ、`AGENT_HIBERNATE_UNAVAILABLE` 時は通常 `pty_close`。a478）。Codex / Grok / Cursor は未決承認確認が揃うまで対象外。
- **夜間再起動**：毎日 03:00（Asia/Tokyo）に、動作中・処理待ちなし・Throughline 完了ターン 20 件以上の Bot のみ再起動する。
- **設定変更とファストモード**：同一 CLI の明示モデル/エフォート変更は配送列末尾で `agent_configure` を実行しセッション文脈を維持。ファストモード（`bot.json` の `fastMode`、既定 false）は `set_fast_mode` / `PATCH /api/bots/<id>` で Bot 自身が切替可能とし、`agent_launch` へ常に真偽を渡す。未対応・利用枠不可は 400 で拒否。起動返却 `fast=false` 時は保存を無効へ合わせる（ただし `startup.reason=turn_running`＋`FAST_MODE_UNCONFIRMED` 時は保存を保持しターン後に `agent_configure` で再適用、a469g）。

### ホーム・環境変数・同梱基盤と CLI 登録
- ホーム決定は `src/runtime-home.mjs`（`BELLTEAM_HOME` 優先、未指定の開発実行時は `runtime/home`、コンテナは `/home/bell`）。`CLAUDE_CONFIG_DIR` と `BELLTEAM_BUGHUB_KEY` は席環境へ継承しない。
- **CLI・hook 登録の一元化（bd14）**：RTK（担当ドリリー）・testgate（担当シラツル）・Throughline（担当リヴァリン）・Aiterm（担当エレグ）・Approval Box（担当ナユタ）・Lattice（担当スノーホワイト）の MCP・hook 登録は、各製品の公開契約 E1（`harness-entries` / `hook-entries`）を BellTeam の単一 writer（`src/harness-entries.mjs` 等）が適用する（正本：[cli-registration.md](architecture/modules/runtime/cli-registration.md)）。
- **Throughline**：コンテナ初期搭載（`throughline@latest`、`THROUGHLINE_HOME=/srv/bellteam/shared/throughline`）。起動時短期記憶（`--sessions recent`）、ルーム文脈、夜間再起動ターン数、自主ターン観測（`observer-read` / `observer-check`）に使用。長期記憶は Bot 自身が `remember` で保存する。
- **mcp-lazy（担当レオナ）**：コンテナ初期搭載（公開リポジトリ最新 `main` からビルド、`/usr/local/bin/mcp-lazy`）。Aiterm MCP を中継越しに起動し待機メモリを削減（`MCP_LAZY_IDLE_STOP=0`、30 秒おき `aiterm-delivery-wake`）。`bellteam` と `call-bridge` は本体へ HTTP 直結のため中継しない。
- **起動時指示と削除**：各 CLI グローバル `AGENTS.md`（Claude 用 `CLAUDE.md` は `@AGENTS.md`）へ共通指示を生成し、Bot プロジェクト `AGENTS.md` へ人格・役割・直近短期記憶を生成する。Bot 削除時はセッション終了・ルーム/予定から除外・プロジェクト削除を行い、ルーム削除時はルーム設定・履歴・予定を削除する（参加 Bot と個人記憶は保持）。

---

## グループチャットルーム

- ルームは自動生成 ID、ルーム名、目的、代表 Bot、メンバー、予定、アバターを持つ。公開 MCP は `invite_to_room`・`leave_room`・`sendroommessage`・`respond_to_room`。
- **返信者判定と配送**：発言は Throughline のルーム文脈 API で直近 3 ターンを取得し、手動指定（`targets`）が無ければ TypeSafe Jev へ 1 回の要求で「継続必要か（確率 ≥ 0.6）」と「返信者 1 名」を判定させる（手動指定優先、「@名前」記法は使わない）。判定後、最新発言を返信者フラグ付きで全メンバーへ配送する。
- **応答契約**：受信 Bot の通常最終回答はルームへ自動転送せず、返信者は `respond_to_room(action="reply", messageId?)`、それ以外は `respond_to_room(action="silent", messageId)` を呼ぶ（重複返信防止、`silent` は履歴非保存）。Bot の `reply` も新たなルーム発言として全員へ配送される。
- **自動実行予定**：Bot 予定は `prompt` または `command`（Bot フォルダで `sh -c` 実行、非 0 終了時のみユーザー会話へ失敗記録）、ルーム予定は `prompt` のみ。頻度は一回・毎時・毎日・曜日指定・日おき（`interval_days`）・時間おき（`interval_hours`）・cron 式を共通処理で計算し、編集（`PUT`）と手動実行（`POST .../run`）に対応する。
- **履歴ページング**：最新位置から開き、上端スクロールで過去ページを取得（高さ変化時も読み位置保持）。最新ページと `before` ページは `remaining_before`（秘密入力・質問カード含む残件数）を返す（`after` には付けない）。
