# execution固定factoryの配布

配布はセンチ。engine/generationは[キロ](../execution/host-factory.md)、固定loader/receiptは[エピネル](../runtime/execution-loader.md)、親live ports/採用保存ACKと通常mainはモリー。親controllerを子プロセス型へ作り直さない。

```mermaid
flowchart LR
  Source[固定Git / 47 JSとcommon-agents / packageとlock] --> Package[50literalと同lock production依存]
  Package --> Probe[別tmpのUID1001 / 実factoryとasset / 人工native ports]
  Probe --> Sign[execution専用main OIDC]
  Sign --> Verify[公式検証 / sourceとarch / 実互換文字列 / 完全inventory]
  Verify --> Install[既root privateSHとexecutionEX / NOREPLACE / receipt最後]
  Install --> Loader[同image execution loader / 固定entry import]
  Loader --> Host[同親SDKとopaque ports / generation / 保存ACK]
```

入口はpayload/src/execution-dispatcher.mjs、Node26/Linux/P1、stateCompatibilityは実export文字列bellteam.execution-state.v1のまま。catalog5keyのstateSchema/containerUpdateはnull。package/lockは同Git、SDK依存は通常npm ci --omit=dev。任意src追加や欠測common-agents、別source/platform/互換、改竄は公開前拒否。archive JSは認証中に実行せず、既信頼済imageのexportで照合する。

members-admissionが読むmodule-ipc.mjsを固定payloadへ含め、現行の共通容量64を同じ完成sourceから収録する。親ports・engine・状態互換の実装は変更しない。
bot-administrationが読むautomatic-configuration-application.mjsも同じ固定sourceから収録し、実ソースの相対import閉包を構文解析だけで確認する。engine sourceは会話所有のconversation-writer.mjsを読まない。失敗statusのmcp_error/native_launchはaiterm-transportが閉包内のreturned-mcp-error/agent-launch-errorから作り、会話側deliveryFailureFieldsと同じ安全fieldだけを渡す。
M consumerのmodel-handoff.mjsと、aiterm-client/configuration-intentsが読むaiterm-hooks.mjsを同source固定payloadへ収録する。producerは50件を要求し、readerは公開済み47件・48件と現50件の完全な集合だけを受理する。新helperの片方だけの49件や任意の欠落・追加は拒否する。common-agents/package/lockは同source、追加npm依存は無い。Mのshared AitermClient.captureHandoffConnectionと元handler/actor anchorは同main親資材、対応native/Aitermは正式供給で合わせる。execution単独交換を全M成立としない。
web_gateway_artifact.pyの固定inventoryは同梱readerも使うため、その変更は通常push CIのimage供給対象に含める。新archiveは対応readerを含む正式imageへ公開導入してから単品更新する。

通常親DIのnative.call/connect/launchOptionsは親AitermClient receiver、waitProcess/handoffContext/write/removeも親application-servicesのclosureに束縛される。run-seat-command/run-seat-aiterm-launchは親/app側URL、run-seat-setupはbootstrapのみでengineから呼ばない。この3sidecarはpayloadに収録せず、private payloadのUID1000公開やfallbackを追加しない。任意custom/test portsの一般保証ではない。親assembly/generation/adoptionは通常imageに置き、engine literalへ増やさない。

署名前probeはrootが独立/tmpへ検査済みunsigned archiveだけを展開し、0555/0444の実payloadをUID1001の別Nodeで読む。実factory initialize→同期projection→quiesce/export/retire→同handoff復元→退役と同bundle reminder assetを有限確認。nativeはpty_list以外拒否する人工port、共有close0、空人工data不変、OSexitとcleanupを記録する。checkout祖先を別UIDへ公開せず、Node pathは固定CI入力のみ。これはunsigned factory/closureの確認であり、実SDK・署名交換・本番は別工程。

