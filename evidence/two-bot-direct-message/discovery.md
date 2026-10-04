# 二体Bot直接メッセージ — 発見証跡

取得日: 2026-08-31
対象: `main-server`

## 実測

- OS: Ubuntu 26.04 / Linux 7.0.0-30-generic x86_64
- Docker: 29.6.2
- Docker Compose: 5.3.1
- tmux: 3.6
- Node.js: 24.14.1
- npm: 11.11.0
- Codex CLI: 0.151.0（`@openai/codex`、ChatGPTログイン済み）
- Grok CLI: 1.0.13（公式 `https://x.ai/cli/install.sh` で導入、認証ファイルあり）

認証情報の値は読まず、出力にも残していない。

## 設定入口

- Codex CLI は npm の公式パッケージをコンテナへ固定版で導入する。
- Grok CLI は同梱READMEが示す公式installerを固定版指定で実行する。
- Grok のグローバルMCPは `~/.grok/config.toml` の `[mcp_servers.<name>]` に置く。
- Grok の共通規範は `~/.grok/AGENTS.md` から全プロジェクトへ適用できる。
- Codex のグローバルMCPは `~/.codex/config.toml`、共通規範は `~/.codex/AGENTS.md` に置く。

## 採用構成

- Bot間通信はローカルMCP `sendmessage(target, message)` のみ。
- MCPが共有tmuxソケットを操作し、宛先セッションを必要時に起動してTUIへ直接投入する。
- Bot定義とCLI差分はMCP内部で管理する。
- 認証はイメージへ入れず、コンテナ専用の永続homeへ秘密を表示せず初期投入する。

