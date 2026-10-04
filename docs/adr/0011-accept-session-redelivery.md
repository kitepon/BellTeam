# ADR 0011: セッション不達時の起動・再配送を本番受入する

## 決定

BellTeamのBot識別子をAitermの専用セッションIDとして使う。そこへ直接配送し、不達時だけ同じBotプロジェクトを同じIDで起動する。Aitermが返したIDをBotプロフィールへ保存し、元のメッセージを一度だけ再送する。

## 根拠

- Aiterm再起動後の`t1`等の再利用により、古い記録が別Botの新しいセッションを指す実害を4種smokeで確認した。
- Bot識別子をセッション名に使えば、追加IDや照合台帳を増やさず衝突をなくせる。
- Claude、Codex、Cursor、Grokを本番の停止状態から起動し、全員の受信と応答を確認した。
- DM、ルーム、ユーザー会話、予定は同じ配送処理を使う。
- Aiterm 0.29.25とBellTeam 111件の試験が成功した。
- セッションの常時起動、追加ID、永続配送キュー、監視、反復再試行は追加していない。

## 未完了

なし。

## 証跡

- [実装・本番検証](../evidence/2026-09-02-session-redelivery.md)
- [受入表](../evidence/2026-09-02-session-redelivery-acceptance.md)
- [現行設計](../current-design.md)
- [現在状況](../current-status.md)
