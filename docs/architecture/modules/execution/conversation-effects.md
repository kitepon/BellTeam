# 会話childからexecutionへの親固定adapter

```mermaid
flowchart LR
  IPC["会話channel: 原authority/operationを保持"] --> Effect["固定onExecution adapter"]
  IPC --> Gate["登録済conversationDelivery・callback/背景実ACK"]
  Effect --> Native["同transport notify/turn/notifyReport"]
  Native --> Gate
  Gate --> Callback["元controller.callback・同delivery"]
  Effect --> Recovery["原delivery/launch/operationへ束縛したrecoveryId/closureId"]
  Gate --> Done["operationCompletion: 元record.done"]
  Done --> Clean["親authority/ALS掃除・未消費handle破棄"]
```

`createConversationExecutionEffects({getServices,getController,admission})`は親だけの固定onExecution関数を返す。親channelが型/actor/元authority/許可対象を検査し、登録した同conversationDeliveryとenriched contextを渡す。adapterは新規登録・native claim・通常finish・callback/背景予約を再実装せず、同opaqueを既Transportへ渡す。元admissionCheckとoperationContext/conversationLease/capturedAuthority（供給時）/actualCompletionは同identity。fresh member await後にも元check/current stop/同leaseを再確認し、native直前のguardは既Transport/Clientが同関数で行う。

notify/turn/reportは固定公開口のみ。turnはnative受付Promiseだけをeffectへ返し、reply/user.complete保存/実ACKは既gateとTransportが保持する。callbackは登録時の元controller channelが発行し、adapterで上書きしない。execution.background.begin/endは既conversation-ipcが消費するため、このadapterへの直接到達は拒否する。observation.source/shownは親channelの許可済observer operationに限定する。

不足報告は元conversationLease/operationContext/delivery/actualCompletionを保持し、元members leaseが既に終了していても新しい通常members入場を一回だけ行う。同親`transport.membersAdmission.withLease`で短命leaseを取得し、fresh `bots.readMember(id,{membersLease})`と`notifyReport`のoptions.membersLeaseへ渡す。元operationContextのmembersLeaseを書き換えず、会話の新root・予約・authorityを生成しない。withLeaseはnotifyReportのaccepted返却まで、Transportは既admissionCompletionを同leaseへnative前に登録するため、準備/受付失敗cleanupは保持しAI/callback完走まで不要にmembers8枠を占有しない。members閉鎖・本人削除・元stop checkの拒否はそのまま返し、resume後に自動再発行しない。通常notify/turnは既元contextのmembers leaseを維持する。

reconcileは既deliveryExecutionRefとtransport.reconcileLaunchを使い、実execution objectを親に保持して同operation/target/deliveryのrecoveryIdを一回notifyへ消費する。closeLaunchも元公開検証を使い、子にはclosureIdだけ返す。親最終HTTPは固定`effect.consumeClosure(closureId,operationContext)`で同operationの元生receiptを一回取り出す。未知/別operation/再利用を拒否し、元要求やreceiptを形から再作成しない。shown handleも元object/取得prefixに束縛し、古いhandleで新watchを消費しない。

`ConversationLifetimes.operationCompletion(lease)`はliveなoperationだけから同private record.done Promiseを返す。delivery done/親release ACK/backgroundが実終端しfinish済みになった後だけ親authorityを解放する。RPC完了/別deferredで置換しない。

親IPCのonExecution前処理拒否には`finishUnclaimedDelivery(同opaque)`をcatchで使用する。登録済かつnative claim前の陽性だけ一回finishし、claimed/終端済みはfalse。Transport到達後のunknownを未発行へ変更せず、通常native claim/finishはTransport一回のまま。

application-services/ALS/authority/ledgerはMolly所有。新wire/保存schema/任意method・Proxy/SDK操作は作らない。

## 同imageの実AppRuntimeで使う寿命検査helper

`test/helpers/conversation-execution-lifetime.mjs:createConversationExecutionLifetimeFixture({botId})`は同期で`client/createExecutionAssembly/attach/hold/snapshot/close`を返す。外側Centiが実createApplicationRuntimeにtop-level `client:f.client`、bootstrapに`createExecutionAssembly:f.createExecutionAssembly`を渡す。bootstrap.clientだけではruntimeの明示client引数に上書きされる。wrapperは実createExecutionAssemblyへ委譲し、既ports.seat.waitProcess/handoffContextだけを人工化する。同親members/conversation/moduleOperationsと全その他optionsを保持する。実会話Assembly/default createProcess、loader、署名、controller.replaceは差し替えない。

```mermaid
flowchart LR
  Outer["Centi: 実AppRuntime / C / 署名 / replace / cleanup"] --> Attach["helper.attach(runtime) / 同port・同gateを検査"]
  Attach --> RPC["assembly.run(owner) → 実user.turn RPC"]
  RPC --> AI["ai: native受付後waitProcess実Promiseを保留"]
  RPC --> ACK["callback: 実watch eventの保存後ACKを保留"]
  RPC --> Report["report: 空回答 → 非awaitbackground → 同元operationの派生nativeを保留"]
  AI --> Busy["外側: 実60秒busy / 旧resume / 新子0"]
  ACK --> Busy
  Report --> Busy
  Busy --> Done["handle.release: root結果・Transport idle・同operationCompletionまで待つ"]
  Done --> Exchange["外側: 全3hold終端後の実交換・builtin復元 / 最新state保持"]
```

AppRuntime構築後の`attach(runtime)`は実execution返却実体、native client、conversationAdmission/moduleOperationsの同identityを確認する。`await hold('ai'|'callback'|'report')`は対象rootの受付と各保留点到達まで待ち、snapshot/assertResumed/releaseのhandleを返す。native発行時は実元currentOperationを捕捉し、reportでは同object/会話leaseを確認する（元operationContextの古いmembers leaseは再利用しない）。callbackは受理済みrootのdelivery-status変更通知を同assembly.watchで待ち、native完了後も実callback/event ACKを保留する。reportは空transcriptから実missing判定を通し、元RPC結果/実completionが返った後も同元operationが派生deliveryを保持していることを要求する。

外側がcontroller.replaceを実時間で実行してbusy/旧resumeを確認した後、`handle.assertResumed()`は同generation/running/availableと未終端operation、abort/stop/本文再送0を検査する。helper自身はreplace/admission.close/reserveを呼ばず、60秒経過や新子0の代替証明を作らない。`await handle.release()`は保留native/eventを解放し、元root結果→全同Bot配送idle→捕捉済み同admission.operationCompletionまで待つ。bool/整数だけのsnapshotにnative呼出/待機/終端/abort/stop/launch/SDKclose/PTYclose/本文再送を返す。closeは保留を解放してwatchを外し、runtimeや外側data/Cを閉じない。

N102 preservationの固定timeline検査は先に終え、寿命phaseの人工AI追記と混ぜない。同rootで追加した最新記録のbytes/mode/mtime保持、同image/C/署名/既定loader/実60秒/旧新OS終端/cleanupは外側の成立範囲。新直接検査は実AppRuntime/実Assembly/実IPC/実executionを使い、ローカルだけloaderの明示I/OとNode子のroot引数を人工化する。ai/callbackの局所timer進行とreportの実時間60秒を区別し、C/UID1001/署名/image成功へ補完しない。新report準備の3反例は期限切れ元membersからの通常新入場、members閉鎖時の再発行0、fresh await後stop拒否とlease解放を確認する。
