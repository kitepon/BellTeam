# 通常の新規配送と未確認記録の分離

常設所有はキロ。2026-11-06 Root裁定によりモリーが新規submitのoccupation拒否、conversationDelivery無しcallback拒否、requireDeliveryKnownの配送転用だけ緊急修理する。

| 機能 | 入出力・保持する境界 |
| --- | --- |
| 新規Owner/peer入力 | 既submit→認可/本人/停止/通常native確認→同新規入力一回。旧jobの世代/unknown・session変更の未確認記録だけで拒否しない |
| callback | conversationDeliveryありは既同opaqueとcallback所有を厳守。無しは親callerの通常callbackを通す |
| 旧job/観測/継続 | 旧unknown/退役記録を保持。旧assertConversationOccupationはwatch/旧継続用に保持し、本文の複製再入力はしない |
| session変更 | requireSessionKnown/configurationFenceを保持。新規配送可能をwake/restart/reconfigure/close成功へ補完しない |
| 明示停止・認可 | stop version/全体停止/本人/lease/アクセス拒否を保持 |

DFD: `新規Owner/peer→submit→設定操作の終端順序→通常認可/stop/本人→dispatchInOrder→既sessionへのpty_send一回→実accepted/実completion`。`旧unknown/世代/変更不明→元記録保持`は新規入力の拒否へ接続しない。`明示session変更→requireSessionKnown→既変更`と`旧watch/継続→occupation guard`は別のまま。

ensureは既session実在なら通常配送を続け、席不在のwakeはstrict。memberOperation/awaitUnboundAdmissionは本人・lease・停止世代を保持。新規dispatchにも認可・停止検査を渡す。保存失敗の偽受領や例外の握り潰しは追加しない。

最小検証は既未確認jobとsession変更記録を保持した新規Owner/peer一回入力、通常callback、明示停止/認可と変更操作の拒否。実席適用は別判定で、AI停止/restart/quietを本修理の手段にしない。


## Temporary runtime-owned normal-ready contact (2026-11-06)

Root temporarily delegates only the normal-input session-uncertainty caller to Epinel. Kiro retains permanent ownership. The seven-method adoption and live reply are inherited results, not retested.

| Function/state owner | Input and flow | Required distinction |
| --- | --- | --- |
| New normal delivery | fresh native observation -> existing ready session -> one new send | an old configuration result cannot reject an otherwise usable session |
| Absent-session recovery | observed absent -> wake -> guarded launch/changeSession | retain the old launch/close uncertainty; do not assert a model change succeeded |
| Parent saved input | same newly saved, definitely unsent ID -> existing normal-ready event -> one dispatch | parent writer/receiver belongs to Molly; no new timer, daemon or AI poll |

DFD: `new input -> normal access/stop/member checks -> fresh target readiness -> reuse existing session OR required guarded startup`. `old configuration/launch uncertainty -> original records` remains observational for send, and strict for a change that can collide with a late old operation. The current reported failure contains only BOT_SESSION_UNCONFIRMED, so the uncertainty cause and observed exists/ready contact must be supplied before choosing the startup correction. A missing normal-ready resume port is a concrete connection gap, not a claim that an uninstalled port is live.


### Conditional ready reuse and pre-registration pending (Root decision, 12:40 JST)

| Runtime function | Data flow / owner | Failure boundary |
| --- | --- | --- |
| submit, before reserveExecution | New job + captured stop/member checks -> fresh pty_observe when local session uncertainty exists -> exact current session and valid launch; busy/idle with pane_alive/harness_alive true permits the ordinary native reservation/send | Absent/unready returns normalInputPending only before this job has any native reservation or input. Invalid observation/session change remains unknown, not pending. The parent receives this local typed receipt through the normal rejection callback. |
| wake | Member/access/stop checks -> fresh matching ready observation before requireSessionKnown -> reuse that existing session; a bound request additionally requires the same non-null expected launch | Unready/absent still reaches the strict mutation guard. An expected-null reservation cannot adopt a newly appeared launch. No launch/close/configuration record is cleared. |
| parent durable receiver (Molly) | Same newly saved ID + typed pre-registration receipt -> parent-owned pending/claim -> normal-ready wake -> fresh normal dispatch once | A failed log row or BOT_SESSION_UNCONFIRMED alone is not proof. No old unknown input or previously registered request is replayed. This parent port is not live421d yet. |

DFD: new delivery -> submit checks -> observation (only for retained session uncertainty) -> ready identity -> ordinary reserveExecution -> native send; absent/unready -> locally proven pre-registration pending -> parent's sole durable writer -> normal-ready one-time claim. Explicit restart/reconfigure/close/changeSession keep their existing guards. Requested model/CLI values and uncertainty records remain unchanged. The pending receipt describes this new attempt only: schema, deliveryId, botId, sessionId, launchId, reason, effect=not_started, stage=before_execution_registration. It never reports that old configuration applied.

Selective runtime adoption must include the updated submit and wake public descriptors; their code uses existing instance fields and cached imports. No constructor/instance/callback replacement or new module export is needed. Native registration performs its existing fresh identity check after the preflight; a race there remains its original result, never an automatic retry.
