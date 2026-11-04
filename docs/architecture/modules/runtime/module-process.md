# 固有channelを載せる共通child世代controller

runtimeエピネル。既members交換手順の共通機構を`src/module-process.mjs`へ接続し、conversation/usage/diagnosticsの固定3componentだけを扱う。業務DTO/actor/opaque lease/stream/投影ACKは各作者のclosed channel、親facade/実サービス組立はMolly、固定資材と署名はCenti。先行members/通知controllerをこの変更で置換しない。

```mermaid
flowchart LR
  Caller[親安定facade / 固有authority] --> Channel[固有ParentChannel / 実completion]
  Controller[createModuleProcess] --> Channel
  Mutex[親の共有exchangeMutex.runExclusive] --> Prepare
  Prepare[固定prepareRelease / catalogと互換検証] --> Closed[新受付閉鎖 / 既lease継続だけ]
  Closed --> Drain[実completion＋外部admission drain / 60秒]
  Drain --> Quiesce[child quiesce / 保存・stream・callback終端]
  Quiesce --> Handoff[固有private export / 必要moduleだけ]
  Handoff --> Exit[exit / OS・IPC・pipe全close]
  Exit --> Launch[固定C / advanced IPC / 新generation]
  Launch --> Init[initializeParams / restore・投影ACK / ready45秒]
  Init --> Record[private adoption / 同stateデータ維持]
  Record --> Resume[resume ACK / 親新受付公開]
  Resume --> Caller
```

`createModuleProcess({component,root,createChannel,prepareRelease,validateReady,initializeParams?,exportHandoff?,admission?,canContinue?,onGeneration?,onState?,onModuleChildExit?,investigationsFile?,exchangeMutex?,spawnProcess?})`はstart/close/request/callback/initialize/replace/reserve/snapshotを返す。spawnProcessは実起動の試験DI、通常はNode spawn。component/実行path/argvは固定、envは空又はdiagnosticsの既notes設定一変数だけ。createChannel(child,{generation})は本人のready/request/callback/control/reapedを供給する。descriptorの固定appRootを共通検査し、prepareReleaseとvalidateReadyが作者の署名済版・protocol・実stateCompatibilityを検査する。

usage固有のstartPaused:trueはstartをsettings ready後のinitializingで返し、親がinitializeで既3段を進めた後activate()の実resume ACKで新rootを開く。他componentへのstartPausedは拒否する。初回順序/secret/private snapshotの意味は[module readerとwrapper](module-release.md)と業務正本に従う。

usage/conversationのparent channelは共通endpointの`drainIncoming()`も公開する。childのOS/pipe終了後に親effect/保存/投影commitが残る場合、その実終端を待ってからreapedと次子を許す。親effect無しのdiagnosticsは同portを省略可能。outgoing RPCのreaped待ちcompletionをdrainIncomingへ含めない。

admissionを使うmoduleは同親のclose/drain/adopt/resumeを注入する。canContinueは同親が元opaque leaseとgenerationを照合する関数で、既受付の継続だけを閉鎖中に通す。既定は拒否。callbackの本人性/相関は固有channelが毎回検査し、新root枠へ転用しない。requestと後続initializeはcaller Promiseだけでなく`.completion`を追跡する。quiesce期限も実completionを切らず保持する。既子の全OS/IPC/pipe終了後だけreapedを通知し、次子を起こす。

initializeParams({generation,mode,handoff})は初回bootstrap、採用済起動/交換はrestoreを固有paramsへ変換する。usageのsettings/subscriptions/services段階は同親がinitialize(stage)で進め、交換はexportHandoff(channel)から得た同private handoffを一回のrestoreへ渡す。snapshot start/end/abort・権限はcreateChannelの閉closureへ注入する。本文/path/envをHTTPや更新DTOへ追加しない。

quiesce失敗/60秒未終端は旧resume、新子0・kill0・unknown再送0。新版ready/保存/resume失敗時は未受付candidateをOS終了まで回収し、旧固定版と同handoffから再生成する。既にresume済みで終端不明ならkillで済ませずunavailableに保持し二重writerを作らない。closeは起動/交換中operationと既writerを回収し、新子の起動を止める。exitの5秒killはquiesce成功後だけ。

