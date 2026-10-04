# ADR 0007: オーナープロフィール実装を完了する

- Status: Accepted
- Date: 2026-09-01

## Decision

`owner-profile-core-20260901`と`owner-profile-ui-20260901`を受け入れ、オーナープロフィール実装を完了とする。

受入条件は`evidence/owner-profile/acceptance-matrix.md`の全項目で成立した。focused test、デスクトップ・モバイル画面確認、82件の最終回帰、本番配備、公開後smoke、現行設計と現在状況への還流が完了している。

## Remaining constraint

本番に登録Botが0体のため実Bot配送smokeは行っていない。新しいBotを検証目的だけで作ることは非目標とし、配送層の契約テストを受入根拠とする。この制約は機能の利用開始後も欠陥を隠すフォールバックではなく、現在の本番データ状態である。
