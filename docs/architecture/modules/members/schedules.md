# 予定の公開受付・定義・発行

[担当の正本](README.md)。部屋定義/参加者/targetsの正本は[conversation](../conversation/rooms.md)。

## 予定：定義、発行、実行結果は別

```mermaid
flowchart TD
  Input["予定の編集"] --> Entry["共通MCP入力/席の検証<br/>またはHTTP認証"]
  Entry --> BotMcp["members.schedules-mcp<br/>Botの3道具"]
  Entry --> RoomMcp["members.schedules-mcp<br/>部屋の3道具"]
  RoomMcp --> Access["conversation.room-access<br/>所属/代表の公開検証"]
  Entry --> Http["members.schedules-http<br/>Bot/部屋/全覧/手動run"]
  BotMcp --> Normalize["定義を検証・次回を計算"]
  Access --> Normalize
  Http --> Normalize
  Normalize --> Mutate["Registry別・owner別に<br/>予定文書を更新"]
  Mutate --> File["各ownerのschedule.json"]
  File --> Due["runDue<br/>enabled・期限・停止を確認"]
  Due --> Claim["claimDue: 同tupleを検証して消化保存"]
  Claim -->|"成功の最新snapshotだけ"| Prompt["Bot/部屋へpromptを発行"]
  Claim --> Command["Bot projectでcommandを開始"]
  Claim --> NoGrant["null/応答不明は発行0・再送0"]
  Command --> Finish["背景の終了<br/>失敗ならOwnerへ一通"]
  File --> Manual["手動run<br/>予定時刻は変えない"]
  Manual --> ManualRun["配送 / commandの同じ窓口へ<br/>発行の記録は更新しない"]
```

| 段階 | caller → 関数 | 契約 |
| --- | --- | --- |
| 編集 | HTTP/MCP → Registry.setSchedule → `mutateSchedules` | 既存IDの存在を確認しrevisionを増やす。prompt/commandはちょうど一方 |
| 次回計算 | `normalizeSchedule/intervalDaysNext/cronNext` | once/cron/interval_days/interval_hours。timezoneと暦日で計算。disabledはnextRunAtなし |
| 部屋特有 | `RoomRegistry.setSchedule` | command拒否。targetsは部屋参加者内で重複除去。共通normalizeだけではtargetsを所有しない |
| 更新の順序 | `mutateSchedules` | registry実体とownerごとの短命Promise。read→edit→write、finallyで解放。配送queueではない |
| 自動発行 | `BotScheduler.runDue` → claimDue → dispatch | 同module leaseでfresh読取/消化保存/発行受付。claim前と発行前に停止世代を検証。null/不明は発行0、消化を戻さない |
| 実行記録 | 各Registry.claimDue/skipDue | revision/nextRunAt/enabled/期限を照合し保存。成功時は消化前の最新snapshot、競合はnull。markScheduleRunは互換用に残し自動発行では使わない |
| command | `runCommandSchedule/performCommandSchedule` | jobを登録しAbortSignalを渡す。発行と終了を分け、成功/中断では失敗通知を出さない |
| command停止 | AiControl → `interruptCommands` | 全jobへ先にabortし、completionを集めstopConfirmedを確認 |
| 手動 | HTTP run → `runBotSchedule/runRoomSchedule` | 既存予定を読むがmarkScheduleRunしない。返却202は発行まで |
| 全体再開 | AiControl → `prepareResume` | 進行tickを待ち、同leaseで停止解除要求時刻以前だけskipDue。lastRunAtと新revisionを保持 |
| 定時の席整理 | `restartLongSessions/restartLongSession` | 東京03時、当日一回、idleかつrunning、Throughline完了ターン閾値。現役jobを閉じる処理へ一般化しない |