署名後は既root installerがprivate全体SH/executionEX、公式OIDC/source/arch/完全inventoryを確認し0555/0444/NOREPLACE・receipt最後で設置する。親loaderが実namespace/互換も照合してgenerationへ返す。実交換検査では旧actual0→export/retire→新restore→onAdopt実ACK→builtin戻しと同SDK/PTY保持を測る。本差分でHost操作・実席・実鍵・catalog公開は行わない。

## 同imageの署名factory交換fixture

`verify-execution-image.yml`は通常image/sourceと専用署名runを固定し、両nativeでpullだけを行う。既有限allocation/cleanupを再利用し、人工supervisor以外は同imageの固定normal C/UID1001/親privateSH3・stateEX4を使う。executionはhost内factoryなので新C子/IPCの交換として扱わない。

```mermaid
flowchart LR
  Inputs[同source既imageと署名run] --> Fetch[元ZIP SHA-size / source-arch-run固定]
  Fetch --> Parent[固定normal C / UID1001 / 同親PIDbirth-port]
  Parent --> Plan[同image executionInstallPlan / 実private volume]
  Plan --> Installer[固定root installer / 改竄source拒否 / receipt最後]
  Installer --> Reader[default execution loader / 完全inventory]
  Reader --> Generation[実Assembly・generation / 同人工SDK ports]
  Generation --> Exchange[実drain-retire-restore / 採用saveACK / builtin戻し]
  Exchange --> Cleanup[fixture所属container-volumeのみ回収]
```

PR304のinstall.sh短縮入口にexecution選択は未収録なので、fixtureは同imageの公開固定planへ保存normal modelと実inspectを渡し、その生成helperを実行する。shell短縮入口/Host反映成功には補完しない。業務guestはキロのtest-only helperを使用し、descriptor/importを人工置換せず同image loaderを経由。実SDK/PTYを触らず人工native portsで共有close0を測り、親の独立business/gatewayと同portを保持する。旧成功群を再実行せず、交換実物と作者の人工試験を分けて記録する。


## 現用421dの固定配送method sidecar

通常47/48/50件のexecution archiveと別の非catalog資材を、同main Sの既publish-execution.ymlで供給する。runtime実装/閉manifestとadopterはエピネル、421d基準の3拒否backport2fileと7method指紋はモリー、署名workflowはセンチ、実採用はRootの別具体作用。新しいsigner/workflow/鍵や任意branch署名は追加しない。

```mermaid
flowchart LR
  Main[同main S / 固定runtime-live-delivery-adoption] --> Original[既通常archive生成・probe・OIDC・verify]
  Original --> Sidecar[既amd64-arm64 matrix / 固定package.pyとcheck]
  Sidecar --> Attest[別subject live-delivery-S-linux-ARCH / 同OIDC]
  Attest --> Verify[固定verify.py / source=signer=S / 既trusted roots]
  Verify --> Upload[既execution artifactへarchive・bundle・検証原本を収録]
  Upload --> Runtime[Root別作用 / 既421d class指紋へ7descriptorだけ採用]
```

sidecar生成は通常archiveの署名・検証より後に行い、既tar.gz globがsidecarを同じsubjectへ混ぜない。別subjectのbundleを固有名へ保存してから、固定verify.pyが署名と閉inventoryを検査しlive-delivery-verified.jsonを返す。失敗は同job非0、採用器やclientはCIから起動しない。既uploadだけを使い、通常archive名・inventory・証明は変更しない。

固定CLIはruntime-live-delivery-adoption/README.mdの機能/DFD/供給interfaceが正本。package.py --source S --arch ARCH --output runtime/execution/live-delivery-S-linux-ARCH.tar.gz、同package.py --checkとverify.pyのsource/signer/archを同値に束縛する。profileの旧source421d/backport98f5/2file SHA・7method、archive内容、runtimeの対象・失敗扱いは同正本を参照する。

このworkflow差分はruntime側のpackager/verifier/adopter/profileと同main Sで採用する。別branchの旧版や未同梱のscriptを既成立とせず、一般catalog/新親全体受入を初回method採用のgateにしない。実Node/Host/Inspector/AIや現用への作用は発行しない。
