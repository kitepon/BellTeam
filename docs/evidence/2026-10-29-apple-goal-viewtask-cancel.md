# 初回Goal読取を背景化時に取り消す

修理sourceは`a414f44426a5f3b15e69ba476a646598b61c70aa`。署名済み版77と旧版78署名無し候補`8aac765d9b47725a94739bb7ae8ef1c28cc06e2d`には含まれない。

eb392 count33の[有限評価原本](samples/2026-10-29-apple-count33-evaluation.json)は4,030B、SHA256 `d0e566f319b92222d621ecd9d1806c440cbb6c80bebfa043758de132c72eadf3`。診断原文は2,290B、末尾LFなし、SHA256 `74420319597557c9923007db3c8f8b37df8970a3d3372bee981483e9f96866c9`を照合した。版77の`list_view_task`はactive中に呼ばれ、1ms後に一覧GETを開始し、その571ms後に最後のbackground変更が記録された。GETは約139.4秒後に`-1001`で終了。再利用接続に`requestEnd`はあるが`responseStart`はない。サーバー受付、通信の時間切れ原因、画面回復は未確認で、count33はwarn/open、原因・回復unknown、`repair_success=false`のまま。

版77の`list_view_task`はSwiftUIの`.task(id: selectedTab)`から`loadList`を直接呼び、`chat_view_task`も`.task(id: botId)`から`loadDetail`を直接呼ぶ。非active時に取り消す既存の`GoalForegroundLoad`は`list_foreground`と`chat_foreground`だけを所有していた。今回の実標本は一覧だけで、会話は同構造のsource範囲として扱う。

初回表示の二つのcallerも既存`GoalForegroundLoad`へ結んだ。呼出し時の`scenePhase`が非activeなら子Taskを作らず、稼働中のTaskにも触れない。activeから非activeへの変更とView離脱ではこれまでの`cancel()`が両者を取り消す。`.task`の親がtab/Bot切替で取り消された時は、その親が開始した子Taskだけに取消を伝え、新しいTaskを巻き込まない。新要求は旧Taskの終了を待ってから読取る。診断contextはTaskを作る前、最初の`await`より前に採る。手動・event・change_reconcile、通信retry、ID、POST、時計ログは変更していない。

## 有限検証

- focused試験`NetworkRecoveryTests/testGoalViewTaskCancellationDoesNotCancelItsReplacement`と`testInactiveGoalViewTaskDoesNotStartOrCancelCurrentRead`は2件成功・失敗0。旧wrapperの取消が子へ伝わり、急な非active→activeでは旧処理の終了を待った後に現GETが1回成功し、旧wrapperの遅い取消は現GETを止めなかった。初回から非activeの入口は新読取0回、稼働中Taskの取消0回。XCResult: `~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-bf5fe1dd20e1/result-bundles/test_sim_2026-10-29T14-09-28-305Z_pid90630_79b2396a.xcresult`。
- 同試験のiOS SimulatorビルドとMac Catalyst Debug buildは終了0。Macログ`runtime/apple/goal-viewtask-cancel/mac-build-final.log`のSHA256は`5fb195da80cebe920e666f0fd60807f513b58e51b9c70c4d845d4b2aa3b15e84`。ログには既知のAppStore actor隔離警告と、`exit code 0`を含むXcodeの`error:`行がある。実プロセス終了は0。

人工試験は実端末の長いGET、OSの休止、SwiftUI callbackの実時刻、サーバー受付、画面回復を再現しない。旧UI・Save・Node・送信の試験群は再実行していない。Host・実Bot・署名・Apple配布は操作していない。旧版78署名申請は新source未収録のため未回答のまま取り下げ、版78の署名jobは開始していない。
