# 版90 iPad単体試験の診断出力（人工fixture）

出典: `~/Library/Developer/BellTeam-evidence/2026-11-01-apple-90-signed/ipad-unit.xcresult` の添付を `xcrun xcresulttool export attachments` で取り出した物。固定source main `03ea7eed261ea2cab5cb7742441b05ce0a3ad21c`（Apple版90）、iPad Air 5 / iPadOS 26.6.2、2026-11-01 UTC。194件中187 pass（AuthSetupOrderingTests 4件はfixture URL未構成で判定なし、3 skip）。

全部が人工fixtureの出力で、実端末の自然発生ログではない。実際の集計行（2f9a・8343・eaab2）の原因や回復を証明しない。

| file | 試験 | 添付名 | bytes | sha256 |
| --- | --- | --- | --- | --- |
| `get-bots-connection-lost-two-attempts.txt` | `NetworkRecoveryTests/testRepeatedLostGETReportsOnceAndIncludesAnonymousContext` | 人工GET二試行の診断原文 | 3000 | ea8e63da6906641862f561f4898f7ed1f50153f72cb9d01fef7149ff9b8f9436 |
| `get-messages-timeout-single-attempt.txt` | `NetworkRecoveryTests/testTimedOutGETReportKeepsItsOwnRouteAndStartStateWithoutQuery` | 人工GET単一timeoutの診断原文 | 1892 | 345a938eb0e9a1836332b9b4bdede33135950d0da0cf822981dbc2a8dd96ac8f |
| `post-send-failure-reconcile-cases.txt` | `NetworkRecoveryTests/testSendFailureReconcileReportsOnlyTheLoadCallBoundary` | 人工POST失敗の読直し分岐原文 | 791 | 398b6fc4dbc753d5c88ac305150557a8f5a3618a74fff48c8452943a082170f8 |
| `xcresult-attachments-manifest.json` | （xcresultの添付一覧） | — | — | 01cfa5fa0362c3cfd3bfee225b55e1a2dfaf3f7f8a7163735c3499220a2e3a52 |

無い物: `/api/bots` の -1001（timeout）の原本。timeoutの原本は会話GETだけで、member_list の timeout をこの型で補完しない。
