# 直接メッセージの受領入口

Owner公開契約は2026-11-06の「耐久受領とAI実行を分ける」。共通MCP/HTTP・親接続はMolly、保存/履歴はN102、AI引渡しはKiro、ready/寿命はEpi。

| 共通機能 | 入力→出力 | 保持する失敗境界 |
| --- | --- | --- |
| MCP直接送信入口 | 閉引数・fresh送信者・解決済宛先/添付→既deliverMessage | sendmessage/send_user_messageは不要なRoom一覧を取得しない。registry/本人/宛先/画像の検証は保持 |
| その他のMCP/Room操作 | 既fresh registry/Room→各担当窓口 | 既room認可/取得/失敗は変更しない |
| 耐久受領→AI | 同IDの保存結果→受領返却、未入力だけ通常ready後一回進行 | N102/Kiro/Epiの受領保存・pending・unknown非再送sourceが別途必要。Room一覧回避だけを保存/実行の成功にしない |

データフロー：`MCP→閉引数→registry.refresh→送信者存在→直接2toolは既target/画像解決→deliverMessage→耐久受領結果`。その他toolは従来のRoom refreshを経由する。`保存済同ID→受信待ち→通常ready→未入力一回の実receipt`は各所有者sourceを通して結合する。保存失敗・認可不成立・元入力unknownは成功や再送へ変えない。

本差分で受領返却型・保存schema・native再送/本番は変更しない。直接検証はRoom取得が拒否されても合法直接送信が既配送口へ一回届き、送信者不在は拒否される一接点。

## 緊急新規入力の接続

Root限定割当の実行3接点は[通常配送と未確認記録の分離](../execution/configuration-delivery.md)を正本とする。Owner通常チャット/peer→既保存→通常notify/turn→既現AI入力を、旧追跡不明だけで拒否しない。N102の唯一親writer/queued受領の組立は別の後続差分であり、この修理を待たせない。

## 親の唯一writerと通常再開（実装前設計）

| 親機能 | 接続・所有・失敗 |
| --- | --- |
| 一実体 | application-servicesがN102 DurableMessageReceiptsを一回生成し、conversationPorts.directReceiptsへ同参照を供給。子direct.log.appendは同writerへ。Roomは既所有 |
| 認可 | assemblyの現在の認証actorを純粋な既method/入力検証で捕捉。Bot送信者・usage/onboarding targetを保持。子admission/AI有効を受領の条件にしない。executionSourceは登録済親contextだけ、本文由来は採用しない |
| 添付 | assemblyの既asset gateを共有。親saveはmembersだけの短命contextで同gateへ入り、子writer/admissionを予約しない。削除は同gateが親/子の実save終端を待つ |
| 新受領 | 公開MCP/HTTP user/peer/Bridge→安定親receive→queued+fsync→queued返却。recordUser=falseは既onboarding専用経路。履歴read/旧制御/Roomは既facade |
| 実入力 | 同queued IDを耐久claim→fresh本人/明示AI許可→既transport turn/notify→実accepted。同callbacksは親writerへ保存、Owner実replyも保存。Bridge session/event/seq/hint保持。実入力前の既拒否だけnot_started、native例外はunknownを保持 |
| 通常再開 | onPending・conversation/executionのrunningavailable・AiControl保存後enabledが同nonblocking要求へ。mutex解放後にfresh execution ready/AI許可/closedを確認。会話の追跡不明だけを新規入力gateにしない。組立完了後初回一回。queued-not_started自己再試行/新timer/AIpoll無し |
| 終了 | drain要求のclosed化・AI購読解除→既起動失敗/通常close。元job/native/watch/callbackを付替えない |

DFD: `認証済actor→純粋な既認可→親一実体receive→同asset gate→同JSONL queued/fsync→同ID受領`。`onPending/既runningavailable/AI enabled→nonblocking request→exchangeMutex.waitForIdle→fresh execution/AI→同ID queued claim→fresh本人→通常transport→実callback/Owner返答→同writer→既履歴watch/通知`。`旧legacy/unknown/dispatching→保持`、`保存失敗→受領拒否/native0`、`明示not_started→queued保持・次の外部通常eventまで自己loop無し`。

N102 b0602e18の6case/35.790054msを継承。親の新規接続だけを追加検証し、全作者内部群は再走しない。本sourceを現用無停止採用の証明にしない。

