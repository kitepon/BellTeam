# BellTeam

一般配布サーバーは[設置案内](distribution/server/README.md)を参照。追加機能を設定せずにコンテナを起動し、Webで最初に使うAIを選んで公式認証を完了すると、案内役との会話を始められる。初回設定の仕様は[初回設定と追加機能](docs/onboarding.md)に置く。Macから同じマシンへ、iPhone・iPadから同じLANのマシンへ直接接続できる。

## 通話ブリッジの接続

通話を設定すると、BellTeamはClaude、Codex、Grok、Cursorの全Botへ`call-bridge` MCPを登録する。各CLIはBellTeam本体の内部入口（コンテナ内のloopback）へHTTPで接続し、本体がメインサーバーのHTTP MCPへ中継する。Bearer認証値と接続先はCLI設定に書かず、本体が`/srv/bellteam/shared/tools/call-bridge/headers`（権限600）から読んで付ける。接続先と合言葉は設定画面または案内役との会話で登録する。既存の`BELLTEAM_CALL_BRIDGE_MCP_URL`と認証ファイルは初回に移行する。未設定の通話は無効になり、Webと基本の管理操作を使える。

着信口は`BELLTEAM_CALL_BRIDGE_SOCKET`のUNIXソケットで、既定は`/srv/bellteam/shared/tools/call-bridge/bellteam.sock`。BellTeamが作り、ブリッジ側は親ディレクトリを`/run/bellteam`へマウントして`CALL_BRIDGE_BELLTEAM_UNIX=/run/bellteam/bellteam.sock`で接続する。通話の公開操作はgrokbot-bridge MCPに置き、BellTeam MCPへ通話ツールを追加しない。外部の通話相手は通話ブリッジ経由の送信者として表示し、ユーザーやBellTeam BotのIDに置き換えない。

メインサーバーでは両リポジトリの`.env`を置いた後、BellTeamリポジトリから`sudo -u kite node scripts/prepare-call-bridge.mjs`を実行する。スクリプトはブリッジのCompose設定からトークンを読み、共有領域へ認証ファイルを作り、両`.env`のソケットパスを合わせる。ブリッジの`scripts/issue_token.py`で発行したBellTeam用トークン（`--format header`でこの認証ファイルへ書いたもの）があれば、共通トークンで上書きせずに残す。通話MCPはBotのプロジェクトから決めたIDを`X-Call-Bridge-Caller-Id`で付ける（`src/call-bridge-mcp.mjs`）。値は出力しない。再起動はしない。反映時は先にBellTeamコンテナ、次にブリッジコンテナを新設定で再作成する。BellTeamの再作成には、下記の通りオーナーの個別許可が要る。反映後は4つのCLIの通常のMCP入口で`call_directory`、BellTeam宛ての`call_open`→`call_send`→同じ`session_id`での返信を実測する。

BellTeam は、同一コンテナ内で常駐する AI CLI の Bot を定義し、ユーザーとのWeb会話、Bot同士の直接メッセージ、複数Botのルーム会話をAitermへ配達する。Web UIからBotとルームを追加し、プロフィール、メンバー、目的、代表、アバター、自動実行予定を管理できる。ルームでは発言を全メンバーへ届け、TypeSafeを設定するとJevが返信者を選ぶ。入力欄の左で返信者を手動指定することもできる。

ルームの自動判定には設定画面でTypeSafeのAPIキーを登録する。未設定では返信者を手動指定する。既存の`TYPESAFE_API_KEY`は初回に移行する。発言履歴はThroughlineの公開`room-context --json`で直近3ターンを取得し、Jevへ一度の要求で会話継続と返信者の両方を尋ねる。APIキーはリポジトリやBotへ渡さない。

iPhone・iPad用のSwiftUIアプリは [BellBot](ios/BellBot/README.md) に置く。LANへの直接接続、または設定済みのCloudflare Accessでログインし、BellTeamの会話と主要な管理操作をiPhone・iPadから使える。

iPad版は [BellTeam for iPad](docs/ipad-app.md)。Mac版と同じ画面ファイルを使い、画面の広さに応じて一覧・会話・詳細を配置する。

Mac版は [BellTeam for Mac](docs/mac-app.md)。一覧・会話・詳細を並べ、キーボード操作と画像ファイルの添付に対応する。

現行設計の正本は [docs/current-design.md](docs/current-design.md)、最後に実測した運用状況は [docs/current-status.md](docs/current-status.md) に置く。

自動実行は一回・毎時・毎日・曜日指定・○日おき・○時間おき・cron式から選べる。日おきは開始日と時刻を設定し、2日おきなら開始日・2日後・4日後に実行する。時間おきは毎日の開始時・終了時・間隔・実行する分を設定し、9時〜18時の3時間おきなら9・12・15・18時に実行する。Bot・ルームとも、実行済みで次回のない単発予定は自動実行一覧に表示しない。保存済みの実行記録は保持する。

各Botはコンテナ内のパスワード不要sudoと標準のPython・Node・Corepack・ビルド道具を使って、自分の開発環境を構築できる。`environment/setup.sh` はコンテナ起動時にAIを起こさず再実行し、`environment/env.sh` は会話用CLIとコマンド予定へ適用する。導入・復元の手順は [docs/bot-environment.md](docs/bot-environment.md) を参照。

各BotにはBellTeam MCPが見える。

