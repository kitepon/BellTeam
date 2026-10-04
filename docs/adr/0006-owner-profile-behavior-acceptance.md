# ADR 0006: オーナープロフィールの挙動を受け入れる

- Status: Accepted
- Date: 2026-09-01

## Decision

オーナープロフィールの挙動変更を受け入れる。

- JSON正本、Web API、MCP、Aiterm配送は一つの`OwnerProfile`サービスへ接続する。
- セッション起動と配送の直前に現在値を読み、アバター本体を除いてBot文脈へ添付する。
- 更新によるBot再起動は行わない。
- 左上アバターを設定入口とし、Botと同じ切り抜き部品を使う。
- その他URLは名称とURLの組を順序付きで保存する。

## Evidence

- `evidence/owner-profile/implementation.md`: focused test 57件成功、失敗0件。
- `evidence/owner-profile/ui-verification.md`: デスクトップとモバイルの保存、再表示、アバター反映、横幅、ブラウザエラーを確認。

## Consequences

オーナー情報の変更は次のBellTeam配送から全Botへ届く。共通規範や長期記憶へ現在値を複製しないため、更新時のdriftを作らない。
