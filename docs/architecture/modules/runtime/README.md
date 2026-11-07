# 実行環境・更新復旧

責任者：モリー（2026-11-08にエピネルから移管）。

bootstrap、席側短命処理、CLI登録、状態移行、backup/restore、設置と更新実行。OSはエマ、公開はセンチ、本番実行はトロニー。

接続の正本は[module.json](module.json)。全体の[機能図](../../feature-map.md)と[担当・変更手順](../../module-ownership.md)から、呼出元と依存先を辿る。

## 現行図の正本

- [起動と席の実行機構](execution.md)
- [記憶の固定版席runnerと実子終端](memory-process.md)
- [共通の有限IPCとstream](module-ipc.md)
- [usage・diagnosticsの固定Cとlock本人性](module-start.md)
- [固有channelを載せる共通child世代controller](module-process.md)
- [業務moduleのinstalled readerと固定wrapper](module-release.md)
- [executionの固定host factory読込](execution-loader.md)
- [execution親の選択保存ACK](execution-adoption.md)
- [CLI登録・共有設定の所有と完了](cli-registration.md)
- [installer・状態移行・backup/restore](recovery.md)
- [Runtime hot updates: CLIs/Throughline; Aiterm via body image](runtime-updates.md)（Z-b2、slice Aを実装）
- [箱同梱のmodule導入プログラム](module-installer.md)（実装中、標準Docker方式）
- [アプリからcontainerを更新するHost受付とworker](container-update.md)
- [箱同梱の本体更新serviceとDocker独立worker](container-update-bundled.md)（source実装、正式供給・公開実物は別工程）
- [Aiterm H1のoffline保存・起動前採用の接続候補](resume.md)
- [Web受付固定資材の配置とdescriptor](web-gateway-release.md)
- [membersの固定C・lease相関・逆effect・席writer](members-process.md)（source実装、通常結合・実物は別工程）
- [通知の固定資材・起動・writer排他](notifications-release.md)（旧P1の両native受入済み。WebPush P2は別source・新受入待ち、本番未反映）

runtime-detailsとdistribution-detailsのruntime所有章はここへ移管し、旧箇所はリンクにした。配布物作成・build・promotionの図はdistributionに残す。サービス組立て、メンバー構造、記憶形式、native内部、各アプリの図は各所有者の正本へ辿る。

## 公開入出力と責任

| 窓口 | 入力・出力 | 所有・接続 |
| --- | --- | --- |
| lifecycle | 起動条件/組立て→start/closeと失敗 | bootstrap/supervisorの実行機構。全体サービス組立てはintegration |
| seat-process | 操作と最小入力→結果/error、画像stream | UID/環境/取消/stdioの機構。native制御はexecution/Aiterm |
| project-files | ProjectFiles公開method/args→結果/error | 席proxyだけ。メンバー構造/指示の内容はmembers |
| cli-registration | 現在台帳のid/project、native公開登録、通話有効状態→設定完了Promise/error | 同じSeatRuntimeで登録操作を直列化。管理外項目を保持 |
| update | 固定配布物と設置設定→設置/移行/backup/restoreの実行結果 | 配布版/imageはdistribution。本番操作はトロニー。アプリ更新のHost sourceはcontainer-updateへ分離 |

商用更新の受付・停止を跨ぐ実行・結果確認は[設計案](commercial-update-design.md)を参照。Host限定受付・独立worker・固定catalog接続は[container更新](container-update.md)のsourceへ実装。正式供給やHost導入が未成立の設置では実行能力を無効とし、旧設計案の未合意を実装済みの接点へ混ぜない。

所有するのは管理CLI節・trust・hook登録、席の一時画像、移行/復旧の実行状態。台帳・ProjectFiles内部・記憶形式・native state・配布版対応表は各所有者の窓口を使う。`run-seat-runtime`は操作dispatchだけを持ち、ProjectFilesと記憶の処理は各機能へ渡す。登録修理はruntime所有の既存ファイル内で完結し、members/usage内部の編集を要しない。

CLI登録図はwriter所有と完成JSON公開を含む。起動/席実行/移行/復旧図は実装の意味を変えず、正本の場所と責任を明示した。公開窓口/接続先は変わらず、全体図の生成結果は不変。Throughline DB/WALのmtimeを読む旧席窓口は除去し、N102の公開observer-check consumerと同時に採用する。機能全体のsource分離や本番反映を完了扱いにしない。

## 全module共通runnerとの境界

共通交換runner/controller・排他・世代とclose-drain/実OS子終端はruntimeのmodule-runner窓口が持つ。既各controllerをこの公開機構へ揃え、業務writer/factory/DTOは各moduleへ残す。親のplan/同UUID step ledgerとcomponent adapterの組立はintegration、配布資材/source検証はdistribution。未提供factory/runnerを組立てただけで交換成功や耐久完了へ投影しない。


The 2026-11-07 durable job / real readiness / restart-limit contract is canonical in [update-jobs.md](update-jobs.md). It supersedes unknown-as-job-state and worker-bound-only acceptance text for new jobs. Legacy historical receipts remain unchanged.
