# Appleと実サーバーの結合試験

repo rootで依存を導入済みのNode 24以降を使う。

```sh
BELLTEAM_INTEGRATION_PORT=18893 node test/helpers/apple-integration-server.mjs
```

起動時にJSONで`url`と`sourceRevision`を出す。Apple Debugアプリの既存プレビューへ次を渡す。`-bellbot-preview-events`はApple側の受信実装ブランチで追加する引数である。

```text
-bellbot-preview -bellbot-preview-server http://127.0.0.1:18893 -bellbot-preview-events
```

HTTP中継と製品サーバーは両方127.0.0.1だけへbindする。iOS Simulator/Macから使い、実機や外部公開は対象にしない。fixtureはOS一時領域へ作り、正常終了で削除する。SIGINT/SIGTERMで終了できる。APIのGETは実`createBellTeamServer`に通る。APIへの書込みは人工診断以外405で記録する。実Bot、Aitermプロセス、資格情報、実DB、予定実行へ接続しない。

画面一覧は`PreviewFixtures.swift`のJSONから作り、bot-one=ユキ、bot-two=ハル、bot-three=ナギ、planning=計画室、ideas=アイデア室。各Bot初期2行のIDは`baseline-bot-one-1`等。room初期行は`baseline-planning-1`等。場面が返した`id`/`text`で表示や実GETの結果を照合する。

試験操作はGETまたはPOSTで`/test/<場面>`へ送れる。本文は使わずqueryで指定する。順次実行し、変更の返答後はSSEの受信/UI反映を待つ。これらは製品のAPIではない。

| 場面 | 操作例 | 発生源・期待する範囲 |
| --- | --- | --- |
| 初期化 | `/test/reset` | 全fixture/証拠を初期化しSSEを閉じる。アプリ起動前に実施 |
| 証拠消去 | `/test/clear-proof` | データ/SSEは残す。初回GETが収束した後に実施 |
| 別Bot | `/test/bot?bot=bot-two` | 実履歴追記/監視、timeline、bot-twoのみ |
| peer両端 | `/test/peer?from=bot-one&to=bot-two` | 実履歴、timeline、両Bot |
| 過去status | `/test/status?id=baseline-bot-one-1&delivery=failed` | 実履歴、timeline、元メッセージのBot |
| room | `/test/room?room=planning` | 実room履歴/監視、timeline、planning |
| queue開始/終了 | `/test/queue?bot=bot-one&room=planning&active=1`（終了は0） | 人工job、実emitQueueと実queue API、bot-oneとplanning |
| 依頼カード | `/test/request?bot=bot-one&room=planning` | 実SecretRequests、requests、該当会話 |
| 依頼取消 | `/test/request-cancel` | 省略時は直前依頼。`id`指定も可 |
| 質問カード/回答 | `/test/question?bot=bot-three`、`/test/answer` | 実OwnerQuestions、questions、bot-three。回答は直前idか指定id |
| Bot予定 | `/test/bot-schedule?bot=bot-one` | 人工registryへ未来予定「結合試験予定 bot-one」を追加しschedules通知、bot-one |
| room予定 | `/test/room-schedule?room=planning` | 実room定義へ未来予定「結合試験予定 planning」を保存、実watchのschedules、planning |
| owner | `/test/owner` | 人工ownerデータと人工registryのowner限定通知 |
| Botプロフィール | `/test/bot-profile?bot=bot-two` | 人工registry更新、bots限定通知 |
| 不明な宛先 | `/test/unknown` | 実履歴へ未知status、all:true |
| 旧形式 | `/test/legacy` | 試験中継からmessages `{at}`を注入 |
| 不正JSON | `/test/invalid` | 試験中継からmessages `{broken`を注入 |
| 未知topic | `/test/unknown-topic` | 試験中継からall:false/future-topicを注入 |
| 再接続 | `/test/reconnect` | SSEを閉じる。アプリが再接続した時のreadyは実製品 |
| 証拠 | `/test/proof` | API要求/応答status、配信、操作、人工CLI、接続数、sourceRevision |
| 場面表 | `/test/scenarios` | 全場面の説明 |

実履歴、room、カード、queueはPR50の製品コードを通す。Bot予定/owner/プロフィールの通知元は人工registryであり、製品BotRegistry自身の保存試験を代替しない。製品側のBot予定通知は`server-performance-remaining.test.mjs`で検証する。legacy/invalid/unknown-topicは製品が生成した通知ではなく、Apple受信の互換フォールバック試験用である。

`/test/proof`の`events`には接続番号、event名、raw frame、解析JSON、配信時刻、`origin`が入る。`product-server`と`test-injection`を区別する。`requests`にはmethod/path/query/受付時刻/HTTP statusが入る。SSEは終了しないので記録のstatus=200は接続応答であり終了ではない。`changes`は各製品watch/queueから受けた通知の発生源、時刻、元のchange。50ms窓で別の通知が合流するため、必要topicと宛先の包含を確認し、追加topicを欠落や異常と判定しない。`controls`は人工操作の履歴。`connections`は累積、`subscribers`は現在数。resetは証拠も消すが累積接続番号は維持する。clear-proofは現在の接続にreadyを再配信しない。

初回readyは接続前の初期GETと接続までの隙間を埋める全体照合、再接続readyも全体照合を期待する。各場面では通知を受けてから画面の文字/状態とGET記録を比較する。別Bot通知時の無関係な会話GET抑制、対象新着の表示を代表UIで検証する。予定だけの通知は予定画面への更新を期待し、会話GETを必須としない。時刻やGET数は人工結合試験の結果であり、本番性能の証明には使わない。

予定は`enabled:true`、`nextRunAt:2099-01-01T00:00:00.000Z`でApple予定一覧の表示条件を満たす。既定titleはBotが「結合試験予定 bot-one」、roomが「結合試験予定 planning」。`title` queryで変更できる。予定の実行器やschedulerを構築せず、人工Bot registryは保存/一覧/通知だけを持つ。手動runを含むAPI書込みは405で、予定実行へ接続しない。

helper自身の試験：`node --test test/apple-integration-server.test.mjs`。
