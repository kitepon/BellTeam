# ADR 0005: オーナープロフィールを構造化正本から全配送へ添付する

## Decision

オーナープロフィールは`/srv/bellteam/owner/profile.json`を唯一の正本とし、共通規範へ現在値を複製しない。BellTeamはWeb APIとMCPから同じ正本を公開し、セッション起動と全配送文脈へアバター本体を除く最新プロフィールを自動で添付する。

本作業は永続化、公開API、配送文脈、UI、本番受入が順に成立して初めて完了するため、`chained_acceptance=true`の統括レーンで実行する。他の統括条件はfalseとする。

## Consequences

- 稼働中のBotも次のBellTeam配送でプロフィール更新を受け取れる。
- Botはプロフィール値を長期記憶や共通規範から推測する必要がない。
- URLとプロフィールschemaの検証責務はOwnerProfileサービスへ集約される。
- プロフィール更新だけではBotセッションを再起動しない。
