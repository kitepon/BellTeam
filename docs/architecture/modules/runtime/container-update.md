# container更新のHost受付と停止を跨ぐworker

runtime所有エピネル。Root container-update-host-contract/update-center-api/update-catalog-root-contract（2026-11-03）を実装する。OS条件はEmma container-update-host-source-conditions-20261103。設置前のsource工程であり実Hostへ登録済みとはしない。

```mermaid
flowchart TD
  UI[認証済みアプリ / 同じ許可済みBot運用] --> Common[Molly: plan・requestId・再起動確認]
  Common --> Client[runtime: 固定Unix client / NDJSON64KiB・5秒]
  Client --> Socket[固定socket / peer Host UID1001 / 同時16]
  Socket --> Host[root限定受付 / path・env・shellを受けない]
  Catalog[Centi: 正式発行の公式検証] --> Store[root immutable catalog / 鮮度・失効・単調採用]
  Store --> Host
  Host --> Plan[root保存plan / target・current前提・5分期限]
  Plan --> Ledger[requestId永続ledger / 同ID同planは照会 / 異plan409]
  Ledger --> Unit[別system manager worker.service / Restart=no]
  Unit --> Bound[worker一回claim・lock / ledger fsync・受領ACK]
  Bound --> Accepted[永続受領＋worker束縛後だけaccepted]
  Unit --> Installer[固定root closureの既installer / 保持・起動・戻し]
  Unit --> Module[同image固定module installer / code・receipt配置だけ]
  Module --> Recheck[親prepareReleaseで配置・互換を再検査]
  Recheck --> Exchange[同module controllerの実交換 / 他module・親は継続]
  Installer --> Verify[実CID・immutable image・source・health確認]
  Verify --> Result[同requestIdへdurable終端 / cleanup失敗分離]
  Result --> Client
  Client --> Get[同ID get / ledger排他を待機して再読]
  Get --> Result
```

標準の公開installerに同梱するmodule導入経路は[箱同梱module導入](module-installer.md)が正本。以下は既Host機構およびcontainer全体更新を跨ぐworkerの契約であり、標準導入にHost構築を要求するものではない。

## 固定配置と公開機構

Host prefixは `/srv/bellteam/shared/tools/bellteam-container-update-host`。releases/SHAにroot-owned全code/import/既installer closure、catalogに信頼済catalog、state0700/通常file0600、socket親root:1001/0750とupdate.sock0660。各祖先まで非symlink/root管理/非特権write禁止。実Hostの既shared祖先が成立しなければ権限を奪わず設置拒否する。normalへsocket親だけRO bindし `/run/bellteam-updater/update.sock` へ接続する。state/code/catalog/Docker socketをnormalへ渡さない。同1001子とのOS隔離とOwner本人性をpeer UIDだけで保証しない。

`src/container-update-client.mjs:createContainerUpdateClient()` がcapabilities()/catalog(componentId)/plan({planId,catalogSha256,versionId})/start({requestId,planId,confirmContainerRestart})/operation(requestId)を提供する。requestIdとplanIdは共通API UUIDv4。planは正式catalogのcontainer/platform/versionを選択し現CID/image/sourceを固定、5分期限。startは再起動確認と現前提を再検証し、同ID異plan/別ID並行を拒否。送信後の期限・応答欠測はunknownとして同ID GETへ戻し、自動再発行しない。

`container-update-host.py`のCLIは引数無し受付、固定--worker UUID、root限定--probe/--refresh-catalog/--install-catalogだけ。operationはcapabilities/catalog/plan/start/getの閉集合、一接続一frame、JSON UTF8 64KiB/5秒/同時16、未知key/型/偽peerを作用前拒否。callerに任意entry/path/URL/env/Docker引数を供給させない。root stateにintentをfsyncしてから別worker serviceを起動し、workerの一回claim・PID出生/unit・永続ACK後だけaccepted。daemon再起動でunknownを再発行しない。

別workerはsystem managerのserviceでType=exec/Restart=no/固有requestId unit、受付・本体へのPartOf/BindsTo無し。setsidだけで同cgroupを残す方式やKillMode=none/processを使わない。受付はAF_UNIX/空capabilities/strict filesystem/固定write state+socket、Docker socketを隠す。workerは既installerのclosureへ必要な固定アクセスを別unitへ定義し、受付制限を機械コピーしない。

## 実行・保存と異常

root管理のnormalモデルと固定設置先を使い、現在CID/source/imageを照合して既public installerの保持/停止/新起動を呼ぶ。新imageは正式catalogのimmutable OCI refだけ。workerはselected local image IDと再起動後の実image/source/healthを照合し、実稼働までcompletedにしない。起動失敗は保存世代の既recoverへ戻す。cleanup失敗は正常本体を戻さず別結果に保持する。

受付intentとworker受領の間、又は副作用中に失った処理はunknownを保持し、同ID又は別IDへ自動再発行しない。current/previousはledgerへの参照だけで、同target/時刻を要求同一性に使わない。root正常log/公開結果に要求自由本文/秘密/Host絶対pathを返さない。旧ledger/active codeを世代pruneで消さない。

getはworkerの短い台帳公開と競合した時、既ledger排他の解放を待ってから最新原本を読む。worker消失の判定・unknown保存も同じ排他内に保つ。clientの5秒通信期限、受付/workerの非待機排他と一回claimは維持する。通信期限や実worker消失は引き続きunknownとして扱い、設置completedを親の交換成功へ補完しない。

