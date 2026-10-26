# Apple診断の未知経路を設定故障と誤読しない

版68で追加発生した診断指紋`5e6c5a31e1aa6181297148f5ee1dd9e5486c3768c61aa106884b768527a4f141`の3件目は、GETの`-1001`が84.633秒後に起きた。要求traceには`request_route=/api/other`と`operation=unknown`が残る一方、`module=settings`だった。`/api/other`は`BellRequestTrace.route(for:)`が未列挙経路を匿名化した値で、`settings`は`BellDiagnostics.module(for:)`の無条件fallbackだった。したがって、この診断だけから実際の設定APIや画面を特定できない。HTTP応答・statusと実画面の回復も観測されていない。

未知の匿名化経路のmoduleを、既存の汎用ID`app`へ戻した。アプリが固定URLで呼ぶ公開GETのうち、`/api/setup`、`/api/harness-auth`、`/api/goals`、`/api/ai-control`、`/api/user-rules`、`/api/notifications`だけを要求traceで区別する。moduleは既存IDの`session`・`bots`・`settings`・`owner`・`notifications`へ割り当てる。個別のハーネス名、Bot ID、未列挙pathは引き続き`/api/other`で、操作名は根拠がない限り`unknown`のままにする。新しいID、生URL、query、本文、資格情報は記録しない。

独立レビューで、末尾のfallbackを変えるだけでは既知の`/api/settings`・`/api/models`・`/api/subscription`まで`app`へ変わると分かった。この3経路と個別設定の匿名化済み`/api/settings/:id`だけは、従来どおり`settings`へ明示分類する。未知の`/api/other`を`app`へ戻す修理と、既知経路のmodule維持を別の反例で確認する。

この回帰修理後に、未知経路、固定公開GET、既知settings/models/subscriptionの3つのfocused単体試験が成功・失敗0。XCResultは`~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-7078e2c59646/result-bundles/test_sim_2026-10-26T03-11-33-206Z_pid85321_4241b505.xcresult`。先の11件成功は回帰修理前の関連試験であり、今回の3件と混ぜて全群を再実行済みとは扱わない。

人工の未知GET `/api/unlisted/private-value`をtraceに入れ、呼出し元が`/api/settings`と報告しても`module=app`・`request_route=/api/other`・`operation=unknown`となり、private値も設定読取の操作名も出ないことを確認した。固定GETの許可リストと既存moduleへの対応も確認した。iPhone Simulatorのfocused単体試験2件成功・失敗0。XCResultは`~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-7078e2c59646/result-bundles/test_sim_2026-10-26T02-31-32-266Z_pid85321_f0e0ec22.xcresult`。

変更に関係する`BellDiagnosticsTests`全11件も一度だけ確認し、成功11件・失敗0件。XCResultは`~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-7078e2c59646/result-bundles/test_sim_2026-10-26T02-33-03-642Z_pid85321_020587bb.xcresult`。

これは報告内容の修理であり、元の84.633秒の時間切れの原因究明や復旧証明ではない。旧2件のsubscription説明、メッセージPOSTの`-1005`と`-1001`からも補っていない。実通信の再試行、実Bot送信、署名・TestFlight配布は行っていない。
