# セッション不達時の起動・再配送 受入表

| 受入項目 | 結果 | 証跡 |
| --- | --- | --- |
| 4種の停止Botをメッセージ到着時に起動する | 合格 | Claude、Codex、Cursor、Grokの本番smoke |
| 各AIが受信して応答する | 合格 | 3種の確定transcriptとCodexの往復配送ログ |
| 古い自動採番IDを別Botへ誤配送しない | 合格 | Bot識別子を専用セッションIDとして使用 |
| 最後のセッションIDだけをBot単位で保存する | 合格 | `bellteam.bot.v6`を維持、保存項目追加なし |
| 不達時だけ同じBotを起動する | 合格 | transport試験と本番offline開始を確認 |
| IDを保存して同じメッセージを一度だけ再送する | 合格 | transport試験と4種の本番配送で確認 |
| 二度目の不達を成功扱いしない | 合格 | transport試験で例外伝播を確認 |
| DMとルームの共通配送経路へ適用する | 合格 | BellTeam全111試験成功 |
| Cursorの未送信本文を成功扱いしない | 合格 | 長文の画面外末尾を含むAiterm回帰試験 |
| Claudeの起動確認を無人で通す | 合格 | 2段階確認のfocused testと本番Claude smoke |
| 公開版を利用できる | 合格 | Aiterm 0.29.25をnpm、GitHub Release、Official MCP Registryへ公開 |
| 全製品試験 | 合格 | BellTeam 111件、Aiterm 379件中370件成功・OS限定9件skip・失敗0件 |
| 公開後状態 | 合格 | health `ok`、27 Bot、online 0、待機キュー0、エラー0件 |
| 最小構成を維持する | 合格 | 常時起動、追加ID、永続配送キュー、監視、反復再試行を未実装 |

詳細は[実装・本番検証](2026-09-02-session-redelivery.md)を正とする。
