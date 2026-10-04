# ADR 0010: Throughlineの引き継ぎを通常応答で宣言しない

- Status: Accepted
- Date: 2026-09-02

## Decision

通常のThroughlineでは、引き継ぎの事実と保持ターン数を最初の応答で一度だけ案内する。
BellTeamはBotのprojectを指定して、会話本文を持つ最新sessionの短期記憶を案内なしで取得する。
長期記憶の補足は作らず、起動時の一括注入も行わない。

Throughline旧版がassistant本文へ付けた固定宣言は次回引き継ぎから除外する。ユーザーが同じ
文を引用した内容、宣言後の実際の応答、保存済み原会話は変更しない。

修正版Throughlineは公式npm packageとして公開し、BellTeamは公開版を固定して本番コンテナへ
導入する。現在のGrok sessionには旧命令が残っているため、配備後にベルを一度だけ正規入口から
再起動する。03:00の日次再起動条件と通常メッセージ配送経路は変更しない。

本作業はThroughlineとBellTeamの二つのrepoへ順序付きで書き込むため、
`multi_repo_write_coordination=true`の統括レーンで実行する。他の統括条件はfalseとする。

## Acceptance

- 通常の生成コンテキストには最初の一度だけ案内があり、BellTeamが取得する短期記憶には案内がない。
- assistantの旧固定宣言だけが次回文脈から除外される。
- Throughlineの正式releaseとBellTeam本番更新が成立する。
- 本番がhealthyで、ベルが修正版を使う新しいGrok sessionとして起動する。
