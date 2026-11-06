# 現用421dの限定配送policyを既公式経路へ結ぶ

Rootの初回単位はfresh公開builtin421dに対する3拒否修理だけ。Mollyが固定入力と通常mainを接続、Epiがruntime/profile/packager/verifier、Centiが既publish-executionの別subject署名を所有する。

| 機能 | 入出力・所有 | 失敗と保持 |
| --- | --- | --- |
| 固定入力 | 98f5cd20の2sourceをruntime-live-delivery-adoption/profileへbyteexact収録 | 通常src/の新版を戻さず、旧48/new50をengineとして混ぜない |
| 固定profileとadopter | Epi README/source.json・7method・元cached421d import投影→同instanceへ採用 | 元SDK/job/native/watch/Map/Promise/callback/selector/generationを保持。Root別具体作用まで本番0 |
| 同mainS | 入力+Epi完成source+本人runtime/packager結果+Centi workflowを一差分で統合 | workflow単独main採用/dispatch0、作者成功群再走0、必要接続だけ確認 |
| 正式供給 | 同publish-execution/main/S→通常archiveの既処理後→live-delivery別subject→既公式verify/upload | 一般47/48/50 inventory不変、source=signer=S。供給と現用採用を分ける |

DFD: `fresh421d→backport98f5固定2file→profile+Epi7method runtime→同mainS←Centi既workflow→別sidecar package/check/公式OIDC署名/verify→Root固定actor/対象/UUID→元instanceへ限定採用`。MCP Room最小採用・新親receiver・59d全親供給は独立の次単位で、この最初の署名を待たせない。

準備branchのworkflow単体はEpi完成source待ちの未完候補。恒久採用前にexact profile2file、workflow CLIとEpiのpackage/check/verify interface、作者の新完成結果だけを照合する。

## Root実測に基づくstage接点

Root正本message-receipt-contract-20261106.mdとruntime-policy-plan.jsonが配置契約を所有する。旧/run/bellteam-maintenanceは別RO volumeなので使わず、既RW /run tmpfs直下の `/run/bellteam-live-delivery-adoptions/<UUID>/` に固定する。新規root0:1001のdir0750/file0640、元ReadonlyRootfs/mount/既dir権限は維持。DFD: Root固定operation→新stageの検証済asset/operation.json→Epi固定client/adopter→既UID1001 state receipt。既receipt `/srv/bellteam/state/runtime-adoptions/<UUID>/` のRW実mountはBell追加確認中で、DACから推定しない。

Epi完成sourceの図/DFD/READMEと固定adopter/clientがこのstageを使うことを、同mainSの実接続として照合する。対象7method/schema/元owner/別subjectは不変。初回sourceが古いstageを持つまま正常反映可能とは扱わない。本番配置/Signal/evalはこの差分から実行しない。
