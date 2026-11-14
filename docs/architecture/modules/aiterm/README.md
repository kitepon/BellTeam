# Aiterm/Steerとの接点

担当：エレグ。native起動・設定・実行・観測・認証。

製品図の正本は[Aiterm/Steer設計索引](/srv/bellteam/bots/bot-c2adbe04/docs/refactor-20261102/README.md)、本体との責任・公開契約は[bellteam-boundary.md](/srv/bellteam/bots/bot-c2adbe04/docs/refactor-20261102/bellteam-boundary.md)。現在26図と未実装の提案3図を区別し、編集原本のDOTを製品側で管理する。コード変更時に必要図を製品repoへ移し、旧場所はリンクにする。内部図を複製しない。

## BellTeamへ約束する入口（2026-11-14 Owner：製品の間は契約された入口だけ、a105）

正本は製品repoの `docs/architecture/bellteam-boundary.md` 「公開の入口」（aiterm-mcp 0.70.58。`package.json` の `exports` の表そのものが約束）。旧い総称 `native` は下の名前付きの入口に置き換えた。

| 入口（接続線の名前） | 中身 | BellTeam側の使い手 |
| --- | --- | --- |
| `MCP tools (stdio)` | 起動/送信/観測/close/configure/goal・待機/回答（pty_*, agent_*, claude_agent, agent_auth）と環境変数 `AITERM_STATE_BASE` `AITERM_SESSION_ID` 等 | execution（キロ）、usage（ミカ、agent_auth） |
| `bin: aiterm-wait, aiterm-transcript-read` | 待機の結果と遠隔席の記録の読取り（JSON） | execution（キロ） |
| `bin: aiterm-remote-terminal` | 遠隔端末の status / credential-load / serve | terminals（クラスト） |
| `exports: setup-node, setup-integrations, execution-parent-worker, execution-native-setup/server` | 起動の形、hookの設定、実行の席の入口。選んだ版の根の `exports` から値を読む | runtime（モリー、bd06） |
| `exports: state-compat.json, resume-state-cli` | 置き場の互換宣言、席のcheckpoint復元CLI（nodeで走らせる） | runtime（モリー、bd06） |
| `exports: child-result` | 子の結果の文の頭 `CHILD_RESULT_PREFACE` | conversation（N102の self-turns。置き換えはbd05でキロ） |
| `harness-entries (aiterm-setup)` | CLIの設定へ入れるhookの項目 `bellteam.harness-entries.v1` | runtime（モリー、bd14） |
| `Steer delivery (aiterm-steer-delivery)` | Approval Boxの回答を席へ届ける。約束はSteerの製品正本 | Approval Box（ナユタ） |

約束しない物：`model-handoff-*`、状態の置き場の中の並び、入れたpackageの中のファイル一覧、子の結果の文の2行目以降。BellTeamはこれらを読まない。今のコードにある直接読込みは bd05・bd06 の切替で置き換える。図は切替後の姿を先に示す。

従来の説明：起動/送信/観測/close/configure/goal・待機/回答、agent_auth、setup/updateと既setup exportを含む。実行と設定適用時機はキロ、登録/席実行はエピネル、認証案内はミカ、会話/履歴はN102、共通契約はトロニー。native本人性・入力・vendor/Steer内部はエレグ。未送信・結果不明・受付と完了を保ち、保存modelだけで実動を証明しない。

[接続情報](module.json) / [共通の変更手順](../../module-ownership.md)
