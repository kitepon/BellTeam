# URLSessionの要求単位の計測

出典: Apple Developer Documentation、取得日: 2026-10-15、確度: 公式一次資料。

- [URLSessionTaskDelegate](https://developer.apple.com/documentation/foundation/urlsessiontaskdelegate): `data(for:delegate:)`と`bytes(for:delegate:)`は要求ごとのdelegateを受け取る。
- [didFinishCollecting](https://developer.apple.com/documentation/foundation/urlsessiontaskdelegate/urlsession%28_%3Atask%3Adidfinishcollecting%3A%29): “Tells the delegate that the session finished collecting metrics for the task.”
- [requestStartDate](https://developer.apple.com/documentation/foundation/urlsessiontasktransactionmetrics/requeststartdate): 要求開始の時刻。`connectStartDate`とは異なる。
- [URLSessionTaskTransactionMetrics](https://developer.apple.com/documentation/foundation/urlsessiontasktransactionmetrics): 接続・要求・応答の段が完了しなければ、対応する終了時刻はnilになり得る。
- [isReusedConnection](https://developer.apple.com/documentation/foundation/urlsessiontasktransactionmetrics/isreusedconnection): 持続接続を再利用したかを表す。
- [transactionMetrics](https://developer.apple.com/documentation/foundation/urlsessiontaskmetrics/transactionmetrics): 1つのURLSessionTask中の要求・応答トランザクションごとの計測配列。配列長はアプリが`data(for:)`を呼んだ回数ではない。
- [timeoutIntervalForRequest](https://developer.apple.com/documentation/foundation/urlsessionconfiguration/timeoutintervalforrequest): 追加データを待つ時間の既定値は60秒で、新しいデータが届くと計時がリセットされる。要求全体の単純な締切や失敗区間の特定には使わない。
