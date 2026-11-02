# installer・状態移行・backup/restore

責任者：エピネル。公開窓口は[runtime](README.md)の`update`。配布構成・採用imageと公開は[distribution](../distribution/README.md)、本番実行はトロニー、OSは各Host担当。ここで示すのは現行実装で、[商用更新の設計案](commercial-update-design.md)の新機能を実装済みとしない。

## installerは停止前の準備と、停止後の保守を分ける

```mermaid
flowchart TD
  Input["通常導入 / no-pull / recover"] --> Freeze["image IDと正規化Composeを固定"]
  Freeze --> Storage["保存先・Engine API・volumeを検証<br/>初回は権限拒否を試す"]
  Storage --> Previous["旧runtimeと旧設定を保存<br/>現在の世代と照合"]
  Previous --> Keep["保存世代を保持すると決める"]
  Keep --> Stop["現在CIDを停止<br/>必要時restart無効化と除去"]
  Stop --> Writers["重なる全writerを確認"]
  Writers --> Maintain["専用保守processでprepare・移行"]
  Maintain --> Mode{"通常更新か復旧か"}
  Mode -->|"通常"| Cursor["Cursor専用volumeを更新"]
  Mode -->|"復旧"| Old["保存した旧modelを選ぶ"]
  Cursor --> Start["固定imageで起動・health待ち"]
  Old --> Start
  Maintain -->|"失敗"| Halt["停止したまま<br/>保存世代と移行状態を保持"]
  Cursor -->|"失敗"| Halt
```

| 機能 | 実関数/入口 | 失敗時に残るもの |
| --- | --- | --- |
| 設定固定 | `distribution/server/install.sh` | imageのIDを固定しimage内の保守/Cursor scriptを抽出。normal/maintenanceの同世代JSONはprivate。後から.envやtagが変わっても途中で選び直さない |
| 初回storage | installerのpermission probe/volume照合 | UID1000の実読取拒否が成立するHostはlocal bind volume、拒否されない共有folderはEngine内volume。既volumeのname/driver/labels/optionsが違えば停止 |
| 旧model回収 | `capture_previous` | 証明不能ならprevious-normalを作らず警告、原本保持。通常更新そのものは進め得るが、その世代のrecoverは拒否 |
| recover | installer `--recover` | 保存した旧model/旧imageが存在することを停止前に確認。現在データを旧配置へ戻す場合もあり、古いbackupへ巻き戻す操作ではない |
| writer確認 | `assert-state-writers-stopped.sh → stateWriterPlan/Volumes/Sources/assertStateWritersStopped` | 全containerの稼働/restart policyとRW mount、volume実体、Hostのcanonical pathを比較。Docker socketはreaderへ渡さず、env/資格内容を証拠へ複製しない |
| writerの限界 | `participates/volumePaths` | stoppedContainerのunless-stoppedだけを特例扱い。未知driver/metadata/aliasは成功へしない。snapshotだけでは保守中の新writerを防げないためlock/data sealと組合せる |
| maintenance | `compose.state-maintenance.json` | networkなし、固定entry、private rootの排他flock、runtimeとprivate volumeだけ。root処理はこのオフライン保守が所有 |
| Cursor更新 | `update-cursor.sh → cursor-update-entrypoint.sh` | normalized project/volume名で使い捨てcontainer。空envの固定入口から公式update。BellTeam本体の環境や資格fileを読み出さない |
| cleanup | installerのtrap | 一時staging/probeを除く。停止を試みる段階以後は保存世代を消さない。自動的に別imageを起こすrollbackはない |

## 状態移行の三つの責任

```mermaid
flowchart TD
  Prepare["private root / HOMEの準備"] --> Inspect["移行記録・data型・両側の内容を検証"]
  Inspect --> Seal["既存データがあれば<br/>dataと記録fileを原子的交換"]
  Seal --> Roots["保護rootをcopy・全bytes照合<br/>元をretiredへ退避"]
  Roots --> Files["台帳・予定・添付・設定を移す<br/>markerを最後に確定"]
  Files --> Ownership["対象だけのUID/modeを整える"]
  Ownership --> Publish["dataを戻し移行記録を除く"]
  Files -->|"衝突 / 不明"| Remain["原本と記録を保持<br/>両世代を起動しない"]
```

上図はto-serverの順序。to-legacyは個別file移行後に保護rootを戻す。根の再配置、fileの配置、所有権の変更を同じcopy関数へまとめない。

