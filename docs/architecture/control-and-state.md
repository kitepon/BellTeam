# 予定・設定・停止・Goal

[全体図](feature-map.md)の制御側。保存された要求、実行の受付、実行後の観測を分ける。

## 予定は会話の別入口

```mermaid
flowchart LR
  Set["予定の登録・変更"] --> Registry["BotRegistryの予定"]
  Registry --> Due["runDue<br/>停止/時刻/重複実行を確認"]
  Due --> Prompt["prompt予定"]
  Due --> Cmd["command予定"]
  Prompt --> Direct["直接会話または部屋投稿"]
  Cmd --> Child["短命のcommand job"]
  Direct --> Mark["expectedRevisionで実行済みを記録"]
  Child --> Result["commandの終了・中断"]
  Result --> Report["失敗があれば利用者へ報告"]
  Due --> Mark
```

予定の起動とcommandの終了は別の時点。予定処理は失敗・結果不明でもその発行を消して自動再送しない。停止中は新しく発行せず、再開時には停止中に期限を過ぎた予定を `prepareResume` で区切る。古いrevisionの完了で編集後の予定を上書きしない。

夜間の再起動判定に使う完了ターン数はThroughlineの責任である。基底でschedulerだけtransportの再exportを経由していたため、直接 `throughline-context.mjs` を参照する形へ揃えた。Throughline自体の機能変更は不要。

## 設定を保存することと席へ反映すること

```mermaid
sequenceDiagram
  participant Caller as 設定画面/MCP
  participant Admin as BotAdministration
  participant Registry as BotRegistry
  participant Transport as 実行・設定反映
  Caller->>Admin: 更新する設定
  Admin->>Admin: previewと現在の実行状態を確認
  Admin->>Registry: 設定を保存
  Admin->>Transport: configure / 必要な切替を依頼
  Transport-->>Admin: pending または反映結果
  Admin-->>Caller: 保存値とconfigurationApplication
  Note over Registry,Transport: 進行中ならターン終了後に反映
  Transport->>Transport: 必要な停止・設定適用・対応付け
  Transport-->>Admin: 同じ適用要求のaccepted / failedを更新
```

acceptedはCLI側の設定受付の根拠であり、モデルの内部動作を実測した意味ではない。設定だけを保存して反映済みとは扱わない。fastModeの既知未開始時の巻戻しと、失敗した同じ設定値を明示して再試行できる分岐を維持する。

台帳の更新、反映待ちの状態、nativeのsession対応を別の保存経路として整理し、同じMapにまとめない。

## 止める機能と状態の所有

```mermaid
flowchart TB
  One["個別停止"] --> Admin["BotAdministration.stop"]
  All["全体OFF"] --> Control["AiControl<br/>先に新規受付を止める"]
  Control --> Persist["停止意図を保存"]
  Control --> StopAll["登録されたAI作業を停止"]
  StopAll --> Transport["transport.requestStop / interrupt"]
  StopAll --> Commands["schedulerのcommandを中断"]
  Admin --> Transport
  Transport --> Job["DeliveryJobと席の停止世代"]
  Job --> Native["Aiterm agent_stop"]
  Native --> Receipt["nativeの停止結果"]
  Receipt --> Job
  Job --> Projection["止まった/停止未確認の返却"]
  Commands --> Projection
  Projection --> Control
```

AiControlは永続化を待つ前に新規受付を抑止する。永続化や停止確認が失敗しても、黙ってAIを再開しない。個別停止は通常nativeの `agent_stop` に接続し、`stop_sent` やsession保持を返す。停止要求を送ったことを、sessionの削除や外部副作用の取消へ読み替えない。

`stopRegisteredWork` は登録Botだけでなく、transportのjobに残る対象も拾う。現在は `transport.deliveryBots()` がSeatActivityの停止対象からBotを返し、AiControlが内部jobsを読む接続を置き換えた。削除済みBotの進行中jobを含む。全内部Mapを一括で隠す変更はしていない。legacy adapterの停止fallbackと同期的な受付障壁も維持する。

基底の `docs/current-design.md` のiPhone節には「個別停止=close/exists=false/200 stopped」という古い説明が残っていた。今回の文書で通常経路の202 stop_sent/互換経路の200 interruptedへ訂正した。製品の停止処理やApple画面を変更したものではない。

## Goalの操作

```mermaid
flowchart LR
  Request["Goalの取得/変更"] --> Origin["変更はOwner由来か確認"]
  Origin --> Target["session・launch・threadの対象を結ぶ"]
  Target --> Contract["公開schemaとcapabilityを検証"]
  Contract --> API["Aiterm agent_goal"]
  API --> Readback["返却と読戻しを検証"]
  Readback --> Confirmed["applied・acknowledged・confirmedが揃う"]
  Readback --> Unknown["未確認を保持"]
```

参照のために席を起こさない。空のsession、古い対象、未確認のmutationを成功へ補完しない。Goalの永続状態はAiterm側が所有し、BellTeamに同じ状態の別DBを増やさない。

## 関数と確認先

| 段階 | 主な実装 | 変更時に確認する試験 |
| --- | --- | --- |
| 予定の発行/世代/停止 | scheduler.mjs: runDue, dispatchBotSchedule, dispatchRoomSchedule, prepareResume / schedule-mutations.mjs / BotRegistry | scheduler, scheduler-failure, schedule-generation, http-schedule-list |
| 設定更新と反映 | bot-administration.mjs / bot-session-state.mjs / aiterm-transport.mjs | bot-administration, model-application-state, bot-session-state |
| 全体の停止/再開 | ai-control.mjs: AiControl, stopRegisteredWork | ai-control, ai-control-integration, goal-global-stop |
| 個別停止と競合 | session-interruption.mjs / delivery-job.mjs / seat-activity.mjs | member-stop, session-interruption, delivery-job, seat-activity |
| Goalの対象と返却 | bot-goals.mjs / http-goal-api.mjs / mcp-tools.mjs | bot-goals, goal-targets, http-goal-api, grok-goal-current |

実装は `src/`、試験は `test/<名前>.test.mjs`。すべての独立製品内部や全停止競合をこの調査で再試験したわけではない。
