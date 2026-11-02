# 実行環境・更新復旧

責任者：エピネル。

bootstrap、席側短命処理、CLI登録、状態移行、backup/restore、設置と更新実行。OSはエマ、公開はセンチ、本番実行はトロニー。

接続の正本は[module.json](module.json)。全体の[機能図](../../feature-map.md)と[担当・変更手順](../../module-ownership.md)から、呼出元と依存先を辿る。

## 現行図の正本

- [起動と席の実行機構](execution.md)
- [CLI登録・共有設定の所有と完了](cli-registration.md)
- [installer・状態移行・backup/restore](recovery.md)
- [Aiterm H1のoffline保存・起動前採用の接続候補](resume.md)

runtime-detailsとdistribution-detailsのruntime所有章はここへ移管し、旧箇所はリンクにした。配布物作成・build・promotionの図はdistributionに残す。サービス組立て、メンバー構造、記憶形式、native内部、各アプリの図は各所有者の正本へ辿る。

## 公開入出力と責任

| 窓口 | 入力・出力 | 所有・接続 |
| --- | --- | --- |
| lifecycle | 起動条件/組立て→start/closeと失敗 | bootstrap/supervisorの実行機構。全体サービス組立てはintegration |
| seat-process | 操作と最小入力→結果/error、画像stream | UID/環境/取消/stdioの機構。native制御はexecution/Aiterm |
| project-files | ProjectFiles公開method/args→結果/error | 席proxyだけ。メンバー構造/指示の内容はmembers |
| cli-registration | 現在台帳のid/project、native公開登録、通話有効状態→設定完了Promise/error | 同じSeatRuntimeで登録操作を直列化。管理外項目を保持 |
| update | 固定配布物と設置設定→設置/移行/backup/restoreの実行結果 | 配布版/imageはdistribution。本番操作はトロニー。アプリからの商用更新は設計中 |

商用更新の受付・停止を跨ぐ実行・結果確認は[設計案](commercial-update-design.md)を参照。実行主体/配置/APIは未合意で、新機能のコードは未実装。

所有するのは管理CLI節・trust・hook登録、席の一時画像、移行/復旧の実行状態。台帳・ProjectFiles内部・記憶形式・native state・配布版対応表は各所有者の窓口を使う。`run-seat-runtime`は操作dispatchだけを持ち、ProjectFilesと記憶の処理は各機能へ渡す。登録修理はruntime所有の既存ファイル内で完結し、members/usage内部の編集を要しない。

CLI登録図はwriter所有と完成JSON公開を含む。起動/席実行/移行/復旧図は実装の意味を変えず、正本の場所と責任を明示した。公開窓口/接続先は変わらず、全体図の生成結果は不変。Throughline DB/WALのmtimeへ依存する席実行部の分離はN102のconsumer切替と合わせる残件。機能全体のsource分離や本番反映を完了扱いにしない。
