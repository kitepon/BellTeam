# host内のexecution engine交換

```mermaid
flowchart LR
  Caller["HTTP / MCP / scheduler / conversation"] --> Facade["親の安定facade・固定method表"]
  Facade --> Engine["署名bundleの createExecutionDispatcher"]
  Engine --> Transport["新版Transport / SessionState / Job / CurrentWork"]
  Engine --> Admin["新版Administration / ConfigurationRequests / Goals"]
  Engine --> Producer["新版SeatTurns / IdleSessions / continuation"]
  Transport --> Live["親live SDK / gates / 保存ACK / observer ports"]
  Admin --> Live
  Producer --> Live
  Engine --> Drain["root閉鎖→実終端→volatile export→retire"]
  Drain --> Next["別bundleの新factory / 同live ports"]
```

entryは`src/execution-dispatcher.mjs:createExecutionDispatcher({generation,ports,handoff})`。相対importのTransport/Admin/ConfigRequests/Goals/observer/Job/stateと依存全体を同じ署名bundleへ封入する。旧engineを返すport、任意method RPC、外部から与えるbusiness factoryはない。親SDK/nativePTYは共有のままcloseしない。

portsの閉集合は`native`（既AitermClient機械口）、`membersAdmission`、`conversationAdmission`、`bots`/`rooms`（既公開writer）、`configurationStorage`（親が取得したroot/trustedAnchor/必要時ownerUidだけ、保存検査writerは新bundle内で生成）、`access`（assertWorkAllowed/admitWork/requireMember/requireAccess）、`storage`（prepareStartup/updateSession/updateFastMode）、`seat`（既waitProcess/handoffContext/画像一時file）、`observer`（appendInterimWords/emitQueue/report）、`diagnostics`（record/goalError）、`continuation`（models/harnessAuth/messenger）。関数/opaqueはhostだけ、child DTOにはしない。

`dispatch({method,args})`は固定method表のみ、引数は既callerのhost値。同期getterは`project({method,args})`を安定facadeへ射影しPromise化しない。`.transport/.administration/.goals`に対応する実method名一覧を`EXECUTION_METHODS`で公開する。parent consumerは旧Transport参照を保存せず毎回現世代へ転送し、`.client/.membersAdmission`は共有機械portを親から別に注入する。watchQueue listenerは親の安定observerへ置く。新規listenerも交換対象engineの旧callbackを生かす経路にはしない。

`control(initialize)`でrestore後にrunning、`resume`で旧世代を再開、`quiesce`で同期root閉鎖し60秒actual drain、`exit`/`disconnect`で退役する。quiesce中は既watch終了用pollだけ残し新watchを始めない。idle producerは止める。caller timeoutはnative/Job/ACKをreleaseしない。長AI/観測不明はbusy、resumeで旧engineだけ再開し新engine0、AIabort0。retireは実zeroを再検査し全timer/listenerを止め、旧projection/captured callback/native口は世代失効。SDKclose/ptycloseはしない。

handoffはhost内volatile、同schema互換のみ。sessions/stopVersions/stopSessions/uncertainty identity、原pending/latest/rejectedPreparationsの同object graph、Administration applications、CurrentWork records/seq、followedTurns/shownWords、idle metadata、continuation finite budgetを引き継ぐ。Promise/SDK/client/本文のJSON化はしない。shownWordsは親が既に扱うopaque参照のvolatile移管で、本文再送の権限を作らない。export前は実operation0、未終端をstate化しない。CurrentWork timerはmetadataを消さず停止し新版で再開。原stage欠測を補わない。

未initializeのcreatedとinitialize失敗のfailed candidateは、公開disconnect/exitで実pending0を再検査して破棄できる。initialize本体の実Promiseが未終端ならbusyで保持し、caller timeoutで解放しない。cleanup開始と同stackでdiscardingへ進め、同時initialize/旧callbackの再入場を拒否し、timer/listener停止後にだけclosedを返す。running候補の破棄には従来どおりquiesceが必要。これで失敗candidateのclosed後だけ旧bundle再生成が可能で、closed欠測時の旧再生成は不可。

`test/execution-bundle-handoff.test.mjs`は別々の人工source rootからentryと相対engineをimportし、Administration実dependencyの変更が同期投影へ出ること、stop/uncertainty引渡し、初期化失敗candidateのclosed後に旧bundleを再生成できることを公開口だけで検査する。外部nativeはpty_listだけの人工port、署名/配置/loader/HTTP/main/imageの実証には使わない。fixture本文変更は一時source内だけで製品業務コードには入らない。


