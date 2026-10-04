# APIエラーで打ち切られたターンの検知

## 目的

上流API（Anthropic・xAI）の障害でBotのターンが打ち切られた時、BellTeamが「処理中」のまま止まらず、配送失敗として画面に出るようにする（オーナー裁定 2026-09-04「Claudeもやってくれ。Grokもだな」）。

## 原因

- Claude CodeはAPIエラー（529 Overloaded等）でターンを打ち切る時にStop hookを走らせない。Aitermは完了をStop hookの結果だけで判定していたため、永久に未完了を返し続けた（2026-09-03、チャイムの席で70分の待機と後続予定の詰まり）。
- Grok CLIはエラー終了時に`turn_ended outcome=error`を記録するが、Aitermは`completed`と`cancelled`だけを終了として扱っていた。

## 実測（2026-09-04）

- チャイムの会話記録に`type:"assistant", isApiErrorMessage:true, apiErrorStatus:529`の行が残っており、Stop hookの結果ファイルは空だった。
- 手元のGrokイベント記録に`turn_ended outcome=error`が17件あった。
- Cursorは`turn_ended`のstatusを問わず既に終了を返す。Codexはエラー終了の記録例が手元に無く、判別方法を決められない。

## 変更範囲

- Aiterm 0.31.0: waitの結果に`error`（exit 7、`error`にエラー本文）を追加。Claudeは観測開始後に増えた会話記録行の`isApiErrorMessage`、Grokは`turn_ended outcome=error`で返す。
- BellTeam: `error`を受けた配送を`AITERM_TURN_ERROR: <本文>`で失敗にする。画面は既存の「配達失敗」表示のまま。

## 非目標

- 自動再送・自動再起動・タイムアウト。
- Codexのエラー終了検知（記録形の実測が先）。

## 受入条件

- 実セッションの会話記録へAPIエラー行が追加されると、Aitermのwaitが`error`で返る（開発版で実機確認済み）。
- BellTeamの配送記録が`failed`になり、後続の待ち行列が流れる。

## 実測結果（2026-09-04）

- Aiterm 0.31.0を公開し、BellTeam本番へ反映した（Registry登録はnpm遅延で一度失敗し、再実行で成功）。
- 本番のチャイム（Claude）へ通常メッセージを送り、返答と配送記録`delivered`を確認した。通常のターン完了は従来どおり。
- APIエラー終了そのものは本番で人為的に起こせないため、開発版で実起動したClaude席の会話記録へ529の行を追加し、waitが`error`と本文を返すことを確認した。
