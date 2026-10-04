# チャット返信修正証跡

観測日: 2026-09-01

- 原因: Grokの通常回答と、Bot自身が古い指示に従って`sendmessage(target="user")`した回答を別々に保存し、さらにAitermの表示用メタデータ付き本文を会話へ流していた。
- Aiterm 0.29.10で`pty_read(mode="agent_transcript")`の構造化結果を追加し、`structuredContent.text`を確定回答だけにした。旧来の表示用テキストは互換のため維持した。
- BellTeamは通常会話を通常出力で返す指示へ統一し、同じターン中にBotが明示送信した場合はその1件を回答として採用する。
- `npm test`: BellTeam 35件成功、失敗0件。Aiterm 358件中349件成功、OS固有9件skip、失敗0件。
- Aiterm 0.29.10: npm、GitHub Release、Official MCP Registryへの公開成功。
- 本番: `b919b7e`をメインサーバーへfast-forwardし、Aiterm 0.29.10を含むコンテナを再構築。内部・公開`/healthz`とコンテナhealthyを確認した。
- 実チャット: ユーザー送信1件に対しBot返答は`修正確認`の1件だけで、`[agent_transcript`を含まないことを確認した。
- 既存の壊れた返答4件と試験2件だけをID指定で除去した。除去前の全ログは`runtime/data/logs/direct-messages.jsonl.bak-20260901T000556-chat-reply-fix`へ保存し、会話API上の内部文字列は0件になった。
