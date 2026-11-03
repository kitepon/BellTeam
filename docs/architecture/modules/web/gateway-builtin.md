# Web受付固有の内蔵版戻し

Web担当の正本。固定資材のreader/配置は[runtime](../runtime/web-gateway-release.md)、Owner認可・共通排他・ledgerへの登録は[integration](../integration/README.md)が所有する。ここでは`http-gateway-process.mjs`の内蔵版選択/採用状態、`web-gateway-control.mjs`の予約境界、`web-gateway-update-adapter.mjs`の固有adapterだけを扱う。

```mermaid
flowchart TD
  Owner[Owner release POST: versionId builtin] --> Control[既control.reserve / completion]
  Parent[親: 同image distribution確認済builtinSourceCommit] --> Adapter[Web固有update adapter]
  Ledger[integration: 既共通ledger / 同UUID] --> Adapter
  Adapter -->|source一致・apply| Replace
  Control -->|finish後だけ| Replace[process.replace builtin]
  Fixed[親起動時の固定appRoot] --> Replace
  Replace --> Stop[既5秒drain・旧子OS/IPC/stdio close待ち]
  Stop --> Ready[固定appRootから起動・同port ready]
  Ready --> Assets[readyの実assetVersionを既catalogへ登録]
  Ready --> Adoption[atomic採用: currentVersionId null / previous SHA又はnull]
  Adoption --> Reload[親再起動: 明示current nullは固定appRoot]
  Reload --> Previous[previous SHAは既readerで再確認・旧asset route登録]
  Ready -->|起動又は保存失敗| Restore[旧descriptor再確認・旧受付復旧 / 成功にしない]
```

公開制御の入力はSHA64又は文字列`builtin`だけ。任意path/command/sourceを受け取らない。`builtin`は既readerへ渡さず、親生成時の`appRoot`に固定したdescriptor `{versionId:null,appRoot,protocolVersion:1}`を使う。通常SHAは既readerのdescriptorとsourceCommit/platformをそのまま保持する。

`createWebGatewayUpdateAdapter({gateway,builtinSourceCommit,prepare})`は既current/capture/available/canRollback/prepare/applyを提供する。gatewayは同processを返すclosure、prepareは公開prepareGatewayReleaseの注入。同image distribution由来の確認済sourceSHA40を親が一度だけ渡し、controllerや公開bodyから補完しない。確認値がnull/不正なら内蔵currentは不明null、builtin戻し不可。currentは既version tuple、captureはgeneration:null/pid、availableは実process pidの有無。共通ledgerが計画/UUID/guard/成功確認を所有し、固有helperはそれを複製しない。

builtin targetのorigin/version/sourceCommit/digest:nullが確認済sourceと一致する場合だけcanRollback/prepare/applyを通し、applyは`replace('builtin')`の実Promiseを返す。別sourceや不整合targetはUPDATE_ROLLBACK_UNAVAILABLE、reader未供給はUPDATE_EXECUTOR_UNAVAILABLE。通常SHAはprepareでversion/sourceとcatalogのprotocol/platformを既条件で確認し、相違をUPDATE_TARGET_CHANGED/UPDATE_INCOMPATIBLEで拒否する。path/URLを新たに受け取らず既descriptorを起動へ転記しない。共通import/登録と親の確認済source注入はMollyが担当する。

採用記録は既schemaのまま、`currentVersionId:null`を内蔵版の明示採用として許可する。欠落/不正型/文字列builtin/未知SHAを内蔵版へfallbackしない。保存はready後、失敗すれば旧子へ復旧する。現在版の公開値はnull、操作対象はbuiltinで区別する。同版の再予約は既制御の冪等処理を使い、履歴/data/希望/ledgerを巻き戻さない。

asset catalogへnullやbuiltinという仮keyは追加しない。実子readyのassetVersionを登録する。再起動時は直前SHAの資材を再確認して旧URLへ接続する。全世代asset一覧の親再起動を跨ぐ保持は既shortcutの範囲外。

既Owner認可/内部403・finish前cancel・共通mutex/completion・prepare拒否時の旧子維持・同port・5秒drain・親close時の次子抑止は変更しない。未配置Host設置や署名/実root受入は固有層から補完しない。process/control直接境界は`test/web-gateway-builtin.test.mjs`、adapter直接境界は`test/web-gateway-update-adapter.test.mjs`。人工descriptorと実子/HTTP/一時採用fileを使う。