admission.drainが明示busyを返した時は、子quiesceへ進まず同DRAIN_TIMEOUTで旧resumeへ戻る。

quiesce RPCは残りdrain時間を明示し、共通controller自身もその残時間のwithinで囲む。固有channelのACK/進捗によるcaller期限変更を実drain期限の延長にしない。期限後は元control.completionをactiveへ残し、旧resumeと子epoch検査を使い、遅着quiesceで新受付を再閉鎖しない。close/次交換はその実終端を待つ。

private recordは既0600/no-follow/nlink1/所有/4KiB検査の`bellteam.<component>.adoption.v1`。module/allのdurable requestId ledgerや公開source identityはMollyが所有し、このrecordから捏造しない。reserveはcompletionを返し、実replace終端又はcancelまで同親mutexを保持できる。

このsourceの限定fake-child境界と、各作者の実IPC fixture、Centi同imageの実UID/署名/OS交換は別の証拠。初回親組立とmountはimage導入が必要で、未登録moduleを既imageへ無再起動追加できるとは扱わない。導入後の登録済controller経由コード交換が対象。

親が注入する同exchangeMutexのrunExclusiveでreplace全体（prepare前からdrain/旧OS終端/採用保存ACK/失敗復旧まで）を囲む。mutexが使用中ならMODULE_EXCHANGE_BUSYでprepare・受付閉鎖前に拒否し、子/現在版を変えない。省略時は既個別controller排他だけ。start/close/requestの寿命管理と親の公開Update ledger mutexは変えない。conversation/usage/diagnostics薄wrapperは同identityを転送し、親assemblyの共有一実体DIはintegrationが所有する。

## 交換失敗のprivate診断

既candidate launch/adoption/resume失敗のAggregateErrorに`moduleDiagnostic`を追加する。元code無し/errors/制御は保持。`module-exchange-diagnostic.mjs`の単一validatorは厳密7key schema/component/stage/code/rollback/rollbackStage/rollbackCode、1024 UTF8 bytes以内、固定stageとOS/Node/component code閉集合を検査する。未知codeはnull。候補の最初の失敗段階を固定し、戻しのresumeまで完了した時だけrollback succeeded、戻し失敗は独立stage/codeを保存する。prepare/quiesce/export等の旧子exit前失敗にはDTOを作らない。

Molly共通executorは当該component一致と同validatorで検証したコピーだけを既step.runtimeDiagnosticへ任意保存し、旧ledger field無しを受け入れる。公開error/schema/unknown、同ID非再applyは保持。message/stack/stderr/秘密/本文/環境/PID/任意nested errorsを含めず、過去要求へ欠測を補完しない。

```mermaid
flowchart LR
  Failure[candidate launch / adoption / resume失敗] --> Original[元AggregateError / code無し]
  Failure --> Closed[固定stage・閉code・戻し結果の7key]
  Closed --> Validator[runtime単一validator / 1024bytes]
  Validator --> Ledger[Molly既private step.runtimeDiagnostic]
  Original --> Public[既公開unknown / 元安全code処理]
```


## 子だけの自動再生成

成功稼働子が意図close/交換以外で終了したら新受付を閉じ、OS/IPC/pipe→drainIncoming→await channel.reaped→旧要求completion終端を待つ。採用済み同版を再検証し新generationのrestore/ready/resume ACK後だけ再開。会話はadmission.recover(ticket,old,next)で閉鎖採用、未resume候補の再失敗は同ticketの通常adopt。旧要求や作用不明は再送しない。usageは初回段階順序を保ち、障害復帰ではsettings後subscriptions/servicesも復元する。

module-child-restartは既controller排他へ接続し初回1秒、連続失敗2/4/8/16/最大30秒、正常60秒で初期化。回数による恒久停止無し、closeでtimer取消。members/notifications/web-gatewayも採用版と固有初期化を保持し同timerを使う。親/他子/Dockerは再起動しない。終了logは固定MODULE_CHILD_EXITED/component/整数exitCode/閉signalのみ、stderrは最大8KiBのrawを全chunkの4KiB区間ごとに処理し、大chunk中央/区間境界の固定4codeも検出する。任意本文を保存/公開しない。常駐子のstdout/stderrはpipeで排出し、inheritで本文を親logへ流さない。

