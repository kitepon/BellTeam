# Apple通信時間切れ count24 の照合と追加診断

## 実測の境界

BugHubの`eb39292e…`は`open`、count24、最後の受信は2026-10-28 22:54:46.872 UTC。原本は本番コンテナの`/srv/bellteam/bots/bot-7b140b27/integrations/bughub-normal-log-closure-fields-20261027/logging-policy/reopen-corrected-rule-20261029/eb392-count24-current/`にある。`source-current.json`のSHA256は`1b2ed6c53d9cadee0e4e9d64ec45358db264fb591b185cfba4953dd608b9f77b`、`diagnostic.txt`は`869b9a93380f95713dab457e5ed735eaef4de43dac683ff3eb0b578ce675a116`。この3ファイルだけを読み、実Botへ要求を送っていない。

版`1.0.3(71)`のiPhoneは`GET /api/bots/{id}/goal`の単一試行で`NSURLErrorDomain -1001`を記録した。端末の記録上、22:41:45.273開始から22:54:46.714失敗まで壁時計781,441ms、`DispatchTime.uptimeNanoseconds`差170,278ms、差611,163ms。開始・終了とも`background`、診断送信時は`inactive`。URLSession metricsは1 transaction、既存接続の再利用、request開始から終了が約1ms、response開始値なし。画面の状態と回復は未観測。

Rootが同時刻の本体ログを有限読取した原本は、同ディレクトリの`host-log-observation.json`、`host-log-execution.json`、`server-comparison.json`。CID・image・sourceが前後で同一、抽出は17,973 bytes・上限4 MiB内・partial=false。同じGoal経路に22:41:45.290受付→HTTP200/625msの候補と、22:51:20.064→200/447ms、22:54:47.653→200/851msがある。最初の候補は端末の開始記録から17ms後だが、要求IDと端末の紐付けが無く、同じ要求と確定できない。本体の記録は端末への受信完了も証明しない。これらの候補に13分の本体処理は見えない。

Apple公式の[uptime](https://developer.apple.com/documentation/dispatch/dispatchtime/uptimenanoseconds)は端末睡眠中の時間を除き、[連続時計](https://developer.apple.com/documentation/kernel/1646199-mach_continuous_time)は含む。版71は前者と壁時計だけを計測するため、差611,163msを端末睡眠・アプリ休止・壁時計補正・通信時間へ割り振れない。[URLSessionの要求timeout](https://developer.apple.com/documentation/foundation/urlsessionconfiguration/timeoutintervalforrequest)の標準60秒はデータを待つidle timeoutで、この壁時計の総時間とは同一ではない。

コード上、個別Goal GETはチャットの`.task(id: botId)`、前面復帰、event更新、手動更新と、Goal変更POST失敗後の状態照合から呼ばれる。`.task`には前面状態の条件が無いが、新24件目がそこから発火した証拠は無い。開始時`background`だけで欠陥と判定しない。原因、実画面の回復、サーバー候補と端末要求の同一性は未確定で、修理成功とも扱わない。

## 追加した失敗診断

- 既存の`attempt_N_elapsed_monotonic_ms`を保ち、睡眠を含む`attempt_N_elapsed_continuous_ms`を追加する。両時計と壁時計の比較で時刻補正と端末睡眠の区別を進めるが、アプリ休止や回線時間の証明には使わない。
- 要求とsessionのtimeout設定値を記録する。実際のtimeout判定時刻を示す値とは扱わない。
- AppStoreが観測した画面状態の変更時刻と連番を試行開始・終了に記録する。OSによるアプリ停止時刻そのものではない。
- 個別Goal GET失敗に、チャット初期表示・前面復帰・event・手動・変更後照合の呼出し契機と、画面が呼出し時に見ていたscenePhaseを付ける。新しい要求IDや通信の再試行は加えない。

この追加後も、Cloudflare等の中間経路と本体候補を端末要求へ一意に紐付ける情報、およびオーナーが見た画面は未観測として残る。自然再発を受入条件にしない。`88564` count10と`52b5` count5はRootの正規解決とMast・Anchorの独立確認が済んでいる。今回の`eb392` count24だけを`open`とし、旧count23の受入を新しい発生へ適用しない。

## 有限試験

固定ソース`9df3952228f03ba5d7a32e5e259b9455b86f83d9`から、人工URLProtocolの単一timeoutと状態変更のfocused2件は成功・失敗0。XCResult `~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-bf5fe1dd20e1/result-bundles/test_sim_2026-10-28T23-29-59-277Z_pid49890_44d440c9.xcresult`。人工Goalの呼出し項目と秘密経路の非出力はfocused1件成功・失敗0。XCResult `~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-bf5fe1dd20e1/result-bundles/test_sim_2026-10-28T23-32-32-574Z_pid49890_a53adabb.xcresult`。両原文は[目録](2026-10-29-apple-count24-samples.json)から辿れる。Mac Catalyst Debugの署名無しbuildも1回成功し、ログはgit管理外の`runtime/apple/network-count24/mac-debug.log`に保持した。実端末の睡眠や本番通信を再現した試験ではない。

完了時の関連`NetworkRecoveryTests`・`BellDiagnosticsTests`は計41件成功・失敗0。XCResult `~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-bf5fe1dd20e1/result-bundles/test_sim_2026-10-28T23-39-28-558Z_pid49890_fd8e2020.xcresult`。