予定定義と文書共通処理は基底のBotRegistryから`schedule-definition.mjs`と`json-file.mjs`へ移し、Bot/roomが直接使う。BotRegistryの既exportは互換窓口として残す。[整理案D2](../../detail-status.md#d2-機能の所有者を経由している共通処理を分離する)はこの依存方向を対象にする。時刻計算やwriter順序を作り直す必要はない。

## 公開handlerと初回登録

| 所有する窓口 | 入出力と検証 |
| --- | --- |
| `src/members/schedules-mcp.mjs` | botScheduleTools/roomScheduleToolsがBot/部屋各3道具の説明とschemaを提供し、scheduleToolHandlersがset/list/removeを処理。入力は`{registry,rooms,from,args}`、返却は既`{schedule}`/`{schedules}`/`{removed}`。botId省略はfrom |
| 部屋資格 | set/removeはconversationのrequireRepresentative、listはrequireRoomMember。ROOM_NOT_FOUND/MEMBER_REQUIRED/REPRESENTATIVE_REQUIREDはそのまま伝播。拒否時は予定を書かない。targets検証とcommand拒否はRoomRegistry公開API |
| 共通MCP入口 | tool存在/入力キー/active呼出席/台帳refreshを検証後、6道具を登録・委譲。代表資格や予定入力を共通入口へ複製しない。6説明/schemaと登録順は抽出前と一致 |
| `src/members/schedules-http.mjs` | createScheduleApiがBot/部屋の予定CRUD、全予定一覧、手動runを担当。既`http-schedule-api.mjs`は同exportの互換re-export。部屋予定分岐はhttp-room-apiから移管 |
| HTTP部屋予定 | 既認証・URL/status/JSON・rooms.refreshを保持。MCPの代表/所属制限をHTTPへ追加しない。GET200、POST201、PUT200、DELETE204、部屋不在404。bodyのidよりURLのidを使う |
| 手動run | POST `/api/{bots,rooms}/:id/schedules/:scheduleId/run`。既scheduler.runBotSchedule/runRoomScheduleへ渡し、202/{ran:id}。scheduler不在503、発行時刻/revisionの記録は更新しない |

初回共有差分はmcp-toolsの登録/委譲、http-schedule-apiの互換export、http-room-apiの予定分岐除去。次の予定内部/schema/説明/HTTP修理はmembers内で更新できる。RoomRegistry、公開資格helper、schedulerの内部挙動、保存形式、既config/exportを変更しない。

## 名簿と予定の対象集合

```mermaid
flowchart LR
  Active["BotRegistryのactive Map"] --> List["GET /api/bots<br/>利用者向け名簿"]
  Pending["削除未完のreceipt"] -->|"deleting=true"| List
  Active --> Schedules["GET /api/schedules<br/>active Botと現在の部屋のsources"]
  Rooms["現在のRoomRegistry"] --> Schedules
  List -->|"既deletingを任意で読む"| Apple["Appleの期待対象<br/>deleting!=trueのBotと現在の部屋"]
  Rooms --> Apple
  Apple --> Check["sourcesとactive期待集合を照合<br/>既検査を維持"]
  Schedules --> Check
```

利用者向け名簿は削除途中のBotを表示に残す。一方、予定の実行対象と全予定のBot所有者集合はactive台帳だけを使い、pending receiptを再採用しない。部屋は現在のRoomRegistryから取得する。予定0件のactive Botもsourcesの所有者として含める。

[Apple利用側](../apple/README.md)はGET /api/botsの既`deleting`を任意fieldとして読み、trueのBotを期待する予定所有者から除く。fieldが無い従来のBotはactiveとして扱う。active所有者の欠落を含む既検査は維持する。Appleのdecode/表示/照合の内部はApple担当の正本で管理し、ここへ複製しない。

削除未完の修理はmembersの[削除契約](deletion.md)、Appleの期待集合の解釈はApple担当が持つ。名簿件数とsources件数の差だけでHTTP不正や削除完了を判定しない。HTTP200、payloadの意味の検証、実削除の完了は別に扱う。この参照追加は既契約の明記であり、新field/ルート/実削除操作を追加しない。

## 確認範囲

`test/member-schedules.test.mjs`が専用handlerと共通登録、Bot対象省略/指定、Registry例外の同一性、部屋資格拒否時の無書込み、targets検証、command拒否、HTTP CRUD/refresh/手動runと互換exportを確認する。関連MCP/席API、予定の定義・世代、HTTP、RoomRegistry、conversation公開helperの試験を実行する。予定発行の実データやnative、本番へ操作しない。

図はhandler所有とroom-access接続を更新した。予定の入出力・保存・発行・失敗の意味は既契約内であり、時刻計算/予定writer/実行結果の図の構造は保つ。全体はmodule.jsonのroom-access利用を登録して再生成する。

## 独立更新での予定発行

schedulerは親に同じ実体を保持し、membersAdmission（transportの同一実体、又は共通組立から注入）で一tick/手動run/prepareResumeのrootを取る。Botのrefresh/list/claimと配送の第2内部引数に同`{membersLease}`を渡し、Roomの唯一writerへも同contextを渡す。MollyはAiControl.admitをadmitWorkへ注入し、claim前/発行直前に同じ全体停止世代を検証する。03時maintenanceはこのtick leaseの外で既transportの入場を使い、既commandJobs/maintenanceDateは親に残す。

Room予定のtargetsはlistを使わずclaim返却snapshotだけを発行する。claim後の資格は既RoomMessengerが再検証する。commandは親jobを同期登録し、完走を待たずmodule rootを終える。同leaseのnotify受付までの実completionはKiro transportが追跡し、その後のAI完走はdrainに含めない。

応答不明のclaimは親の短命unconfirmedClaimsで同tupleの再要求を抑制する。新revision/次時刻又は削除を観測すると解除。永続発行台帳や自動再送queueは足さず、親全体再起動の履歴保証へ広げない。保存後・発行前の喪失では未配送が残り、lastRunAtは配送成功ではない。[固定契約](module-update.md)の範囲である。

本差分はN102 020c84→fc7ec352→7e4fb90eのRoom claim/skip・同lease会話adapterが前提。作者席ではこの本人3commitをmergeした隔離開発checkoutで検証する。Molly通常候補は同本人sourceを既に取り込んでおり、N102内部を当席で変更しない。新scheduler境界6件と既関連33件の原本は自席integrations/members-module-update-20261103のscheduler-members-lease-tests.log/scheduler-claim-tests.log。Kiro gate内部/実IPC/実AI/配布成功の証明には使わない。

## conversation子導入のcaller context

```mermaid
flowchart LR
  Accepted[親schedulerの受付context] --> Fresh[Bot/Room refreshとlistSchedules]
  Fresh --> Claim[唯一writer claimDue/skipDue]
  Claim --> Delivery[同contextで既配送]
```

runDueのRoom refreshも他の読取/claimと同じ内部optionsを受ける。これは親安定Room facadeへ旧受付leaseを渡す修理で、Room writerを複製しない。後続conversation導入時の両module作用前一括予約は共通assemblyの公開口へ接続し、その実装前に一方のleaseから他方の新rootを作らない。