```mermaid
flowchart LR
  Exit[子の異常終了] --> Reap[新受付閉鎖 / 実OS IPC pipe incoming reaped終端]
  Reap --> Timer[1秒から最大30秒]
  Timer --> Restore[同採用版 新generation restore ready]
  Restore --> Resume[実resume ACK / 新受付]
  Restore --> Timer
  Close[親close] --> Cancel[timer取消]
```


## 子終了診断のcallback

共通3componentとmembers/notifications/web-gatewayの6常駐子factoryは`onModuleChildExit(dto)`を受ける。usage/conversation/diagnosticsの薄wrapperも同identityで転送する。既OS/IPC/pipe終了後の異常終了条件から一回だけ通知し、意図close/交換・未resume候補は報告しない。callbackの同期throw/戻りPromise失敗は再起動・元completionへ伝播しない。初回1秒/最大30秒の再生成、incoming/reaped待ちと元要求非再送は維持する。

`observeModuleChild()`の内部snapshotは固定4code、既Node heap OOM marker、GCのbeforeMiB/afterMiB/capacityMiB/pauseMsだけを返す。rawは8KiB以内でpipe close時に破棄する。最大8件の末尾証拠は`heap_oom`又は`gc`の有限0..1e9数値。stderrBytesは非負safe整数で飽和、raw/evidence上限超過はstderrTruncated=true。不明なstderrやOSのSIGKILLからOOM原因を推定しない。既固定console出力は維持する。

閉DTO `bellteam.module-child-exit.v1`と単一validator/formatter/保存/取得は[diagnostics正本](../diagnostics/README.md#子終了の有限診断)。親登録と診断停止中の最大6最新値・ready時flushは[integration](../integration/README.md)。runtimeは新しいwriter/queue/再送機構を持たない。

```mermaid
flowchart LR
  Stderr[全stderr chunk / raw8KiB上限] --> Evidence[固定OOM・4code / GC数値末尾8件]
  Close[既OS IPC pipe終端 / 異常終了だけ] --> Report[一回report / 既console固定出力]
  Evidence --> Report
  Report --> Callback[onModuleChildExit / 非待機・失敗隔離]
  Callback --> Parent[Molly親登録 / Signal単一writer]
  Close --> Existing[既incoming reaped待ち・同採用版の再生成]
```


## 旧exit前のdrain timeout

更新のDRAIN_TIMEOUTだけ既error.moduleDiagnosticへ`bellteam.module-drain-diagnostic.v1`を付ける。schema/component/stage/runnerActive/admissionActive/admissionClosed/admissionUnconfirmedの閉7key・1024 bytes以内。stageはparent_drain/child_quiesce/handoff。activeは非負safe整数又は欠測null、boolも欠測null可。既admission.snapshotからactive/closed/unconfirmedだけを選び、generation/lease/correlation・自由error・本文・stackを含めない。snapshot失敗は欠測にし、元error/code/60秒/旧resume/非再送を変えない。

診断は旧resumeの前に捕捉し、親は既private step.runtimeDiagnosticへ保存する。validateModuleExchangeDiagnosticは旧exchange-v1又は新drain-v1の閉variantだけを許可し、既7key exchangeの検査と過去field無しledgerを維持。公開Operation DTOへ追加しない。現在の本番f3f098bbの段階/activeを新sourceから後付けせず、元欠測を保持する。

```mermaid
flowchart LR
  Parent[親実completion + admission drain] --> Busy{明示busyか}
  Busy -->|yes| Old[同DRAIN_TIMEOUT / 旧resume / 元要求保持]
  Busy -->|no| Quiesce[残り60秒内の子quiesce]
  Quiesce --> Export[handoff実completion]
  Parent -->|timeout| Private[固定stage / runner件数 / 既admissionの3scalar]
  Quiesce -->|timeout| Private
  Export -->|timeout| Private
  Private --> Ledger[既moduleDiagnostic / private runtimeDiagnostic]
  Private --> Old
```
