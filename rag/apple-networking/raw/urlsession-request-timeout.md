# URLSessionConfiguration.timeoutIntervalForRequest

出典: https://developer.apple.com/documentation/foundation/urlsessionconfiguration/timeoutintervalforrequest
取得日: 2026-10-29。確度: Apple公式のAPI説明。

> The timer associated with this value is reset whenever new data arrives. The default value is `60`.

この値はデータを待つ間のidle timeoutであり、要求の壁時計上の総経過時間そのものではない。