```text
sendmessage(target, message, image?)
send_user_message(target, message)
list_bots()
get_bot(botId)
get_self()
get_owner_profile()
get_user_rules()
restart_session(botId?)
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

BellTeam MCPはコンテナ内のClaude、Codex、Grok、Cursorへ登録される。通話MCPは通話を設定したときに登録される。全Botの一覧・取得・作成・編集、画像ファイルからのアバター設定、任意Botの予定管理、会話履歴の取得、ユーザーとしてのメッセージ送信はBellTeam MCPから行える。

予定の実行内容は`prompt`（AIへの指示）か`command`（AIを起こさずBotのフォルダで`sh -c`として実行するコマンド）のどちらか一方で、スクリプト実行やサイトの書き出しなどAIを起こす必要のない作業は`command`にする。commandの失敗はそのBotからユーザーへの会話に1件残り、成功は何も出さない。

ツールが宛先Botを定義から探し、全メッセージをAitermの`pty_send`へ直ちに渡す。セッションが無ければBotを起動して渡す。実行中のターンへの差し込みと新しいターンの開始はAitermが判断する。処理中のメッセージはWeb UIとMCPから確認できる。確定回答はターン完了後にWeb UIへ追加する。

オーナーのプロフィールは`/srv/bellteam/owner/profile.json`を唯一の正本とし、左上のアバターから名前、プロフィール、X、GitHub、その他の情報源を編集する。BellTeamはアバター本体を除く最新値をセッション起動と全メッセージ配送へ自動で添付し、Botは`get_owner_profile`でも同じ正本を取得できる。更新のためにBotを再起動する必要はない。

Botのプロフィールは`/srv/bellteam/bots/<bot-id>/bot.json`、予定は同じフォルダの`schedule.json`へ保存する。`list_bots`はこの正本からID・名前・CLI・プロフィール・性格（考え方）・口調・役職・役割だけを返し、別の索引は持たない。ルームは`/srv/bellteam/rooms/<room-id>/`に設定、会話、予定を持つ。予定はBot・ルームごとに一ファイルで、BellTeam内のschedulerが一回日時・cron式・日おき・時間おきを解釈する。hostのcrontabは使わない。

Bot固有のリポジトリ、成果物、ツール利用設定は`/srv/bellteam/bots/<bot-id>/`、共通化を明示したツールとMCPの実装本体は`/srv/bellteam/shared/tools/<tool-id>/`を永続保存の正本とする。それ以外のコンテナ内パスは基盤更新で消失または上書きされる前提とし、唯一の正本にしない。共有ツールを使うかどうかと利用設定はBotごとに管理する。

Web UIでは画像をアップロードし、位置と拡大率を調整してアバターを作る。外部画像URLは使わない。Botを作成すると、専用プロジェクトを作った直後にCLIを起動する。名前、プロフィール、性格（考え方）、口調、役職、役割を初回指示としてAitermへ渡し、確定した挨拶だけをユーザーとの会話へ表示する。画面上のBot名は`名前 役職`とし、役職が未設定なら名前だけを表示する。

チャットでは画像を選択または貼り付けて、本文と一緒に対象Botへ渡せる。画像はAitermの`image`引数で渡し、Claude・Codex・Grok・Cursorのどれでも届く。画像本体はBellTeamへ保存せず、会話ログには画像が付いていた事実だけを残す。

開発機で実行する場合もCLI設定は本リポジトリの`runtime/home`へ生成し、開発者のホームへ書き込まない。専用ホームを変える時は`BELLTEAM_HOME`に絶対パスを指定する。コンテナでは既存の`/home/bell`を使う。

## メインサーバーでの起動

新規の設置は[一般配布サーバーのinstaller](distribution/server/README.md)を使う。追加機能の設定は不要で、起動後にWebからハーネス選択・公式認証・案内役との会話を行う。リポジトリから起動する場合も、Cloudflare Access・TypeSafe・通話・診断連携の環境変数は未設定のまま使える。接続先は同じマシンなら`http://localhost:18891`、LAN上の端末なら`http://このマシンのLANアドレス:18891`になる。既存の本番設定は初回に永続領域へ移行する。

本番反映はcommitしてから`scripts/deploy.sh`一回で行う。コンテナの再起動でBot全員が停止するため、実行前に必ず一度止まり、オーナーの許可を取る。GitHubの`main`へのpush、本番のfast-forward取り込み、公式の現行版を使うキャッシュなしの再ビルド、healthz、CLIの実際の版、Bot数と稼働数の確認までを返す。ビルド失敗時はコンテナを入れ替えない。本番側ではcommitを作らないため、本番とGitHubの履歴は常に一致する。

初回のAI認証はWeb画面からAitermの公開認証入口を使い、利用者が公式サイトで完了する。BellTeamはハーネスごとの認証コマンドや資格情報を所有しない。Node.js、Corepack、Claude、Codex、Grok、Aiterm、Throughline、GitHub CLIは反映のたびに公式の現行版を導入する。Cursorの公式導入先`~/.local`は専用volumeで保持し、コンテナ起動時に`cursor-agent update`で現行版にする。Throughlineは起動時に公式`throughline install`で4ハーネスのhookを更新する。

直接接続ではWeb UIとアプリからLANの接続先を使う。Cloudflare Accessを有効にしたときは、設置先の公開URLと許可対象を使い、BellTeamがAccess JWTの署名・発行元・audience・期限を検証する。Bot間メッセージは会話本文へ複製せず、タップで展開できる送受信履歴として表示する。

## トークン・パスワードの受取

Botは共通MCPの `request_secret` で、iPhone・Webの会話へ専用の入力カードを出せる。値はチャットへ送らず、利用者の永続領域に保存する。使い方・保存場所・通知・失敗時の扱いは [秘密情報の入力](docs/secret-input.md) を参照。
