# 親安定の耐久受領と保存済ID

Root公開契約2026-11-06、親接続Molly・実入力Kiro・ready Epi。会話保存N102。

## 機能図

| 機能/実体 | 入力→出力・状態所有 | 失敗 |
| --- | --- | --- |
| DurableMessageReceipts（親に一実体） | 認証済入口のfrom/target/message/images→同配送IDの既direct-message、delivery=queued。user宛はdelivered。既Store/Assets/Writerを使用 | fresh送信者/宛先・入力・認可・添付保存は維持。AI/子admissionを受領条件にしない。fsync成功前は受領0 |
| 同実体append | 全直接記録を同Writerのqueueへ直列化。子はdirect.log.append effectで同窓口へ、Roomは既writer | 子effectは既世代/authority/実終端検査を保持。新旧子のwriterは作らない |
| pending / dispatchSaved / drain | durable受領済queuedだけ列挙、同ID dispatchingを保存後Kiro dispatchへ一回渡す | dispatching/unknown/running等は再入力0。明示effect=not_startedだけqueued。保存失敗ならnative0 |
| Kiro dispatch注入 | {record,images,queue,callbacks}→既queue実receipt。queue.groupId=元delivery_id | 実入力とbusy/旧unknown/claimはKiro所有。全自由例外は保存せず状態だけ |
| Epi通常ready / 初回受領onPending | pending drainを起動 | timer/常駐/AI巡回0。通常イベント接続は親が実施 |

## データフロー図

認証済MCP/HTTP/Bridge → 親安定receive → fresh registry/本人/宛先/閉入力/既認可 → 既Assets保存 → 同ID direct JSONL queued + file/directory fsync → 受領{delivery:'queued',delivery_id,from,target}。
保存後のonPendingは実行待ちの通知だけ。実行/通知失敗を受領失敗へ変換しない。通知の失敗は診断callbackへ渡す。

同ID queued → ready/drain → 同ID dispatchingの耐久claim → Kiro既queue/実native → 実callback保存 → 履歴/SSE。明示not_started → queued、作用不明 → unknown。再起動してdispatchingだけ残る場合もunknown相当で自動再入力0。元legacy running/failed/unknownはpendingに含めない。

既子 direct append → direct.log.append（既registered effect/lease）→ 同親append → 保存ACK → 子の既emit一回。子はdirect JSONLへ書かない。親の既direct log writer一個をMollyが組み立てgetServices.directReceiptsへ供給する。新口未接続はCONVERSATION_EFFECT_UNAVAILABLEで拒否しローカル第二writerへ退避しない。

添付は同ID image_assetsに保存し、実行時に既assets.directory(owner)/fileを使う。user回答所有とBridgeの元session/event/seqは同ID recordに保持し、実行consumerへ渡す。recordUser=falseのonboardingはこの受領口へ無断で変換せず既経路。旧callback/native実参照の付替え0。

## exact接続契約

`DurableMessageReceipts({root,bots,assets,dispatch,onPending?,onMessage?,onError?,requireAccess?})`。`requireAccess({from,target})`は認証/操作資格だけを確認し、AI enabled/child admissionを呼ばない。onMessageは親の新受領/実行だけを通知する。子effectはappendFromChildで同writerに保存し、親の通知を省いて子の既emitを一回行う。親の同実体を`getServices().directReceipts`に入れる。既子初期化は直接writerを作らず同effectへ委譲する。

- `receive`/`sendmessage({from,target,message,image?,images?,executionSource?},{membersLease?})`、`enqueueUserTurn({target,message,images?,recordUser?})`、`receiveCallBridge(既Bridge閉入力)` → `{delivery:'queued'|'delivered',delivery_id,from,target}`。queuedは保存受領のみ、runningは捏造しない。recordUser=falseは既専用経路を維持する。
- `pending() → 保存済record[]`、`dispatchSaved(deliveryId) → {delivery_id,delivery,dispatched}`、`drain() → 同結果[]`。StoreのdurableReceiptsはLF確定行だけ、不正ログ/重複IDは実行根拠にしない。
- `dispatch({record,images,queue,callbacks}) → Promise<{delivery:'running'|'steered'|'delivered'}>`。queueは既context/contextId/groupId/from/fromName/target/message（Bridgeはcallも）で元IDを維持。callbacksはonStatus/onInterim/onAnswer/onTurnEnd/onUserComplete。Kiroが元recordのfrom=userならturn、Bridgeなら元session/hintを含むnotifyへ接続する。明示effect=not_started例外だけ再開可能。それ以外unknown。入力済trackingを持つcallback後は再開しない。
- assetsは既`saveAll`/`directory`を使う同親実体。受領前に保存asset本体/asset directoryもfsyncし、再開は永続pathだけを使う。

閉wire enumへqueuedを追加する共通MCP/HTTP返却はMolly担当。これをrunningへ写像しない。通常ready→drainのイベント接続も親担当。本source単体を親接続完了へ補完しない。

既executionSourceは親だけの一時参照としてdispatchへ渡し、本文JSONLへ保存しない。process再生成後に元authorityを捏造して復元しない。入力済callback後の実delivered/failed追跡は後着例外でqueued/unknownへ上書きしない。

親認可・同asset gate・実dispatcher・通常再開・closeの正本は[integration/message-receipt.md](../integration/message-receipt.md)を参照。親callbacksは同writerへ直接保存するため、会話child追跡不明だけで新規AI入力を待たせない。
