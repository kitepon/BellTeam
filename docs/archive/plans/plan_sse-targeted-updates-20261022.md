# SSE宛先追加の検討材料（未実装・未合意）

現行wireはevent:messages/data:{at}。50msの共通窓には複数発火元が混ざる。今回の履歴互換修理ではSSEを変更しない。

## 現watchで正確な宛先が分かるか

| 発火元 | 今のcallback | 宛先の根拠と不足 |
| --- | --- | --- |
| ConversationStore.watch | 共通JSONLファイルが変わったことだけ | ファイル名からBotは分からない。新規directのfrom/target、interimのbotはレコードにある。statusはdelivery_idから元レコードとの照合が要る。書込元BellTeamMessenger.append(record)には元情報があるが、外部追記をカバーするには不明時の全体通知も必要 |
| RoomRegistry.watch | messages.jsonlで終わるという判定後、引数を捨てる | recursive watchの相対パスにroomディレクトリがある。appendMessage(id,record)にもroom IDがある。パス欠落/判別不能を特定roomと推測しない |
| SecretRequests.save / OwnerQuestions.save | 引数なしchange | saveするitemにはbotId、secretの場合はroomIdもある。itemの本文や秘密参照先を通知payloadへコピーしない |
| BotRegistry.changed | 引数なし | 呼出し元create/update/removeにはidがある。Bot一覧・設定への変更であり、会話本文が変わったこととは区別が必要 |
| Transport.emitQueue | 引数なし | 4呼出し位置のjobにはbot.idとinfo.context/contextIdがある。ルームの場合はroomとBot両方への影響があり得る |

以上は既存データの根拠で、現在のcallbackだけから常に正確な宛先を復元できる意味ではない。今回作ったBot別履歴索引も、fs.watch一回を一つの書込操作へ確実に対応させる証明にはならない。

## 加算payloadの案

検討例（名前も未確定）:

```json
{"at":"既存どおりの時刻","type":"changes","topics":["timeline","queue"],"botIds":["既存Bot ID"],"roomIds":[],"all":false}
```

event名messagesとatを維持し、追加フィールドは旧アプリに無視される想定。typeの追加は旧Appleのtype処理にも照らして受入確認が必要で、atだけの既存通知を廃止しない。

- `all:false`は、列挙対象がその窓で影響する全宛先を含むとサーバーが根拠を持てる場合だけ。50ms窓内のBot/room集合とtopicsは和集合にし、最後の一対象で上書きしない。
- 不明・宛先判別不能・全体設定変更は`all:true`で全体照合を要求する。窓内に1つでも不明が混ざれば窓全体をall:trueへ寄せ、空配列を『更新不要』と解釈させない。
- 既存{at}のみ、追加フィールド欠落/不正/未知typeは従来の全体照合として扱う。ready/接続復旧の初期照合も維持し、イベント取りこぼしを宛先選別で固定化しない。
- topicsにプロフィール/一覧更新だけを含め、all:falseかつ宛先配列が空の場合の意味は『履歴更新不要、指定topicsだけ再取得』を候補とする。この意味までclient/serverで合意しなければ送らない。

新しいID体系や永続キューは不要で、既存IDを使う。正確な情報を出す発火元変更と、現Appleがtype以外を捨てる境界の変更、旧Web/旧Appleの互換回帰を同期する必要がある。ベルとownerの判断へ提案として返し、この案の実装/配布を今回の互換修理へ混ぜない。
