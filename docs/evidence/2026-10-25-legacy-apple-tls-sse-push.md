# 旧Apple TLS・SSE・通知登録の人工通信試験

旧記録のTLS失敗はモデルGET`2f6b9daed6a3e57a5adfb4d6ac92d8bcd8931904161353c1c47bee092a058e66`と予定GET`061c46a64270dad38e6eaded6a79c6c7751058788c7959f08b420d3a62dec2db`の`-1200`。SSE GET 502は`95eef79b1e34dfcba7b55bb3ad1a54bbc1da5a272be7a271faeabe5ca7c030cd`。通知登録POSTの時間切れは`faab4b9ef06c02f7e957c0ed46def26ce17ae62bb8d9328e96710f8e17e72d68`。元の証明書、外部経路、APNs、画面の原因は未確認で、以下の人工試験から旧件の解消を推定しない。

## TLSの読取り

`NetworkRecoveryTests/testTLSReadFailureStopsUntilExplicitScheduleReload`は`URLProtocol`から予定GETへ`URLError.secureConnectionFailed`（`-1200`）を一度返す。アプリのAPIは失敗を成功にせず、診断`IOS_NETWORK_FAILURE`に`error_code=-1200`を残し、自動GETは1回。次に明示した正常GETだけで予定応答を読めた。focused1件成功・失敗0。XCResultは`~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-bf30729c2d6d/result-bundles/test_sim_2026-10-25T10-04-18-827Z_pid8412_39971bfd.xcresult`。モデルGETも同じ`BellAPI`の読取り境界を使うが、モデル編集画面と実TLS証明書の状態はこの試験で測っていない。

## SSE 502からの再接続

既存の`testEvents502ThenReadyReportsInterruptionAndReceivesUpdate`と`testEvents502ShowsReconnectThenClearsItAfterReady`は、初回SSE GET 502を記録し、iPhoneだけが2回目の接続で`ready`を受け、再接続警告を消す。現ソースでfocused2件成功・失敗0。XCResultは`~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-bf30729c2d6d/result-bundles/test_sim_2026-10-25T10-05-35-817Z_pid8412_bca2885c.xcresult`。

さらに通常のプレビュー`AppStore`とiPhone画面をloopback人工HTTPへ接続し、最初のSSE GETだけ502、次の接続で`ready`を送った。画面上の「再接続」表示が現れて消え、メンバー一覧も見えた。`NetworkLifecycleProbeUITests/testSSE502ShowsReconnectThenClearsOnReady`は1件成功・失敗0。XCResultは`~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-bf30729c2d6d/result-bundles/test_sim_2026-10-25T10-11-27-491Z_pid8412_fb21632e.xcresult`。[人工HTTP記録](2026-10-25-legacy-sse502-proof.json)は接続2回、SHA-256 `0d986be4a7290b10ea29ecea40945c28da2f5ee7f07d44d26513e7ab1c9b48cf`。アプリを閉じた後は購読者0。実サービスの502原因やMac側のSSE動作を判定した結果ではない。

## 通知登録POSTの時間切れ

`testPushRegistrationTimeoutDoesNotAutomaticallyRepeatPost`は実APNs tokenを使わず、人工tokenによる`/api/notifications/devices` POSTへ一度`URLError.timedOut`（`-1001`）を返す。失敗は診断`IOS_PUSH_FAILED`に`stage=register_device`と`notification_error_code=-1001`を残し、POSTは1回で自動再送なし。次の明示的な登録要求で2回目のPOSTだけが成功した。focused1件成功・失敗0。XCResultは`~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-bf30729c2d6d/result-bundles/test_sim_2026-10-25T10-08-52-981Z_pid8412_63cb7e28.xcresult`。これは`BellAPI`と診断の境界試験であり、OSによるtoken発行や`BellNotifications`の画面状態・端末への配達は未確認。

いずれも製品コード変更0、実Bot・オーナー通常アプリ・実APNs token・認証・公開サービス操作0。人工HTTPサーバーは停止し、試験SimulatorはShutdownを確認した。