## 固有generation/controllerと親保存ACK

Epiから正式handoffした`src/execution-generation.mjs:createExecutionGeneration`がhost内の固有transactionを所有する。共通child controllerを複製しない。`loadFactory(versionId=null,{expectedRelease})`へbuiltin/SHAだけを渡し、runtime読取口のfrozen `{versionId,sourceCommit,createExecutionDispatcher}`だけで新engineを生成する。任意URL/import/外部business factory選択はHTTPへ出さない。reader比較用に`EXECUTION_STATE_COMPATIBILITY`を旧実値のままexportする。

親Mollyは同一ports、初期currentVersionId/previousVersionIdと既保存writerへの`onAdopt({currentVersionId,previousVersionId})`を注入する。onAdoptは実durable completion（`.completion`があればそれも）を含み、ACK前は新rootを開かない。別保存schema/writer無し。公開は`start/replace/reserve/snapshot/dispatch/project/close`。reserveはstart一回とcancel、実completionを持つ。projectは同期のまま常に現instanceへ転送する。親のtransport.client/membersAdmission/requestStopはliveportsのまま保持し、queue listenerは親observerへ。旧外側SeatTurns/IdleSessionsを別生成して二重producerにせず、factoryが一実体を持つ。

```mermaid
flowchart TD
  Load["runtime検証済factory取得"] --> Close["新root閉鎖・旧実operation drain60s"]
  Close -->|busy| Resume["旧resume5s・候補生成0"]
  Close --> Export["旧export→retire"]
  Export --> Init["新engine initialize"]
  Init --> Save["親onAdoptの実ACK"]
  Save --> Running["現世代へ同期projection/dispatch"]
  Init -->|失敗| Cleanup["candidate closed実確認"]
  Cleanup -->|未確認| Unavailable["unavailable・新root0・二重engine0"]
  Cleanup --> Restore["同旧factory＋handoff再生成"]
  Restore --> OldSave["旧current/previousの親保存ACK"]
  OldSave -->|成功| Running
  OldSave -->|不明| Unavailable
```

旧instanceは退役後resumeしない。初期化/保存待ちcallerの期限は実資源を解放しない。candidateのhandle/closed欠測、復元失敗/保存ACK不明はunavailable。close途中の遅いfactory読込から未来のengineを生成しない。SDK/nativePTYclose/AIabort/本文再送は行わない。共通readerの署名・設置と親のstable facade/ledger組立、通常main/imageは各本人の実接続結果を要する。

## 固有legacy caller facade

Mollyが未編集の薄いcaller adapterを正式handoffし、`src/execution-facade.mjs:createExecutionFacade({getController,client,membersAdmission,requestStop,watchQueue})`をexecution所有に追加。返却transport/administration/goalsは固定EXECUTION_METHODS表だけで組立て、同期projectとdispatchを区別し、呼ぶたびにgetControllerで現在を取得する。汎用Proxy/property/method転送無し。argument/options/opaqueと返却Promiseの`.completion`を同identityで維持しJSON化しない。client/gate/requestStop/watchQueueは親liveportsの同object。legacy transport.closeはcontroller.closeだけを呼び、SDKを閉じない。

Mollyはapplication-services/runtimeの親組立を所有したまま、旧外側SeatTurns/IdleSessionsを別生成しない。start/closeはengine/controller一実体に接続し、会話所有SelfTurnsは別に維持する。既BotGoals/Administrationもfacade側へ置換し旧業務engineを親に残さない。アプリ全終了時の共有SDK closeは親機械resourceの責任で、module closeへ混ぜない。onAdoptの既private保存、inventory/ledger/catalog、bootstrapの順序と同source初回image導入も親所有のまま。

`test/execution-loader-generation.test.mjs`はEpi reader選択の実実装→固有generation→安定facade→別sourceの実Administration engine→親atomic採用保存ACK→builtin戻しの一接点を検査する。runtimeの明示I/O test portsだけを人工identity/installed descriptor/import mappingへ置換するため、実root receipt/署名/inventory/本番imageの受入ではない。未導入usage/diagnosticsの読取依存はEpi07b99fがcomponent選択時だけ解決し、executionを他module導入待ちにしない。
