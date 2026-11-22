# 提出済み認証コードの一回消費（退役済み）

所有ミカ。2026-11-22 退役（a508）。親側の撤去はMolly（a490q4、PR #2305、[submitted-secret-caller.md](../integration/submitted-secret-caller.md)）。

2026-11-05の復旧は、Ownerが提出した認証コード一件（request `009fedc7-410a-4b15-ae0b-3d44ba510515` / tool `claude-rabbit9-auth-20261105`）を、元sessionへ一回だけ入力するためのものだった。この一件の消費にしか使わない経路であり、次の理由で残さない。

- 認証コードは一回限りで数分で失効する。11-05の提出は、今は消費できない。永続claim（`wx`、再送しない）が二回目も止める。
- 承認の検査（Approval Box決裁K-3JM9PS / K-6782UMの実読取り）は、Approval Box `/v1` の旧決裁が消える（約12-12）と通らない。固定した期待値だけを信じる形には**しない**（期待値は「こうあるはず」で、Ownerが答えた証拠は実読取りだけ）。デーモンでの出し直しもしない（出し直しても消費できるものが無い）。
- 通らない門を死んだコードとして残さず、取り除く。

## 取り除いたもの

| 取り除いた | 内容 |
| --- | --- |
| `src/usage/submitted-secret-consumer.mjs` | 一回claim・値読取り・固定consume |
| `src/usage/submitted-secret-rabbit-client.mjs` | 固定Rabbit client（ssh stdin） |
| `src/submitted-secret-approval.mjs` / `-bridge.mjs` / `-owner.mjs`、`scripts/verify-submitted-secret-approval.mjs` | 決裁K-3JM9PS / K-6782UMの固定仕様と実読取り検査 |
| `POST /api/secret-requests/:id/consume-claude-code`（`src/usage/http-api.mjs`） | 内部専用route。今は他の未知のpathと同じ404 |
| `authCodeChallenge`（`src/auth-ui.mjs`） | 上のrouteと消費の部品だけの検査 |
| 各試験 | `submitted-secret-approval*`・`submitted-secret-consumer` |

## 残るもの（変えない）

通常の秘密保存・通知・`oneTime`の取り出し（[secret-credentials.md](secret-credentials.md)）、既setup入力の内部拒否、`SecretRequests.resolveValue`（`secret-use`・`feature-settings`が使う）。提出済みrequestの秘密を新しく消費する必要が出たら、新しい決裁と新しい固定仕様から設計し直す。
