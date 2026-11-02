# 会話・配送・履歴・画面更新

[全体図](feature-map.md)の「会話 → 実行 → 記録 → 表示」を詳しく見る。対象sourceと調査の範囲は全体図に従う。

## 人がBotへ送る

正本を[会話・履歴module](modules/conversation/flow.md#人がbotへ送る)へ移した。

## 実行・配送の分岐

```mermaid
flowchart TD
  Submit["submit<br/>job登録"] --> Gate["停止・設定反映を待つ<br/>受付/権限を確認"]
  Gate --> Send["同じ席の順序で送信"]
  Send --> Result{"送信の結果"}
  Result -->|"receiptあり"| Receipt["受付事実を保存<br/>停止との競合を判定"]
  Result -->|"既知のsession不存在等"| Recover["必要な古い登録の整理<br/>起動して送信"]
  Recover --> Receipt
  Result -->|"受理したか不明"| Unknown["結果不明を返す<br/>本文を再送しない"]
  Receipt --> Follow{"どのターンを観測するか"}
  Follow -->|"新規・次ターンを所有"| Wait["途中経過と完了を追跡"]
  Follow -->|"既存ターンへ差し込み"| Existing["元の観測者の回答所有を維持"]
  Wait --> Done["DeliveryJobの結果<br/>会話側へ通知"]
  Existing --> Done
  Unknown --> Done
```

これは主要な判断点の図。実装の各checkpoint、legacy adapterのreservation、停止との競合処理は `submit/dispatch` と `DeliveryJob` が持つ。unknownをsession不存在と同じ再試行へ流さない。途中経過や回答callbackの表示側失敗と、nativeの配送失敗も同一にしない。

`SeatTurns` は現在のnativeターンから処理中/途中経過を観測する。`SelfTurns` はThroughlineの保存ターンから自主ターンの回答を取り込む。観測対象とタイミングが異なるため一つのpollへ機械的に統合しない。

## Bot間・通話・失敗配送の操作

正本を[会話・履歴module](modules/conversation/flow.md#bot間通話失敗配送の操作)へ移した。

## 部屋の会話

正本を[会話・履歴module](modules/conversation/flow.md#部屋の会話)へ移した。

## 履歴を画面へ戻す

正本を[会話・履歴module](modules/conversation/flow.md#履歴を画面へ戻す)へ移した。

## 関数と確認先

正本を[会話・履歴module](modules/conversation/flow.md#関数と確認先)へ移した。
