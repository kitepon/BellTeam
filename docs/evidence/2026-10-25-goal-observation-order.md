# Order goal observations per member

Independent review PR79-CENTI-1 reproduced a stale mutation response replacing a newer list refresh: pause A was held, refresh displayed thread B, then A's confirmed/paused response restored A and its resume control. A failed mutation's delayed readback had the same ownership problem. Existing native binding checks did not prevent this display rollback.

The view now orders observations per member. A refresh supersedes earlier operations, while a later mutation of another member retains its newer state. Mutation responses and failure readbacks apply only while their member's observation is current. Pending controls are released independently, and a mutation cannot enable the refresh button while a newer list request is still pending. Member order and drafts are retained. No native identity, persisted state or retry is added.

Five deterministic DOM cases exercise the actual module: stale successful mutation, stale failure readback, reverse-order independent member mutations, a mutation newer than an in-flight list, and a failed older list after another member's newer mutation. All five pass. Chromium 1100/390px also retains the existing edit/pause/resume/clear/create, lost-response single send/readback and stale-read behavior with artificial API replies. These frontend checks do not prove native creation/editing.

Final source Node suite: 768 passed, zero failure/cancellation/skip. Private logs are `goal-view-order.log`, `goal-full-order.log`, `browser-goals-order.log` and `browser-goals-order-results.json` under the maintainer's `integrations/goals-composer-20261025/`. The review's original report and counterexample are retained under `centi-review/` without overwriting earlier evidence. Draft/release limitations for ordinary CLI creation/editing and other CLI/platform adapters remain.
# 同じ会話の変更完了後の整合

3525a28の世代保護だけでは、pause完了前のrefreshが同じthreadのactiveを読んだ場合に、その後confirmed/pausedになっても表示がactiveのまま残った（PR79-CENTI-2）。別threadの旧応答拒否は保持し、所有を失った変更が完了した時、現在表示中のsession/launch/threadが変更開始時と同じ場合だけ、そのmemberを新しい世代でGETする。POSTの再送はしない。別threadへ切替済みなら旧応答を適用しない。新しい取得も後続のrefreshに追い越されたら適用しない。

新しいDOM回帰は、同bindingの完了後paused表示、完了後GET中の新thread切替、GET失敗時の未確認表示とpending解放を追加。元の別thread保護/別member応答順を含め8件成功。最終 `TESTGATE_FULL=1 npm test` は771 pass、fail/cancelled/skipped 0。原本は担当側 `integrations/goals-composer-20261025/goal-full-reconcile.log`。これは人工APIと実表示moduleの応答順確認であり、native CLIの追加受入ではない。
