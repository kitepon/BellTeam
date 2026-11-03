# diagnostics の状態と単体更新

業務内部はシグナル。親facade/通常main組立はモリー、runner/排他/世代交換はエピネル、署名imageはセンチ。全体は[機能図](../../feature-map.md)、既HTTP選択と安全な報告文脈は[integration](../integration/README.md)、子終了/OS確認は[runtime](../runtime/README.md)を参照する。

```mermaid
flowchart TD
  Callers[HTTP診断受付・execution・通知の既report] --> Facade[親の安定facade / generation付与]
  Admin[Bearer管理GET・resolve/reopen/annotate] --> Facade
  Facade --> Dispatcher[createDiagnosticsDispatcher / 閉5操作]
  Dispatcher --> Writer[Diagnostics / 同file唯一writer / pending直列保存]
  Writer --> File[logs/diagnostics.json / 版無しrows配列]
  Notes[任意investigations file / fingerprint map] --> Writer
  Writer --> Result[保存ACK後row / 同snapshot一覧AsyncIterable]
  Result --> Facade
  Facade --> HTTP[既HTTP配列・保存指紋/count/time]
  Control[initialize → resume → quiesce] --> Drain[先行操作・一覧消費・pending実保存をdrain]
  Drain --> Exit[exit / closed ACK]
  Exit --> Runtime[runnerがOS・IPC・pipe closeを確認]
  Runtime --> Restore[新factory / 同file read-only restore / resume]
```

## 公開入出力

`createDiagnosticsDispatcher({root,investigationsFile})`は`validateRequest(method,params,context)`、`dispatch(method,params,context)`、`control(method,params)`、`disconnect()`を返す。任意file/method/callback/effectは要求DTOへ持ち込まない。contextは`{generation}`だけ。generationは非空・128字以内・空白/NUL無し文字列でinitializeと一致する。

業務操作は`record({report})`、`list({status?,limit?})`、`setStatus({fingerprint,status,note?})`、`setNote({fingerprint,note})`、`updateInvestigation({fingerprint,status?,note?})`。未知keyは拒否する。reportは既code/module/app_version/diagnostic_log/severityだけ。固定code、重大度、集約fingerprint、unknown、count/time、再発open、根拠付きinfoと注記の既意味は維持する。record/変更操作は実保存後rowを返し、保存失敗は成功にせず同writerへ再帰報告しない。

listは既all/open/resolved、1〜1000件・既500既定、last_seen降順、本文を省略せず同snapshotのAsyncIterableを返す。recordと注記更新で既snapshotのrowを変更しない。注記は既投影形にだけ添え、設置別investigationsを保存原本へ混ぜない。親は既配列へ戻し、runnerは既256KiB/credit付き逐次JSONを使う。ローカルclassの同期list互換と管理GETのasync facadeを両立する。

## 状態と終了

`DIAGNOSTICS_STATE_COMPATIBILITY`は`{diagnostics:'unversioned-rows-array',investigations:'optional-fingerprint-map'}`。これは実保存形式の宣言で、架空schema番号やrawstate引渡しではない。initializeは`{generation,mode:'bootstrap'|'restore'}`、返却は`{stateCompatibility}`。bootstrapだけ既chmod初期化、restoreは同保存先と任意注記を読むだけでmkdir/chmod/write/mtime変更をしない。initialize完了からresumeまでは業務を受付けない。

quiesce/resume/exitは空object。quiesceはvalidateRequestの新受付を閉じる。runnerで既に受付済みの要求はdispatchでacceptingを再検査せず、generation/DTO/初期化/exitだけを再検査する。同期active登録とquiesced無効化を行い、既操作・list消費・pending保存を実終端まで待って`{quiesced:true}`。resumeは未完quiesceを無効にして`{resumed:true}`。exitはdrain済みだけ`{closed:true}`。disconnectは新受付を閉じ、一覧を閉じ、保存実終端を待つ。制御のtimeoutは取消の証明にしない。60秒drain未完なら旧resume・新子0、OS/IPC/pipe close後だけ新restoreという世代交換はruntime所有。

直接fixtureは閉DTO/generation、保存ACK/drainと未終端resume、失敗保存の非成功、read-only restoreのmode/mtime/bytes、同snapshot/16MiB超一覧の逐次消費、独立factoryと管理GET配列を確認する。実署名/native/配布の成立はこの局所試験だけで宣言しない。
