# セッション不達時の起動・再配送

## 結論

BellTeamは、Bot識別子をAitermの専用セッションIDとして使う。記録に古い`t1`等が残っていてもそこへ送らず、`bot-...`へ直接配送する。不達時だけ同じBotプロジェクトを同じ専用IDで起動し、Aitermが返したIDを`bot.json`へ保存して、元のメッセージを一度だけ再送する。

これにより、Aiterm再起動後の自動採番が古いIDと衝突して別Botへ届く問題を、保存項目を増やさず解消した。DM、ルーム、ユーザー会話、予定は同じ配送層を使う。

## Aiterm

- Cursorの長文pasteは、送信文の末尾が画面外でも本文入りcomposerを未submitとして検出し、成功receiptを返さない。
- Codexの起動時更新確認は無人起動で表示しない。非対話型の更新通知は入力を妨げない。
- Claudeの無人起動時に順番に現れるBypass Permissions確認とworkspace trust確認を起動処理内で進め、初回promptまで届ける。
- 全試験: 379件中370件成功、対象OS限定9件skip、失敗0件。
- main CI: macOS、Linux、Windowsの3環境で成功。
- 公開版: `aiterm-mcp@0.29.25`。
- GitHub Release: <https://github.com/kitepon/aiterm-mcp/releases/tag/v0.29.25>
- main CI: <https://github.com/kitepon/aiterm-mcp/actions/runs/33595655429>
- release CI: <https://github.com/kitepon/aiterm-mcp/actions/runs/33596119522>
- Official MCP Registry公開workflow: <https://github.com/kitepon/aiterm-mcp/actions/runs/33596175931>

## BellTeam

- Botプロフィールschemaは`bellteam.bot.v6`のまま、最後に確認されたセッションIDだけを永続化する。
- 起動時は`session_name=bot.id`をAitermへ渡す。記録済みの古い自動採番IDは配送先に使わない。
- 不達時の起動後、返されたIDを保存して同じメッセージを一度だけ再送する。二度目の不達は失敗として返す。
- セッションの常時起動、追加ID、永続配送キュー、監視、自動反復再試行は実装していない。
- ローカル全111試験、本番focused test 18件が成功した。
- ローカルと本番の製品ファイル51件のSHA-256 manifestは`8df2ee2a8a9e9557532aadec467741cf9ca876a575f9d99438ee196c58902653`で一致した。

## 本番4ハーネスsmoke

全対象がoffline、待機キュー0の状態から正規DM経路で同時に配送した。途中の起動だけは合格にせず、受信マーカーとAI自身の確定応答または返信記録まで確認した。

| ハーネス | Bot | 旧記録 | 専用セッション | 実測結果 |
| --- | --- | --- | --- | --- |
| Claude | `bot-12c89cad` | `bot-12c89cad` | `bot-12c89cad` | `FINAL_CLAUDE_20260902`を受信し、確定返信を回収 |
| Codex | `bot-6db4add6` | `t1` | `bot-6db4add6` | 停止後の再試験で`FINAL2_CODEX_20260902`を受信し、ベルへの同一マーカー返信を配送ログで確認 |
| Cursor | `bot-1788dc47` | `t3` | `bot-1788dc47` | `FINAL_CURSOR_20260902`を受信し、確定返信を回収 |
| Grok | `bot-03480f75` | `t1` | `bot-03480f75` | `FINAL_GROK_20260902`を受信し、確定返信を回収 |

Codexの往復は`runtime/data/logs/direct-messages.jsonl`の配送ID`54e3dfa4-2308-4ecd-9995-2e3ddb4eeb8d`と返信ID`de1dab62-1b11-4fe9-9268-403eca378dfb`で確認した。

## 配備後状態

- 本番製品commit: `b03e1ab`
- container image: `sha256:22b13b4e5c7cccefe01d790407f037595196003b267170f045142e58c66eef02`
- コンテナ内Aiterm: `0.29.25`
- 公開トップ: HTTP 200
- 公開`/healthz`: HTTP 200、`status: ok`
- 配備後のエラー行: 0件
- 試験用Codex Botは削除済み。本番は27 Bot、online 0、待機キュー0へ戻した。
- 実在Botの設定、記憶、会話、予定は削除していない。