catalog root保存はCentiの専用公式verifier成功後のみ。初回固定期待値と正式自動発行元からの検証供給を分ける。鮮度/失効/過去採用拒否はCenti一正本へ合わせ、未供給/期限切れ/失効ではpublished不明・実行capability false、現在稼働は保持。UIの旧版選択をcatalog巻戻しへ読み替えない。

## 導入と確認

固定source/closure、全実行file/権限、socket/mount/unit、起動停止/削除/旧release戻し、active/unknown保持と実測をRootへ一式返す。root常駐の実Host登録はこのsource差分から発行しない。socket親inodeは維持しleafだけ再作成。codeは別root release＋固定unit pin、参照中codeとledgerを保持、ledger snapshotへ巻戻し無し。

直接試験は偽peer/未知key/過大frame/任意target拒否、同ID再送0/異plan409/並行409、永続受領・worker境界、daemon/本体消失でもworker継続、同ID結果再読、失敗戻しとcleanup分離、root ancestor拒否。人工executorの成功をDocker/Host/署名/実停止へ加算せず、通常main後の隔離実物は別結果で結ぶ。

## 実装の追加境界

Rootコード公開はinstall-container-update-code.pyで固定14fileのimagePath/installPathと最終bytes/hashを検証し、停止したままの一時image containerからだけ取り出す。Source SHA別immutable dir/完全inventory/受入recordを起動前に再検証する。OS toolはPython>=3.11・canonical Node/Docker/Compose/system manager・/usr/bin/ghの公式必要flagsを前提とする。

Host planのexpectedには実mount/specをtarget順で正規化したstorageBinding hashを持つ。生のHostpathをAPIへ返さず、worker受領前/新起動後にprivate normalと実bind/volume名/RO/subpathを照合する。新imageのlocal ID/source/healthyと保存先本人性の確認までcompletedにしない。

catalog(componentId)はHost nativeの選択1recordだけを64KiB以内で返す。publication status/checkedAt/errorはfeed取得確認を表し、catalog署名受入/期限と実稼働版から分ける。定期供給の失敗を更新なしへ置換しない。署名済失効unionを耐久保持、古いcatalog採用/同時刻別digestを拒否、catalog資材公開後にactivation保存が失敗した場合もplanを止めて同資材のrepairでだけ解消する。

専用のtest/helpers/container-updater-systemd.pyは、disposable root/systemd環境で実peer1001/別service cgroup/受付停止後worker継続/同ID再照会/socket親inode保持を確認する入口。engine・署名は人工なのでその証明へ加算しない。本coding環境はUID1000/systemd tools無しで未実行、供給側native VMへ接続する。

## 未配置module archiveの設置

既Unix受付/別workerを再利用する。`moduleInstallCapabilities()`はHostの`moduleInstallProtocol:1`を要求し、旧Host・正式catalog未供給はfalse。`planModuleInstall({planId,catalogSha256,componentId,versionId})`は固定8componentの正式catalog/native platformだけを選ぶ。`startModuleInstall({requestId,planId})`は同startへ`confirmContainerRestart:false`、結果は既`operation(requestId)`へ。任意URL/path/envやrestart指定を増やさない。Mollyの公開operation UUIDは一つ、各install stepは耐久保存した別UUIDをstart/getへ一貫使用する。

plan/start/workerでcatalog鮮度・選択target・実親CID/image/source/volume bindingを再検査する。worker受領前に現在のimmutable imageをnetwork none/UID1001/no-mountで起動し、実Node26/platform・固定installer存在・そのimageの業務互換exportと既mount plannerを確認する。helperへ渡すnormal投影はmount/name/imageとAITERM_STATE_BASEだけで、親の資格環境を渡さない。固定Docker helperは--interactiveでこのJSON投影のstdinを接続する（TTYは使わない）。返るprivate volume名も実normalのRO control mount本人と一致させる。helperのComposeモデルをroot実行へ転用しない。

archive/bundleは正式GitHub release URLだけからroot管理`state/module-incoming/<component>/<SHA>`へsize/hash付きで取得する。redirectも公式HTTPS閉集合、未知origin/port/user情報は拒否。file400・一時dirからNOREPLACE公開・親fsync、再利用時も完全inventory/size/hashを再確認する。現在の同imageで固定`install-<component>-release.py`を実行し、同componentのincoming親をRO公開し、既installerがその下の固定SHAを開く。RW公開は同private volumeだけ。既installerの公式署名/source/runtime/full inventoryとcode→receipt最後の公開をそのまま使う。親serviceのstop/restart/replaceはこのHost工程に含めず、配置完了後に親のprepareRelease→実controllerへ渡す。

containerのcurrent/previous参照は保持し、module設置は別`module-current.json`で同UUID ledgerを参照する。両方とも同ledger/worker lockで排他し、unknownは次要求で越えない。期限・helper非0・結果欠測はunknownを保持し同UUIDで再実行しない。Docker client期限でも実helper終了を推定せず、その設置は要解決として保持する。正常公開後だけ入力cacheを自己回収し、回収失敗は配置成功と分ける。未確定cacheは各module最大4組を保持し、先に原operationを解決する。

初回はこのHost code/現在image内固定installer・socket mountを導入する必要がある。登録済みmodule交換を後発Host口待ちにせず、未配置をprepare成功へ補完しない。新7Python境界（正式選択/入力拒否・同UUID・container排他・限定mount・資格非移送・unknown再送0）とclient/planner3境界は人工I/Oで確認した。実Host/systemd/Docker/署名・対象moduleだけの実交換成立は別の本人受入へ結ぶ。
