# Approval Boxとの接点

担当：ナユタ。承認と回答配送の公開接点。

製品図の正本は[受入候補4a4f0e1の設計索引](https://github.com/kitepon/approval-box/blob/4a4f0e1e3e85ff784e9af6d62876aa2b324aa322/docs/refactoring/README.md)。全体→7詳細→flows→code索引へ辿る。PR15候補であり、本番反映済みとしない。[接点の保守手順](/srv/bellteam/bots/bot-4366a50b/docs/approval-box/architecture-maintenance.md)を参照し、内部図を複製しない。

## BellTeamへ約束する入口（2026-11-14 Owner：製品の間は契約された入口だけ、a105）

正本は製品repoの `docs/architecture/connection-export.md` と `harness-entries.md`。旧い総称 `public` は次の名前付きの入口に分けた。

| 入口（接続線の名前） | 中身 | BellTeam側の使い手 |
| --- | --- | --- |
| `connection export (approval-box connection export --json)` | 安定パス `/home/bell/.approval-box/bin/approval-box` の `connection export --json`、`approval-box.connection.v1` `{schema, server, token}`。私有configは読まない | usage（ミカ、bd02。秘密の承認の所有者） |
| `version --json (capabilities)` | `approval-box version --json`、capability `bellteam-requester-wake`。席が閉じていても申請者へsendmessageで起こす版かを知る | execution（キロ、bd03、IdleSessions） |
| `harness-entries (approval-box)` | `approval-box harness-entries --json`、`bellteam.harness-entries.v1`。BellTeamがCLIファイルの唯一のwriterとして書く | runtime（モリー、bd14） |
| `connector /v1 (HTTP)` | 既存のHTTP接続 `/connector/v1`（decisions、fetched、connection） | integration（モリー、OLRWの承認確認）、execution（キロ、実行除外の申請）、lattice（フローラ、Ownerレーンの決裁） |

逆向きは `HTTP/MCP`（BellTeamの公開MCP `sendmessage` で申請者の席を起こす）と `Steer delivery`（Aiterm）。Approval Boxの設定ファイル、内部module、DBをBellTeamは読まない。

公開窓口は製品docs/api.mdのsession /v1、connection /connector/v1、remote POST /mcp、connector stdio MCP/CLI。診断はdocs/diagnostics.md。製品Web/APNs/DB/connectorはナユタ、BellTeam質問/通知はミカ、会話受付はN102、実行はキロ、登録はエピネル。配送unknownを成功へ変えない。

[接続情報](module.json) / [共通の変更手順](../../module-ownership.md)