正式conversation archiveは新effectsのliteral依存direct-log-record.mjsをpackagerの実closureへ含める。旧archiveの既56必須inventoryへ新依存を遡及追加しない。新親sourceと新conversationを同適用単位とし、旧親へdirect.log.append依存の新子を単品promotionしない。親新writerのJSONL watchを既履歴SSEへ接続し、子通知が無い親保存も表示へ届く。

親受領の入力検証は既requestsの純粋な入力部分を公開して再利用する。親受領のために偽のgeneration/operation/leaseを作らない。既IPC要求は元context検証を保持した上で同入力検証を呼ぶ。

新しい直接配送のonTurnEndも既TurnReportsへ接続する。親側の同保存store/transport/既routing設定を使い、元会話子のcallback/Room報告は付替えない。既報告確認は受領ACKを待たせず、新pollを足さない。

## 新conversation資材の閉inventory受入

59dのpackager実閉包importは通ったが、正式write_archiveの許可集合に新direct-log-record.mjsが含まれず、conversation42147177815は署名前に拒否された。既56必須を維持したまま、許可する追加sourceをこの一fileだけに限定する。DFDは `packager既56+literal1→閉manifest許可56又は57＋依存node_modules→write_archive/check_archive→署名`。旧56archiveの互換と未知source拒否を保持。fresh421dのbootstrap/sidecarは別単位で、この修理を追加gateにしない。


## Non-interrupting direct-writer handoff

| Function | Ownership and ordering | Failure boundary |
| --- | --- | --- |
| forwardConversationWriter | Keep the existing child writer object/onMessage and replace only its append entry. Capture its old appendQueue, enqueue subsequent records behind it, then forward every record to the registered parent single writer. | Invalid writer/forward callback changes nothing. A forwarded append failure rejects that call; the queue remains usable, as before. |
| ready | Resolve only after every pre-handoff local append has finished. Parent receipt intake/claim must remain disabled until this exact ready settles and the parent effect is registered. New child writes may wait on that IO barrier; native AI/job/callback ownership is not paused or replaced. | A rejected old queue prevents a successful handoff ACK. Never infer readiness from loaded source. |
| Child notification | After the parent append succeeds, call the same child's onMessage once, preserving its actor/operation async context. Parent appendFromChild suppresses duplicate parent notification. | Original save/notification failures are not swallowed into receipt success. |

DFD: existing child appendQueue -> captured old-write barrier -> same child append entry -> parent direct.log.append validation -> sole parent DurableMessageReceipts appendQueue -> original child onMessage. After the old-write barrier ACK, authenticated new input may use the existing completed parent receipt/claim/normal-ready assembly. Unknown/legacy IDs remain excluded. This source seam does not install the missing live421d parent effect-validator acceptance or ready subscription by itself; Epi's fixed runtime adoption must supply those exact contacts first. No whole-parent exchange or AI quiescence is the default.


## Exact not-started proof and failure-field connection

| Connection | Accepted data and ownership | Failure |
| --- | --- | --- |
| Runtime → conversation error frame | Existing code/outcome/status plus only closed sanitized callback failure fields. Preserve the exact normalInputPending v1 proof only with BOT_SESSION_UNCONFIRMED/effect=not_started, closed field set, exact stage/reason and typed delivery/bot/session/launch IDs. | Invalid proof does not become not_started; raw messages/stack/arbitrary causes/credentials are not added to the wire. Both channel endpoints must support this source. |
| Parent receipt → runtime | Before runtime invocation, existing local member/access preflight can prove not_started. After invocation, only the typed proof matching this receipt's deliveryId and target may leave it queued. | Code alone, wrong ID/target, unknown observation, or missing proof becomes unknown and is never replayed. |
| Normal ready | Reuse the completed nonblocking requestDrain/mutex/AI-enabled/current-execution readiness path. A queued proof waits for a new external ready request, without a self-retry loop. | Do not use this full-consumer source as the standalone421d profile; Epi's independent wake-only profile retains the old startup behavior. |

DFD: new saved ID → durable dispatching claim → runtime pre-registration observation → exact bound pending proof → error-frame closed validation → same parent receipt queued → later ordinary ready → same-ID claim once. Native/legacy unknown remains retained. Existing sanitized mcp_error/native_launch flows through both error-frame hops and the existing callback writer instead of being dropped; historical missing fields are not reconstructed. This is source connection work, not a new diagnostic API or a prerequisite for Epi's standalone runtime adoption.
