# オーナープロフィール依存調査

調査日: 2026-09-01

## 保存と初期化

- `src/bootstrap.mjs`はBot正本と共通規範を初期化し、`src/supervisor.mjs`と`src/mcp-server.mjs`が各サービスを組み立てる。
- オーナープロフィール専用の永続化サービスと保存先は現状存在しない。
- 新しい`OwnerProfile`サービスを`/srv/bellteam/owner/profile.json`へ接続し、supervisorとBot内MCPが同じschemaを使う。

## 配送

- ユーザー会話とBot間直接連絡は`BellTeamMessenger`から`AitermTransport.turn`または`notify`へ到達する。
- ルーム発言は`RoomMessenger`から`AitermTransport.notify`へ到達する。
- Bot予定は`BellTeamMessenger`、ルーム予定は`RoomMessenger`を呼ぶため、予定専用のプロフィール注入は不要である。
- onboardingも`BellTeamMessenger`経由なので同じ配送契約に含まれる。
- `AitermTransport.ensure`がセッション起動を所有し、`dispatch`と`steerActive`が通常配送と実行中ターンへの差し込みを所有する。ここへ現在値を添付すれば全配送経路を一箇所で覆える。

## Web APIとMCP

- `src/http-server.mjs`の`createBellTeamServer`が公開・内部APIを共通実装している。`ownerProfile`依存を追加し、認証済み`GET /api/owner`と`PATCH /api/owner`を公開する。
- `src/mcp-tools.mjs`がMCP契約と呼出しを一元管理している。`get_owner_profile`だけを追加し、Botからプロフィールを変更するMCPは設けない。
- `src/mcp-server.mjs`も同じ保存rootから`OwnerProfile`を初期化してMCP呼出しへ渡す。

## Web UI

- 左上は現在`brand-mark`の固定`BT`表示で、操作機能を持たない。ここをオーナーアバターのボタンへ変更する。
- Bot編集には画像選択、正方形切り抜き、拡大縮小、data URL保存が既にある。切り抜き処理を再利用可能な編集器へまとめ、Botとオーナーの両方から使う。
- その他URLは順序付きの`label`と`url`の行として追加・削除できる設定面にする。

## 固定規範

- `config/common-agents.md`はbootstrap時に各CLIのグローバル指示へ配布される。
- 現在値はここへ書かず、配送された`[BellTeam owner profile]`とMCPの`get_owner_profile`を最新正本として扱う固定規範だけを追加する。

## 実装上の結論

- 永続化正本は`OwnerProfile`一つに限定する。
- プロンプトへの添付はアバター本体を除外する。
- 更新時にBotを再起動しない。`AitermTransport`が配送直前に読み直すため、次の配送から新しい値になる。
- scheduler、messenger、room messengerの既存の経路分岐は変更せず、focused testで集約が維持されることを確認する。
