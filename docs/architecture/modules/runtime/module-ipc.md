# 共通の有限IPCとstream

所有エピネル。既membersの低層endpointを`src/module-ipc.mjs`へ移し、業務context/DTO/actor/readyは各module固有adapterが注入する。membersは従来status集合・エラーprefixとstream無しを維持し、read pinを含む公開意味を変えない。

`createModuleEndpoint(endpoint,{validateResult,onRequest,onDisconnect,afterResponse,afterResult?,streamed=false,errorPrefix='MODULE',statusCodes?})`はcall/pending/counts/running/send/fail/reaped/close/snapshotを返す。call(kind,method,params,context,{timeout=60000,beforeSend})のPromiseは実終端`.completion`を持つ。kind別root/effect/callback64（共通MODULE_CONCURRENCY）、projection1、その他16、body16MiB/envelope64KiB/業務buffer64MiB/control1MiB、ACK5秒、caller deadline60秒を保持する。期限/断線はpending completionを解放しない。reapedはOS/pipeと親effectの実終端を確認したcontrollerだけが呼ぶ。

`afterResult(task,value)`がPromiseを返すとmetadataをcallerへ返した後も、そのPromiseが終わるまでroot credit/実completionを保持する。大list/private snapshotの実読取・反映ACKをここへ結び、metadata ACKだけで次世代へ移らない。taskはid/kind/method/context、beforeSendで同期に登録できる。afterResponse(message,value)は返信の送信後で、exit→disconnectはここから行う。

`drainIncoming()`は受信済parent effect/callbackとafterResultの実commitを待つ。子のOS/pipe終了後も親保存が残る場合があるため、固有parent channelはこの関数を公開し、controllerはその終端後だけreapedを呼ぶ。切断後にreapedを待つoutgoing credit自体は含めず、循環を作らない。

streamed:trueのendpointは既open/data/credit/end/closed/abort/rejected/controlを同channelのstream機構へ渡し、`createModuleStreams(...,{rpcFrames:true})`はcall/accepted/resultをRPCへ渡す。未知frameは拒否する。`module-streams.mjs`は既conversation実装の共通移管で、256KiB/4credit/8stream（4はcallback/continuation予約）、履歴は同snapshot AsyncIterableの逐次JSON。既conversation-streamsは再exportだけにし同じ契約を参照する。履歴laneの総量制限無しは既意味を保ち、他body96MiB+64KiBを緩和しない。

新moduleの固定error code/outcome/statusだけをwireへ出し、statusは整数400..599。自由message/stackを送らない。legacy membersだけstatusCodes=[400,403,404,409,503]を明示し既型を保持する。Root再採否や既業務成功群の再走は加えず、新stream共存/実body終端/status保持と変更したmembers低層の境界だけを検証する。

Owner PR319により親admission・親子root/effect/callback（会話event含む）はMODULE_CONCURRENCY=64を共有する。projection1/control・diagnostic16とstream通常4/全8は別の予約予算。業務buffer64MiBは未送信・dispatch待ちframeの予算であり、稼働中64処理の総RSS上限ではない。
