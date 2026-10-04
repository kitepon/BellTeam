# オーナープロフィール受入表

| 受入条件 | 結果 | 根拠 |
|---|---|---|
| 左上アバターから設定画面を開く | 合格 | `evidence/owner-profile/ui-verification.md` |
| アバター、名前、プロフィール、X、GitHub、その他URLを保存・再表示する | 合格 | `evidence/owner-profile/ui-verification.md` |
| GitHubプロフィールURLを正本にする | 合格 | `test/owner-profile.test.mjs` |
| `/srv/bellteam/owner/profile.json`だけを永続化正本にする | 合格 | `src/owner-profile.mjs`、`evidence/owner-profile/deployment.md` |
| Web APIとMCPが同じ正本を返す | 合格 | `test/http-server.test.mjs`、`test/mcp-tools.test.mjs` |
| セッション起動と全配送へ現在値を自動添付する | 合格 | `test/aiterm-transport.test.mjs`、既存messenger・room・scheduler focused test |
| 共通規範へ現在値を複製しない | 合格 | `config/common-agents.md`、`docs/current-design.md` |
| 更新後はBot再起動なしで次の配送から反映する | 合格 | 配送直前読込の実装、`test/aiterm-transport.test.mjs` |
| 既存Bot、記憶、RAG、会話、予定を維持して本番反映する | 合格 | `evidence/owner-profile/deployment.md`、`docs/current-status.md` |

最終回帰は82件成功、失敗0件、skip 0件。本番はHTTP 200、コンテナhealthy、製品ファイル30件一致である。
