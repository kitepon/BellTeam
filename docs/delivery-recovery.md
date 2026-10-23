# 起動結果不明になった直接配送の明示再開

初期起動で端末は作られたものの、起動結果が不明となって本文が発行されなかったBot間の直接配送を扱う。履歴のfailedやqueue不在だけでは未送信と判断しない。自動再試行や、新しい配送へ本文を複製する処理は追加しない。

## 対象と入口

本体APIは `POST /api/deliveries/direct/<元delivery_id>/resume`。既存のAPI認証を通し、JSONは `{"target":{"session_id":"元の席名","launch_id":"照合した元世代"}}` を渡す。本文・送信元・新しい配送IDは受け取らず、保存済みの元レコードと送信時の表示名を使う。実行は一度ずつ行い、結果不明のHTTPを反復しない。

この入口にはAitermの `agent_execution.action=reconcile_launch` が必要。公開0.61.6には無く、0.61.7には旧accepted receiptで別の現世代の不明を解除する欠陥があるため、修正版の公開0.61.8を使う。未公開候補と公開版は、版表記が同じでも別bytesとして照合する。正式公開物の本体互換・センチの事前試験を受け、同じruntimeの世代を保つ実行方法を確定してから使う。コンテナ再作成で元の/tmp graphやnativeを消し、回復成功と扱わない。

今回の対象は本文だけのBot間直接配送。通話、room、添付、オーナー入力、保存元が無いものはこの経路で再開しない。launch issued、送信結果不明、世代証拠不足はAitermの拒否を保持する。

## 処理

1. 元deliveryの保存レコードを読み、既存の利用条件・稼働状態を確認する。
2. 元requestのstatusからsourceとreservationを復元する。再registerや新しいingressを作らない。
3. Aitermが元created native/server・現世代・本文未発行を照合する。成功時も予約・metadata・世代を維持する。
4. 本体のagent_launch不明だけを解消する。close/configureの不明や、照合中に起きた停止・別の席変更は解消しない。
5. 同じexecution参照で既存の通常send/完了監視へ渡す。既にsend acceptedなら本文を再発行せず、既存の型付き実行エラー形式で競合を返す。元sourceの失効や停止も通常のAiterm gateへ委ねる。

Bot側の受信・返答完了と、本文の受付receiptは別に確認する。履歴は同じdelivery_idの状態を追記し、元のメッセージ行は増やさない。サクラからの監査依頼を扱う場合は、実行する対象と方法を事前にサクラへ伝え、本人と重ねて配送しない。

## 本体更新を伴う既存障害への適用

旧本体に正規の再読込入口が無い場合は、このAPIを外から差し込んだり、本体の不明mapを手で消したりしない。同じ旧runtimeへ新しい正式packageの正規stdioを接続し、本文なしで元request・世代・未発行を照合してreceiptを保全する。その後、既存のquiet・個別許可・バックアップ条件を満たして受入済み商用imageへ更新する。

更新後は、確認済み未発行の対象だけを依頼者が通常MCPで一度届け直す方法も使える。旧refを新scopeへ流用せず、旧failed ID/receiptと通常の新delivery IDを記録する。未発行と確定できないものをこの方法へ含めず、他の担当者は並行再送しない。同runtimeでこのAPIを使える場合の元ID再開とは、記録と手順を区別する。

## 起動結果不明のままCLIが終了した場合の明示close

`POST /api/deliveries/direct/<元delivery_id>/close-launch` は同じ `target` を受け取り、保存された本文だけのfailed直接配送を特定する。これは本文を送る入口ではない。既存の認証・利用条件を確認し、Aitermの `agent_execution.action=close_launch` に元requestと期待launchを渡す。session_idだけの `pty_close` へは落とさない。対応する製品候補の正式公開と商用受入前には使用しない。

製品は同じ元request/launch/creator nativeとserver、未発行の初期本文とsend、現在のCLI終了を受付と作用直前に照合する。実close・不在確認・metadata commit後の `aiterm.closed-launch.v1` 証明を `_meta['aiterm/closed_launch']` に返す。本体は元execution recordが不変で、receiptのrequest/target/管理RPC ref/不在・commit証拠が一致した時だけ、対応する局所agent_launch不明を解除する。停止・処理中・後発の不明が割り込んだ場合は解除しない。同じcause文字列でも後発の不明は別として扱う。

close応答のstructuredContentは別管理requestのExecutionRecordであり、元deliveryのrecordではない。本体は管理recordのrequest/期待launch/close受付を照合し、元requestのstatusを読み直して変更されていないことも確認する。

元unknown execution/failed履歴/送信元は保持し、本文の自動再送・新しいdelivery作成は行わない。結果欠測・不正receiptでは局所不明を残す。後の新しい起動へ古いclosed receiptを流用しない。close後の新配送は依頼元・対象・単独実行者を合わせた別の通常工程にする。

## 検証

`node --test test/delivery-recovery.test.mjs` は人工応答とloopback HTTPで元source/予約・保存本文・一度のsend、重複・停止・世代失効・非対応・不正receiptの扱いを確認する。実Botや本物の認証は使わない。製品nativeの隔離受入と商用image受入は、固定source/tgz/digestを付けた担当記録で別に扱う。
