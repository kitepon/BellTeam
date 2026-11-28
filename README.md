# BellTeam

アプリをダウンロードして初めて使う方は、[サーバーの導入ガイド](docs/server-installation.md)から始めてください。PC の準備、公開コンテナの起動、アプリに入力する接続先 URL まで案内します。

一般配布サーバーの詳細は [設置案内](distribution/server/README.md)、初回設定と追加機能の仕様は [初回設定と追加機能](docs/onboarding.md)、ドキュメント全体の構成は [docs/README.md](docs/README.md) を参照してください。

ソースから一般利用者向けのコンテナを作る場合も、設置案内の [ソースから構築する](distribution/server/README.md#ソースから構築する) に従って public 構成を生成し、ローカルイメージを installer へ渡します。リポジトリ直下の Compose は開発者の運用向けです。

## 概要とクライアント

BellTeam は、同一コンテナ内（および接続したリモート端末上）で常駐する AI CLI（Claude Code・Codex・Grok・Cursor）の Bot を定義し、ユーザーとの会話、Bot 同士の直接メッセージ、複数 Bot のルーム会話を Aiterm へ配達する自己ホスト型の AI チーム運用基盤です。アプリから Bot とルームを追加し、プロフィール、メンバー、目的、代表、アバター、自動実行予定、Lattice 工程表、相関図、決裁連携を管理できます。

ルームでは発言を全メンバーへ届け、TypeSafe を設定すると Jev が返信者を選びます。入力欄の左で返信者を手動指定することもできます（TypeSafe の API キーは設定画面で登録。未設定時は手動指定。発言履歴は Throughline の公開 `room-context --json` で直近 3 ターンを取得し、API キーはリポジトリや Bot へ渡しません）。

> **ブラウザ版について**：ブラウザ版 Web UI は 2026-11-22 に終了しました（[web-gateway 正本](docs/architecture/modules/web/README.md)）。サーバーの HTTP 入口はネイティブアプリ向け API/SSE ゲートウェイとして稼働し、ブラウザで直接開くと終了案内（410）を返します。

対応ネイティブアプリ（LAN 直接接続または Cloudflare Access 経由）：
- **iPhone・iPad**：[BellBot](ios/BellBot/README.md)（SwiftUI）。iPad 版は [BellTeam for iPad](docs/ipad-app.md)（Mac 版と同じ画面ファイルで広さに応じて 3 ペイン配置）。
- **Mac**：[BellTeam for Mac](docs/mac-app.md)（Mac Catalyst）。一覧・会話・詳細の 3 ペイン、キーボード操作・画像添付対応。
- **Windows**：[BellTeam for Windows](docs/windows-app.md)（WPF / .NET 10 `BellTeam.Core`）。
- **Linux**：[Linux アーキテクチャ](docs/linux-architecture.md)（Avalonia / `BellTeam.Core` 共有）。
- **Android**：[Android アーキテクチャ](docs/android-architecture.md)（Avalonia / `BellTeam.Core`・Linux UI 共有）。

現行設計の正本は [docs/current-design.md](docs/current-design.md)、機能図と所有権は [docs/architecture/feature-map.md](docs/architecture/feature-map.md)・[docs/architecture/module-ownership.md](docs/architecture/module-ownership.md)、最後に実測した運用状況の案内は [docs/current-status.md](docs/current-status.md) に置きます。

## 通話ブリッジの接続

通話を設定すると、BellTeam は Claude・Codex・Grok・Cursor の全 Bot へ `call-bridge` MCP を登録します。各 CLI は BellTeam 本体の内部入口（コンテナ内の loopback）へ HTTP で接続し、本体がメインサーバーの HTTP MCP へ中継します。Bearer 認証値と接続先は CLI 設定に書かず、本体が `/srv/bellteam/shared/tools/call-bridge/headers`（権限 600）から読んで付けます。接続先と合言葉は設定画面または案内役との会話で登録し、未設定時は無効になります。

着信口は `BELLTEAM_CALL_BRIDGE_SOCKET` の UNIX ソケット（既定 `/srv/bellteam/shared/tools/call-bridge/bellteam.sock`）で、BellTeam が作成し、ブリッジ側は親ディレクトリを `/run/bellteam` へマウントして `CALL_BRIDGE_BELLTEAM_UNIX=/run/bellteam/bellteam.sock` で接続します。通話の公開操作は `grokbot-bridge` MCP に置き、BellTeam MCP へ通話ツールを追加しません。外部の通話相手は通話ブリッジ経由の送信者として表示し、ユーザーや BellTeam Bot の ID に置き換えません。

メインサーバーでの取り込み：
- `cd /home/kite/call-bridge && python3 scripts/export_connection.py --json | docker exec -i bellteam node /app/scripts/import-call-bridge.mjs`
- 取り込み口は stdin を 64 KiB まで読み、値を表示せず、コンテナ内 loopback から `PATCH /api/settings/callBridge` で稼働中の本体へ渡します（`.env` 書換・再起動なし）。認証ファイル・ソケット・各 CLI の通話 MCP 登録は設定反映で再構築され、通話 MCP は Bot プロジェクトから決めた ID を `X-Call-Bridge-Caller-Id` で付与します（`src/call-bridge-mcp.mjs`）。

## 自動実行予定と Bot 環境

- **自動実行**：一回・毎時・毎日・曜日指定・○日おき・○時間おき・cron 式に対応。実行済みで次回のない単発予定は一覧に表示せず、実行記録のみ保持します。予定の内容は `prompt`（AI への指示）または `command`（AI を起こさず Bot フォルダで `sh -c` 実行）のどちらか一方とし、AI を起こす必要のない機械作業は `command` にします（`command` は失敗時のみユーザー会話へ 1 件残し、成功時は何も出しません）。予定は Bot・ルームごとに 1 ファイル（`schedule.json`）で、BellTeam 内の scheduler が解釈します（ホストの crontab は使いません）。
- **Bot 開発環境**：各 Bot はコンテナ内のパスワード不要 sudo と標準の Python・Node・Corepack・ビルド道具を使って独自環境を構築できます。`environment/setup.sh` はコンテナ起動時に AI を起こさず再実行し、`environment/env.sh` は会話用 CLI とコマンド予定へ適用します。詳細は [docs/bot-environment.md](docs/bot-environment.md) を参照。

## BellTeam MCP

BellTeam MCP はコンテナ内の Claude・Codex・Grok・Cursor へ登録されます（通話 MCP は通話設定時に登録）。

```text
sendmessage(target, message, image?)
list_bots()
get_bot(botId)
get_self()
get_owner_profile()
get_user_rules()
restart_session(botId?)
set_fast_mode(enabled, botId?)
delete_bot(botId?)
update_self(name?, profileText?, personality?, speechStyle?, position?, role?, avatar?, color?)
update_bot(botId, name?, profileText?, personality?, speechStyle?, position?, role?, avatar?, color?, harness?, model?, reasoningEffort?)
set_avatar(path, botId?)
create_bot(name, harness, profileText?, personality?, speechStyle?, position?, role?, avatar?, color?)
set_schedule(kind, prompt | command, at? / expression?, timezone?, botId?)
list_schedules(botId?)
remove_schedule(id, botId?)
list_messages(botId)
list_rooms()
get_room(roomId)
create_room(name, memberIds, purpose?)
update_room(roomId, name?, purpose?, representativeId?, memberIds?)
delete_room(roomId)
invite_to_room(roomId, botId?)
leave_room(roomId, botId?)
sendroommessage(room, message, image?, targets?)
list_queued_messages(botId?)
list_room_messages(roomId)
set_room_schedule(roomId, kind, prompt, at? / expression?, timezone?, targets?)
list_room_schedules(roomId)
remove_room_schedule(roomId, id)
```

- メッセージ配送は宛先 Bot を定義から探し、Aiterm の `pty_send` へ直ちに渡します（セッションが無ければ起動）。実行中ターンへの差し込みと新ターン開始は Aiterm が判断し、確定回答はターン完了後に会話へ追加します。
- オーナープロフィールは `/srv/bellteam/owner/profile.json` を唯一の正本とし、アバター本体を除く最新値をセッション起動と全メッセージ配送へ自動添付します（再起動不要）。
- Bot プロフィールは `/srv/bellteam/bots/<bot-id>/bot.json`、予定は同フォルダの `schedule.json`、ルームは `/srv/bellteam/rooms/<room-id>/` に保存します。
- 永続保存の正本は Bot 固有資産 `/srv/bellteam/bots/<bot-id>/` と共有ツール `/srv/bellteam/shared/tools/<tool-id>/` の二系統のみとし、それ以外のコンテナ内パスは基盤更新で消失・上書きされる前提とします。
- チャット画像は Aiterm の `image` 引数で全ハーネスへ渡し、会話表示用の画像資産として保存します。画面上の Bot 名は `名前 役職`（役職未設定時は名前のみ）で表示します。
- 開発機で実行する場合も CLI 設定はリポジトリ内の `runtime/home`（または `BELLTEAM_HOME` の絶対パス）へ生成し、開発者のホームへ書き込みません。

## トークン・パスワードの受取

Bot は共通 MCP の `request_secret` でアプリの会話へ専用の入力カードを出せます。不要になった依頼は `cancel_secret_request` で取り下げます（入力済みなら保存値も削除）。値はチャット本文へ送らず永続領域へ保存します。詳細は [秘密情報の入力](docs/secret-input.md) を参照。

## 起動・AI CLI 導入・本番反映

- **新規設置**：[一般配布サーバーの installer](distribution/server/README.md) を使います。追加機能の設定は不要で、起動後にアプリから接続し、ハーネス選択・CLI 導入・公式認証・案内役との会話を行います。接続先は同一マシンなら `http://localhost:18891`、LAN 上なら `http://<LANアドレス>:18891` です。Cloudflare Access を有効にした公開ドメインでは Access JWT の署名・発行元・audience・期限を検証し、LAN 直接接続も維持します。
- **AI CLI と認証**：サーバー image には AI CLI（Claude Code・Codex・Grok・Cursor）を同梱しません（a451）。利用者がアプリの「AI の認証」から各 CLI の最新版を `/home/bell/.local` へ導入し、Aiterm の公開認証入口経由で公式サイトにて認証します。BellTeam はハーネスごとの認証コマンドや資格情報を所有しません。Node.js・Corepack・Aiterm・Throughline・GitHub CLI・1Password CLI・mcp-lazy 等の基盤はコンテナ image 構築時に公式現行版を導入します（`Dockerfile` 参照）。
- **本番反映**：commit してから `scripts/deploy.sh` 一回で行います。コンテナ再起動で Bot 全員が停止するため、**実行前に必ずオーナーの許可を取ります**。GitHub `main` への push、本番での `git merge --ff-only`、ビルドまたは受入済み digest の反映、`healthz`・CLI 版・Bot 稼働数の確認までを行い、失敗時はコンテナを入れ替えません。