| 責務 | 実関数 | データと不変条件 |
| --- | --- | --- |
| 準備と再開 | `prepareServerStateRuntime/migrateServerState/readTransaction` | private rootのdevice/inode、方向/id/時刻を検証。data=fileなら同記録とhidden directoryが必要。settled状態は不用な所有権再設定を省く |
| 使用中に見せない | `checkExchange/exchange` | 同filesystemでdirectoryとfileを交換する機能を先に確認。交換後inode対応を確認。途中失敗は記録を手で消して解除しない |
| 保護root移動 | `relocateServerRoots/copyTree/equalTrees` | state/rooms/owner/logs/settings/APNsだけ。別filesystemはcopy→bytes一致→公開→元retired。既存非空の内容不一致は上書きせず拒否。既知の古いsocketはcopyしない |
| file移行 | `transferServerState/moveFile/moveTree` | bot.json/schedule.json/assets、subscription/onboarding/AI停止/bridge/BugHub参照。全profile/schedule検証後に元を除く。AI停止は専用schema検証 |
| 移行済み更新 | `transferServerState`の`already-transferred` | to-serverで初期化済み、旧配置に移行対象fileがなければ`.deleting`を保持して通常起動へ進む。削除の完了はBotRegistryが所有。実移行とto-legacyは未完削除を拒否する |
| durableな公開 | `regular/equalFiles/syncAncestors/removeUnchangedSource/marker` | O_NOFOLLOW、inode/link/size/mtime、完成copyのsync→rename→元の不変確認→unlink。初期化markerは最後。異常終了後は同transactionの未公開tempだけを整理 |
| 所有権 | `prepareServerStateOwnership` | 保護rootだけを事前列挙しlink/特殊fileを拒否→開いたFDで本人性再検証→chown/chmod。seat project/HOME/記憶DBを一括chownしない |
| 終了 | `migrateServerState`末尾 | 所有権/残temp確認後にdataを戻しtransactionを除く。retiredは移行時点の原本で、その後の新しい会話のbackupではない |

## 稼働中の控えと、新しい場所への復元

```mermaid
flowchart TD
  Running["現在CID / image / Cursor volume"] --> Guard["NAS mountと排他lockを確認"]
  Guard --> Image["不変imageを一つのblobへ保存 / 再利用"]
  Guard --> Archive["稼働fileの同一性を確認しarchive"]
  Archive --> SQLite["SQLiteは別のonline backup<br/>quick_check付きsnapshot"]
  Image --> Point["NAS再読・hashと元CIDを照合<br/>復元点metadataを確定"]
  SQLite --> Point
  Point --> Retain["検証済み復元点を直近2世代保持"]
  Point --> Restore["新しい空の復元先へ展開"]
  Restore --> Check["path/link/manifestとDBを検証"]
  Check --> Publish["snapshotをDB位置へ置き<br/>完成したdirectoryをrename"]
```

`save-deploy-restore-point.py`の控えは**imageとCursor volume**。本体全state/HOMEの完全backupと呼ばない。`mount_guard`は所定NASがなければlocalへfallbackしない。`archive`はpartialへ帯域制限付き保存→再読hash→rename、producer異常ならpartial削除。`image_blob/checked_image_blob`は既保存のimage本人性を確認して再利用。`validated_points/prune_points`は控えの構成と参照を検証してから古い二世代外を除く。失敗世代はfailed.jsonを残す。

`archive-live-volume.py.create`は一般fileの変化を拒否し、SQLiteのrawは観測bytesとしてだけ保存、復元用DBはread-only接続のbackup APIから作る。DBごとに120秒とquick_checkを持つ。Throughlineの既知atomic JSONだけrename交替を許し記録する。全volumeが同一瞬間のsnapshotという意味ではない。

`restore`は既存destinationを拒否。manifest/重複member/相対path/type/SQLite family/hardlink/symlink祖先を検証し、仮directoryへ展開。生のSQLite/WAL群は復元に使わず、再検証したsnapshotを置く。symlinkは配置検証後に作り、最後に完成directoryをrenameする。復元したdirectoryを本番mountへ切替える操作はこの関数にない。

実装：[installer](../../../../distribution/server/install.sh)、[state transfer](../../../../src/server-state-transfer.mjs)、[writers](../../../../src/server-state-writers.mjs)、[ownership](../../../../src/server-state-ownership.mjs)、[volume archive](../../../../scripts/archive-live-volume.py)、[restore point](../../../../scripts/save-deploy-restore-point.py)。移行/復旧/CI/Host操作の再実行はしていない。実導入の受入範囲は各版の既存記録を参照する。
