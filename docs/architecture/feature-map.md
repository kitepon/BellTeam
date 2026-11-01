# BellTeamの機能とデータの流れ

対象は `546f232180515a2a8cd9098b943673170c49e3d4` のBellTeam本体/API/Web。最初の主要14図と接続整理（PR245）を土台に、機能内の処理・関数・データ所有を詳しく調べている。**全体の詳細化は継続中**であり、この入口図だけを完成図とはしない。[調査範囲と次の整理](detail-status.md)に未完の範囲を明示する。Apple画面内部と独立製品内部は、それぞれの担当の公開窓口までを扱う。

## アプリ全体で何が起きるか

人やBotの操作を受け、会話とメンバーを管理し、必要なAIの実行をAitermへ依頼する。途中経過と結果を記録し、その記録から画面を更新する。予定・記憶・設定・認証は、それぞれ別のデータと判断を持つ。

矢印は依頼またはデータの受渡し。保存データの所有者は後の表で定める。箱は機能であり、一つのファイルやプロセスとは限らない。

```mermaid
flowchart TB
  Human["人が操作する<br/>Web・Apple"] -->|"HTTP要求"| Entry["操作の受付<br/>認証・入力・応答"]
  Bot["BotのMCP"] -->|"ツール要求"| Entry
  Entry -->|"本文・宛先・画像"| Talk["会話<br/>直接・Bot間・部屋"]
  Entry -->|"メンバー・設定・停止"| Admin["メンバー管理と全体制御"]
  Entry -->|"時刻と実行内容"| Schedule["予定"]
  Entry -->|"記憶・知識の操作"| Memory["記憶・知識"]
  Entry -->|"認証・入力・通知設定"| Support["利用を支える機能"]
  Entry -->|"Goal操作"| Goal["Goalの公開契約を検証"]
  Schedule -->|"期限になった発言"| Talk
  Schedule -->|"command"| Command["短命のコマンド実行"]
  Support -->|"回答・秘密ファイルの場所"| Talk
  Talk -->|"実行と進行通知の受取先"| Run["Botの実行・配送"]
  Admin -->|"設定反映・停止"| Run
  Run -->|"起動・送信・観測・停止"| Aiterm["Aiterm<br/>独立製品"]
  Goal -->|"対象の対応付け・agent_goal"| Aiterm
  Run -->|"起動時の文脈を読む"| Throughline["Throughline<br/>独立製品"]
  Throughline -->|"自主ターンの回答を読む"| Observe["自主ターンの観測"]
  Aiterm -->|"途中経過・受付・完了"| Run
  Run -->|"進行・結果"| Talk
  Observe -->|"回答"| Talk
  Talk -->|"発言・状態を追記"| History["会話記録"]
  History -->|"履歴と変更"| View["履歴の組立て・SSE"]
  Support -->|"入力要求などのカード"| View
  View -->|"履歴応答・変更通知"| Human
  Talk -->|"本文を含めない通知"| Push["端末への通知"]
```

HTTP200は操作ごとの受付結果である。AIの回答完了、外部の副作用の成功、画面への表示をまとめて意味しない。

## 症状からどこを辿るか

