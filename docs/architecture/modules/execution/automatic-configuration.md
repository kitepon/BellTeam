# 自動設定操作の閉じた公開状態

所有キロ。既configuration port内の追加状態。公開HTTP登録はモリー、membersの一覧/MCP転送はベロータ。gate writerと元operation追跡は[model-handoff.md](model-handoff.md)へ接続する。

```mermaid
flowchart LR
  Record[execution元opの保存済みsnapshot] --> Cache[Administration内のbot別currentRequestIdとrecords Map]
  Cache --> Closed[10key schema/validator]
  Closed --> View[administration.view 同期snapshot]
  Closed --> Read[readConfigurationOperation 同Bot/同UUID]
  Read --> NativeRead[既bindingの独立read / 作用0]
  NativeRead --> Record
  View --> Members[members一覧/get_self/get_bot 既公開転送]
  Read --> HTTP[共通GET configuration-operations/requestId]
  Closed --> Error[停止失敗optional欄 生成失敗は元error保持]
```

`automaticConfigurationApplicationSchema`と`automaticConfigurationApplication`が唯一の閉DTO正本。schema/requestId/state/phase/effect/laterEffect/stopIntent/admissionStopped/revocation/errorCodeの10keyだけを許可し、accessor/余分key/不正UUID/不正enumを拒否。新snapshotを返し、native point/本文/設定/関数/Promise/生例外を公開しない。

Administrationの`automaticConfigurationOperations`は投影専用のvolatile Map。Bot ID→`{currentRequestId,records:Map<UUID,DTO>}`。gateの権限・耐久intent・native結果そのものはこのMapから作らない。ModelHandoffが元bindingへ検証済みのsnapshotだけをpublishする。交換handoffはMapをcloneして運び、新writerもその同Mapへ接続する。旧handoffで欄が無ければ空とする。process再起動後は既intentの未終端fenceを復元するが、欠測contextから新operation/bindを作らない。

`view(bot)`はcurrentRequestIdの同期snapshotだけをoptional `automaticConfigurationApplication`へ追加。既configurationApplication/configurationRequestの意味と値を保つ。AのrecordsはBのcurrentへ付け替えず、`readConfigurationOperation(botId,requestId)`は指定の元recordを独立に返す。live operationは同connection/同opのreadだけを呼び、commit/revoke/launchは発行しない。過去のcacheは同期snapshotを返す。unknownや未記録でfenceを解除しない。認可とfresh対象確認は既親入口、methodもBOT_NOT_FOUNDを不正IDより先に返す。不正ID400/未記録404/不正record又は読取不能503、unknown recordは正常DTO。

stop失敗は既BOT_STOP_UNCONFIRMED/causeを維持し、validatorを通した同optional欄だけを添える。生成に失敗しても元停止errorを置換しない。親は既502/messageを維持する。local intentだけでstop_sent/interruptedへ変更しない。

先行投影sourceの確認範囲はDTOの入力拒否/同Bot・同ID読取/同期view/失敗時の旧stop契約だった。M consumerの新確認はmodel-handoff.mdと供給manifestを参照し、先行の成功をnative受領/全M成功へ拡張しない。既src/automatic-configuration-application.mjsはEXECUTION_FILES収録済み、今回追加重複無し。
