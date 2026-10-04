# BellTeam — このリポジトリで働くAIへの指示

本書はBellTeamプロジェクト固有の正典である。全プロジェクト共通の規範はグローバルの`AGENTS.md`／`CLAUDE.md`が正であり、矛盾する場合は本書を優先する。`CLAUDE.md`は`@AGENTS.md`の1行だけとし、本文は本書だけに置く。構造・パス・起動手順は`README.md`と`docs/current-design.md`が正であり、本書へ複製しない。

## 実装の範囲

- Mac・iPhone・Webで共通化できる処理は共通実装へ置き、OS・UI基盤・画面構成による差だけを個別実装へ置く。
- 安全装置・チェック機構・セキュリティ対策・追加のID体系・永続配送キュー・常時起動は実装しない。必要だと考えた時は、実装せずオーナーへ提案だけを出す。
- 反復再試行はiPhoneアプリのSSE切断・一時的な接続失敗からの復旧だけに限る。認証・設定・応答形式の異常では止めて表示する。
- オーナーが決めた設計・責務境界・登録先は、確認を取らずに上書きしない。変更が必要だと思ったら、変更案を出して合意を得た後だけ行う。

## 予定

- AIを起こす必要のない予定（スクリプト実行・書き出し・到達確認など）はAIへの指示にせず、`command`予定にする。AIの1ターンを機械作業の起動に使わない（オーナー裁定 2026-09-04。チャイムの毎時2本がAIターンとして1日48回起動し、上流障害で待ち行列が詰まった実被弾）。

## 共有ツール（MCP）の登録

- 共有ツールは、必要なBotがそれぞれ自分の席へ登録する。オーナーがBellTeamコンテナへの標準搭載を指示したもの（通話ブリッジ`call-bridge`と、インフラ整備の部屋の担当プロダクト。2026-09-27）だけは、BellTeamが全BotのCLIへ登録する。今はRTK（担当ドリリー）が該当する。
- Botの登録先は、Grokは`--scope project`、ClaudeとCursorはBotフォルダ側の設定とする。Codexはプロジェクト側の設定を読まない（0.151で実測）ため、Codex Botへの登録はオーナーの指示があった時だけ共有設定へ書く。
- BellTeamが各CLIの設定へ書くのは自分が置いた項目（`bellteam`・`aiterm`・`call-bridge`のMCPと、RTKのhook）だけとし、Botが登録した他の項目と残りの節は保持する。
- 本番コンテナの共有設定（`/home/bell`配下の各CLI設定）へは、BellTeamのコードとBot自身だけが書く。開発するAIが手で書かない。
- 共有ツールの合言葉・接続先は`/srv/bellteam/shared/tools/<tool-id>/`に置き、値を文書・会話・commitへ書かない。

## メインサーバーへのSSH（コンテナ→ホスト）

- Botはコンテナ内から`ssh main-server`でホストへ入る。接続先は`host.docker.internal`（compose の`extra_hosts`でホストへ向ける）、ユーザーはホストの`bellteam`（`/etc/sudoers.d/bellteam`でNOPASSWD:ALL。オーナー裁定 2026-09-03、一度撤回のうえ再度許可）。
- 鍵と既知ホストは`runtime/data/shared/tools/ssh/`（コンテナ内`/srv/bellteam/shared/tools/ssh/`）、接続設定は`runtime/home/.ssh/config`。
- ホスト側: ufwで`192.168.240.0/20`→22番を許可、fail2banの`ignoreip`にコンテナのネットワークを追加（`/etc/fail2ban/jail.d/bellteam.local`）。コンテナがsshdに失敗を重ねるとfail2banが締め出す実被弾があった（2026-09-03）。

## 本番と反映

- 本番はssh `main-server`の`/home/kite/BellTeam`。`origin`はGitHubの`kitepon/BellTeam`で、GitHubの`main`を正とする。2026-09-25にサーバーの独立履歴をGitHubの履歴の上へ載せ替えた（旧履歴はサーバーのタグ`server-history-20260925`）。
- BellTeamコンテナの再起動・再作成・停止を伴う操作は、実行前に必ず一度止まり、オーナーの許可を取ってから行う。通常のデプロイも対象とし、作業開始や実装の承認だけで再起動の許可を得たと扱わない。
- 反映はcommitしてから`scripts/deploy.sh`一回で行う。GitHubの`main`へpushし、本番は`git merge --ff-only`で取り込むだけで、本番側でcommitを作らない。本番の作業ツリーに未commitの変更があれば反映を止める。反映するとBot全員が停止し、次のメッセージで起動する。`scripts/deploy.sh`は反映前に処理待ち一覧を`runtime/backups/`へ保存する。止めたBotへ「再開しろ」は自動で送らない。
- `config/bots.json`はGitHubの`main`の内容が本番の台帳になる。変える時はcommitして反映する。
- Node.js・CorepackとCLI（Claude・Codex・Grok・Cursor・Aiterm・Throughline・GitHub CLI）は版を固定しない。`scripts/deploy.sh`は毎回ベースイメージを取得し、キャッシュなしで公式の現行版からビルドする。永続volume上のCursorはコンテナ起動時に公式`cursor-agent update`で更新する。
- Web APIは`http://192.168.1.2:18891/api/...`（`127.0.0.1`ではbindしない）。tokenは本番の`runtime/web.env`の`BELLTEAM_WEB_TOKEN`。

## 試験

- 実装中は`node --test test/<対象>.test.mjs`だけを回す。全試験（`npm test`）は完了時に一度だけ。
