# observation — 会話・履歴

[担当と公開契約](README.md) / [全体図](../../feature-map.md)。章を旧詳細図から移管した。

## nativeの現在と、保存された回答

```mermaid
flowchart TD
  Native["Aitermが観測する現在ターン"] --> Seat["SeatTurns<br/>5秒ごとに読む"]
  Seat --> Watch["未観測で本体jobがないターンを追う"]
  Watch --> Busy["処理中・合間の言葉を表示"]
  Watch --> Words["表示済みの言葉と終了時刻を保持"]
  Hook["CLI終了hookでThroughlineへ記録"] --> Changed["DBの更新 / 読み残しを確認"]
  Changed --> Observer["SelfTurns<br/>cursor付きobserver-read"]
  Observer --> Origin["self / 子の結果から始まったターンを選ぶ"]
  Words --> Dedup["同じ回答の先頭と一致する分だけ除く"]
  Origin --> Dedup
  Dedup --> Answer["Owner会話へ回答を保存"]
  Answer --> Check["報告漏れの確認へ"]
```

| 状態所有 | 関数と契約 | 失敗後の状態 |
| --- | --- | --- |
| SeatTurnsのtimer/running/supported | `start/poll/stop → transport.watchSeatTurns`。未対応返却ならpoll終了 | RPC失敗はlog後に次poll。未対応を故障と混ぜない |
| SeatActivityのwatches/followedTurns/shownWords | `watchSeatTurns/watchTurn/beginWatch/endWatch`。取得前後の停止世代一致、idle、未追跡turnのみ開始 | nullは未知なので既watch継続。idle/別turn確認でend。wait異常は安全な途中経過またはstderrへ。回答はここで取得しない |
| SelfTurnsのcursor/seen/lastCompletedAt | `follow/accept/save`。Throughlineのsource_sha256で直近500件を重複抑止 | cursor/pendingはproject別。初回は現在位置へresetし、旧本文を一括再表示しない |
| Throughlineのページ | `readObserverTurns`。wire v2、after/through cursor、page token | projection_pendingは読み残しとして次poll、errorはそのBotをlog。他Bot処理は続行 |
| 古いcursor | `resync` | 最後に読んだ時刻より新しい分を受ける。返る直近会話/100件の範囲外を復元したとは言わない |
| 重複表示 | `withoutShownWords` | 既表示語が全て同順のprefix、同ターンとみなす60秒内、残文ありの時だけ除く。不一致なら全回答を保持 |
| 回答保存 | `appendAnswer → messenger.appendInterimWords` | seenを先に更新しappendをawaitする現順序。保存失敗時の再読を一般的なexactly-once保証と説明しない。永続cursor自体のsave失敗もlog対象 |

この二つは観測元も責任も違う。新しい共通poll managerを作る理由にはならない。Throughline内部やAiterm内部のターン判定は、公開返却との境界で留める。

## 報告が不足した時だけ、通常通知へ戻す

```mermaid
flowchart TD
  End["直接・部屋・自主ターンの終了"] --> View["その時間内の会話記録から<br/>Owner表示と他Bot宛てを集める"]
  View --> Missing{"Ownerへの表示が空か"}
  Missing -->|"空で部屋以外"| Request["報告を通常notifyで依頼"]
  Missing -->|"表示あり / 部屋"| Members{"他Bot宛てがありJev有効か"}
  Members -->|"はい"| Judge["内容の反映と具体性をJevで判定"]
  Members -->|"いいえ"| Finish["追加依頼なし"]
  Judge -->|"不足"| Request
  Judge -->|"充足"| Finish
  Request --> Owner["回答はOwner画面へ<br/>この依頼は再判定しない"]
```

`TurnReports.afterTurn`は配送の終了を待たせないcallbackから呼ぶ。`turnView`は保存時間の幅で直接発言と途中経過を集める。部屋でsilentを守った場合を「表示なし」にしない。Jevのoutcome/substanceは0..1検証後、それぞれ0.35/0.5を使う。判定失敗はlogだけで依頼を送らない。`requestReport`はonTurnEndを渡さず、同じ報告要求の無限連鎖を作らない。追加notify自体も通常の全体停止/入力制御を通る。