| 症状 | 切り分ける順序 | 詳細 |
| --- | --- | --- |
| 送ったのに返事がない | 発言保存 → Aiterm受付 → 完了追跡 → 回答記録 → 履歴取得/表示 | [会話](conversation-flow.md) |
| 部屋で返事が来ない | 参加者snapshot → 返信者指定/選定 → 個別配送 → reply/silentの権限 | [部屋の会話](conversation-flow.md#部屋の会話) |
| 設定を変えても動作が変わらない | 保存値 → 反映待ち → CLIの受付結果 → 実際の動作観測 | [設定反映](control-and-state.md#設定を保存することと席へ反映すること) |
| 止めたのに処理が残る | 新規受付の抑止 → 停止要求 → native結果 → 配送job/commandの結論 | [停止](control-and-state.md#止める機能と状態の所有) |
| 記憶が見つからない | 最終botId/scope → 保存先 → DB/知識index → 検索 | [記憶](support-and-runtime.md#記憶と知識) |
| 入力要求に答えたが進まない | 入力状態の保存 → 通知結果 → Botの次の処理。秘密値を通常診断へ出さない | [入力支援](support-and-runtime.md#認証秘密入力質問通知) |

## 元データと判断の持ち主

| 機能・状態 | 所有者 | 他の機能へ渡すもの |
| --- | --- | --- |
| メンバー・設定・予定の台帳 | BotRegistry | 読取結果、更新/予定実行の操作窓口 |
| 部屋・参加者・部屋の履歴 | RoomRegistry / RoomMessenger | 部屋のsnapshot、発言、各参加者の配送状態 |
| 直接会話 | BellTeamMessenger | 保存した発言・配送状態・回答。保存直後の通知 |
| 直接会話の読取cacheと索引 | ConversationStore / TimelineIndex | 履歴のprojection、変更通知。writerではない |
| 一回の配送の受付・失敗・停止結論 | DeliveryJob | 受付結果と配送の状態 |
| 席の進行中操作とjob集合 | SeatActivity | 処理中/queue/停止対象の観測 |
| session対応・反映待ち・停止世代 | BotSessionState | transportを通じた操作と観測 |
| 保存設定を実行へ反映する順序 | BotAdministration + transport | pending/accepted/failedなどの反映結果 |
| AI全体の停止意図と受付抑止 | AiControl | enabled/stopping/stopped/unconfirmed |
| native session・実行・Goal | Aiterm | 公開APIのreceipt、観測、操作結果 |
| 会話から作る引継ぎ情報 | Throughline | 起動時の文脈と保存済みターン |
| 長期記憶・知識と検索 | BellTeamMemory | 指定scope内の記憶/検索結果 |
| 秘密入力・質問・認証状態 | 各専用サービス | 公開状態、カード、値を含めない通知 |
| Webの選択・入力・描画中の状態 | Webクライアント | HTTP操作。サーバーの元データを所有しない |

同じ「状態」という名前でも、全体の停止意図、配送の停止結論、nativeの実行状態、画面の表示状態を一つの値へ潰さない。

## 詳細図から実関数へ

- [HTTP・MCP・自動処理の入口索引](entrypoints.md)
- [メンバー・部屋台帳・予定・指示生成の詳細](registry-details.md)
- [秘密入力・質問・認証・任意機能・通知・購読・診断の詳細](support-details.md)
- [Webの状態所有・会話選択・送信・履歴・SSEの詳細](web-details.md)
- [Webの編集・画像・Goalの詳細](web-management-details.md)
- [配送job・受付・完了・差し込み・画像・部屋の詳細](delivery-details.md)
- [停止世代・設定適用・Goal契約の詳細](control-details.md)
- [自主ターン・報告・idle観測の詳細](observation-details.md)
- [記憶・知識の保存と検索の詳細](memory-details.md)
- [起動・席の短命処理・CLI登録の詳細](runtime-details.md)
- [会話・配送・履歴・画面更新](conversation-flow.md)
- [予定・設定・停止・Goal](control-and-state.md)
- [記憶・認証・入力支援・起動・配布・保全](support-and-runtime.md)
- [供給・installer・状態移行・backup/restoreの詳細](distribution-details.md)
- [外部窓口と共通処理の依存整理](boundary-details.md)
- [第一段で整理した接続](refactor-plan.md)
- [詳細化の確認範囲と次の整理案](detail-status.md)

各詳細図の表に実装と既存試験を対応させる。試験の列は確認対象の案内であり、今回その全試験を実行したという意味ではない。製品の契約は[現在の設計](../current-design.md)と併せて読む。古い説明と現コードの差は実装変更と混ぜず訂正する。
