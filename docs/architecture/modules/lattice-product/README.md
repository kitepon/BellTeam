# Latticeとの接点

担当：スノーホワイト。Lattice本体（Plan Alice、Store Ludmila、Runtime Tove）と、BellTeamへ約束する公開CLI窓口。

製品内部図の正本は[Latticeの機能図](https://github.com/kitepon/Lattice/blob/main/docs/architecture/function-map.md)。BellTeamとの契約は[dfd-charts-read.md](https://github.com/kitepon/Lattice/blob/main/docs/architecture/dfd-charts-read.md)（a101、K1-K8）。内部図は複製しない。

BellTeam側の使い手はlattice module（フローラ）だけ。接続線の名前 `contract: lattice CLI only (K1-K8, a102): charts list/source, chart set/repo, todo` は次の窓口をまとめる（一覧と詳細は[lattice module](../lattice/README.md#bellteam---lattice-connection-target-task-a102)のK1-K8表）。

| 入口 | 中身 |
| --- | --- |
| `lattice charts list --json` / `lattice charts source --json` | 全工程表の名前・作成者・件数・木と、変更を知らせる不透明なtoken（K1・K2・K3） |
| `lattice chart set` / `lattice chart repo bind, sync` | 工程表の名前と作成者（Latticeが保管）、コード工程表のリポジトリ同期（K4・K7） |
| 席の命令 `plan` `todo` `status` `session-context` `help`、`todo blockers` `todo unblock` `todo notice` | 席が工程表を読み書きする。環境変数 `LATTICE_CHARTS_ROOT` と `LATTICE_PROJECT_ID` で工程表を指す（K5・K6・K8） |

BellTeamは `LATTICE_CHARTS_ROOT` の中を直接読み書きせず、Latticeのソースファイルを読み込まない。Ownerレーン決裁の記録は、BellTeam自身の置き場 `/srv/bellteam/state/lattice-module/` に持つ。

[接続情報](module.json) / [共通の変更手順](../../module-ownership.md)
