# 起動結果不明になった直接配送の明示再開

初期起動で端末は作られたものの、起動結果が不明となって本文が発行されなかったBot間の直接配送を扱う。履歴のfailedやqueue不在だけでは未送信と判断しない。自動再試行や、新しい配送へ本文を複製する処理は追加しない。

## 対象と入口

本体APIは `POST /api/deliveries/direct/<元delivery_id>/resume`。既存のAPI認証を通し、JSONは `{"target":{"session_id":"元の席名","launch_id":"照合した元世代"}}` を渡す。本文・送信元・新しい配送IDは受け取らず、保存済みの元レコードと送信時の表示名を使う。実行は一度ずつ行い、結果不明のHTTPを反復しない。

この入口にはAitermの `agent_execution.action=reconcile_launch` が必要。公開0.61.6には無く、未公開候補の版表記0.61.6を正式版の対応証拠にしない。正式公開物の本体互換・センチの事前試験を受け、同じruntimeの世代を保つ実行方法を確定してから使う。コンテナ再作成で元の/tmp graphやnativeを消し、回復成功と扱わない。

今回の対象は本文だけのBot間直接配送。通話、room、添付、オーナー入力、保存元が無いものはこの経路で再開しない。launch issued、送信結果不明、世代証拠不足はAitermの拒否を保持する。

## 処理

1. 元deliveryの保存レコードを読み、既存の利用条件・稼働状態を確認する。
2. 元requestのstatusからsourceとreservationを復元する。再registerや新しいingressを作らない。
3. Aitermが元created native/server・現世代・本文未発行を照合する。成功時も予約・metadata・世代を維持する。
4. 本体のagent_launch不明だけを解消する。close/configureの不明や、照合中に起きた停止・別の席変更は解消しない。
5. 同じexecution参照で既存の通常send/完了監視へ渡す。既にsend acceptedなら本文を再発行せず、既存の型付き実行エラー形式で競合を返す。元sourceの失効や停止も通常のAiterm gateへ委ねる。

Bot側の受信・返答完了と、本文の受付receiptは別に確認する。履歴は同じdelivery_idの状態を追記し、元のメッセージ行は増やさない。サクラからの監査依頼を扱う場合は、実行する対象と方法を事前にサクラへ伝え、本人と重ねて配送しない。

## 検証

`node --test test/delivery-recovery.test.mjs` は人工応答とloopback HTTPで元source/予約・保存本文・一度のsend、重複・停止・世代失効・非対応・不正receiptの扱いを確認する。実Botや本物の認証は使わない。製品nativeの隔離受入と商用image受入は、固定source/tgz/digestを付けた担当記録で別に扱う。
