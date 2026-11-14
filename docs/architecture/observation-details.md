# 自主ターン・報告・idle観測

対象sourceと確認範囲は[全体図](feature-map.md)に従う。本体から送った文以外で始まったターンも、処理中表示と回答を別の正本から拾う。

## nativeの現在と、保存された回答

正本を[会話・履歴module](modules/conversation/observation.md#nativeの現在と保存された回答)へ移した。

## 報告が不足した時だけ、通常通知へ戻す

正本を[会話・履歴module](modules/conversation/observation.md#報告が不足した時だけ通常通知へ戻す)へ移した。

## idle closeは時間だけで決めない

```mermaid
flowchart TD
  Poll["5分ごとにBotを観測"] --> Exists{"席が存在するか"}
  Exists -->|"いいえ / 観測失敗"| Reset["idle計測を捨てる"]
  Exists -->|"はい"| Quiet["入力待ち・起動後process 0<br/>子配送0・本体処理なしを確認"]
  Quiet --> Since["画面変化がなければ静かな開始時刻を保持"]
  Since --> Time{"30分以上か"}
  Time -->|"いいえ"| Keep["今回は閉じない"]
  Time -->|"はい"| Approval{"Approval Boxが申請者を起こす約束を持つか<br/>approval-box version --json の capabilities に bellteam-requester-wake"}
  Approval -->|"不明（無い・読めない・持たない）"| Keep
  Approval -->|"持つ"| Close["closeIdleで処理と設定待ちを再確認"]
  Close --> End["pty_close・保持画像削除<br/>計測を除く"]
  Poll --> Wake["approval-box version --json をtickごとに1回読む（bd03）"]
  Wake -->|"bellteam-requester-wake を持つ"| Old["Botの古い席<br/>transport.closeOldSeats（a48）"]
  Wake -->|"不明"| Keep
  Old -->|"quietSessionを満たす"| OldClose["pty_close（Botの席ではないので配送・停止世代は触らない）"]
  Old -->|"作業中・裏の作業・不明"| Keep
```

`IdleSessions.checkBot/quietSession`が観測のcursorとsinceを所有する。count未提供や未知を0にしない。答えを待つ申請があっても、Approval Box（0.1.34以降）は受け手を失ったBellTeam発の申請について申請者へ公開sendmessageで一度起こしてresume_decisionを促す（ナユタの製品契約）。だから閉じてよいかは席ごとの件数でもプロセス木でもなく、入っている同梱物がその約束を持つかだけで決める（bd03、2026-11-14）：`$BELLTEAM_HOME/.approval-box/bin/approval-box version --json` の `{schema:"approval-box.version.v1", capabilities:["bellteam-requester-wake"]}`。tickごとに1回だけ読む。無い・終了コード非0・読めない・capabilityが無い時は不明で、どのハーネスの席も閉じない。`transport.closeIdle`はcloseのPromiseをconfigurationChangesへ登録し、その間の新送信を待たせる。これは本体側の既存idle整理であり、Aiterm自身のidle clockへ新しい設定を渡す機能ではない。同じtickで、アカウント移動が残した古い席を`closeOldSeats`が同じ`quietSession`で閉じる（30分の計測なし。契約はexecution harness-accounts.md「Old seat exit」）。

実装：[self-turns.mjs](../../src/self-turns.mjs)、[seat-turns.mjs](../../src/seat-turns.mjs)、[seat-activity.mjs](../../src/seat-activity.mjs)、[turn-reports.mjs](../../src/turn-reports.mjs)、[idle-sessions.mjs](../../src/idle-sessions.mjs)。確認先はself-turns、seat-turns、turn-reports、idle-sessions。自然30分の実席観測や旧ターンの再送は行っていない。
