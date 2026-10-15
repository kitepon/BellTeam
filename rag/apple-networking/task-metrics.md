# BellTeamの通信失敗を要求ごとに読む

出典: [Appleの一次資料](raw/urlsession-task-metrics.md)とBellTeam iOS Simulatorの隔離試験。取得日: 2026-10-15、確度: API仕様は公式、アプリへの適用は模擬通信で再現。

`URLSessionTaskMetrics`は要求ごとのdelegateで受け取れる。HTTP 5xx・時間切れで失敗した要求の経路と時刻を、呼出し画面が結果を扱った後の診断へ渡す。経路はBot・ルームIDを`:id`へ置き換え、query・host・本文・鍵を保存しない。

端末の要求開始時刻とサーバーの受信時刻は時計差を含むため、直接の差分だけで停止した区間を断定しない。TaskMetricsの段の時刻は存在した値だけを記録し、値が無い段を通信未到達の証拠とは扱わない。取得できない要求は`task_metrics_available=false`とする。接続再利用の値は同一接続上の全要求の運命を証明しない。
