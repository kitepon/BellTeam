# BellTeam — このリポジトリで働くAIへの指示

本書は BellTeam リポジトリ固有の正典である。全プロジェクト共通の規範はグローバルの `AGENTS.md`／`CLAUDE.md` が正であり、矛盾する場合は本書を優先する。`CLAUDE.md` は `@AGENTS.md` の 1 行だけとし、本文は本書だけに置く。

関連する正本（本書へ複製しない）：
- 構造・導入・起動手順：[README.md](README.md)、[docs/current-design.md](docs/current-design.md)
- 常駐 Bot 共通の製品規範：[config/common-agents.md](config/common-agents.md)
- 機能図・担当と変更手順：[docs/architecture/feature-map.md](docs/architecture/feature-map.md)、[docs/architecture/module-ownership.md](docs/architecture/module-ownership.md)
- ドキュメント全体の索引：[docs/README.md](docs/README.md)

## 実装の範囲

- Owner rule (2026-11-07; Aiterm/cloud-AI commands): Never block on an unknown command outcome. A command to Aiterm/a cloud AI that lands twice is harmless; stopping is the harm. Commands are idempotent by content (and UUID where the counterpart dedups); on unknown, proceed and re-apply. No `*_UNCONFIRMED` / 'possible' / 'unknown' refusal may gate a dispatch, a launch, a stop or an operator restart; such facts are recorded and shown, never used as a lock. A guard is added only if its state diagram shows an exit the server can take by itself; 'unknown' is not a state in the model — only desired and actual are.
- コード修正前に [docs/architecture/feature-map.md](docs/architecture/feature-map.md) から担当と接続先の機能図を読み、図の変更要否を判断してから全 caller・試験・設定を含む範囲を決める。コードと必要な図を同じ差分で更新する。担当と図の正本は [docs/architecture/module-ownership.md](docs/architecture/module-ownership.md) に従う。
- Mac・iPhone・iPad・Windows・Linux・Android で共通化できる処理は共通実装へ置き、OS・UI 基盤・画面構成による差だけを個別実装へ置く。
- 安全装置・チェック機構・セキュリティ対策・追加の ID 体系・永続配送キューは実装しない。必要だと考えた時は、実装せずオーナーへ提案だけを出す。
- 補助プログラムの常駐・待受けは実装してよい。待受けるだけのために AI を常時起動したり、変化のない確認を繰り返して AI を起こし続けたりしない。AI が不要な待受け・確認は、補助プログラムや `command` 予定で行う。
- モバイル回線などの通信不良そのものはバグと扱わない。通信不良が起こる前提で、アプリは接続状態に応じて適切に動作し、回復を待ち、通信復旧後に適切に復帰する。対処や復帰が適切でないアプリの挙動は修理対象とする。通信を必要とする機能が使えないことと、アプリの対処不良を区別する。
- 一時的な接続・取得失敗（SSE 切断を含む）からの復旧は全クライアントを対象とし、失敗理由と再試行状態を表示し、待機間隔に上限を設けたバックオフで自動再試行を続ける。回数の上限で打ち切らない。手動再試行は待機中の次の試行を直ちに実行し、同じ処理を並列に増やさない。キャンセル・サインアウト・接続先変更では旧処理を終了する。認証拒否では権限のない接続を防ぐため当該接続を中断し、有効な認証情報に更新されたら自動再開する。設定・応答形式の異常も理由を表示し、復旧可能な処理を打ち切る理由にはしない。非冪等な要求は二重実行を防ぐため自動再送せず、実行結果を確認する。
- オーナーが決めた設計・責務境界・登録先は、確認を取らずに上書きしない。変更が必要だと思ったら、変更案を出して合意を得た後だけ行う。

## 予定

- AI を起こす必要のない予定（スクリプト実行・書き出し・到達確認など）は AI への指示にせず、`command` 予定にする。AI の 1 ターンを機械作業の起動に使わない（オーナー裁定 2026-09-04）。

## 共有ツール（MCP）の登録

- 共有ツールは、必要な Bot がそれぞれ自分の席へ登録する。オーナーが BellTeam コンテナへの標準搭載を指示したもの（通話ブリッジ `call-bridge` とインフラ整備の部屋の担当プロダクト、2026-09-27。現在は RTK（担当ドリリー）が該当）だけは、BellTeam が全 Bot の CLI へ登録する。RTK の hook は、テストの関所（testgate、担当シラツル、2026-10-13 オーナー承認 K-X4DGPJ）が共通の置き場にある設置では関所ごしに呼ぶ（登録方式の正本は [docs/architecture/modules/runtime/cli-registration.md](docs/architecture/modules/runtime/cli-registration.md)）。
- Bot の登録先は、Grok は `--scope project`、Claude と Cursor は Bot フォルダ側の設定とする。Codex はプロジェクト側の設定を読まない（0.151 で実測）ため、Codex Bot への登録はオーナーの指示があった時だけ共有設定へ書く。
- BellTeam が各 CLI の設定へ書くのは自分が置いた項目（`bellteam`・`aiterm`・`call-bridge`・`lattice-mcp` の MCP と、公開契約 E1 で運ばれる hook 項目）だけとし、Bot が登録した他の項目と残りの節は保持する。
- 本番コンテナの共有設定（`/home/bell` 配下の各 CLI 設定）へは、BellTeam のコードと Bot 自身だけが書く。開発する AI が手で書かない。
- 共有ツールの合言葉・接続先は `/srv/bellteam/shared/tools/<tool-id>/` に置き、値を文書・会話・commit へ書かない。

## メインサーバーへの SSH（コンテナ → ホスト）

- Bot はコンテナ内から `ssh main-server`（ユーザー `bellteam`、`NOPASSWD:ALL`）でホストへ入る。鍵は `runtime/data/shared/tools/ssh/`、接続設定は `runtime/home/.ssh/config`。ホスト側の `ufw` / `fail2ban` 設定などの詳細は [docs/host-ssh.md](docs/host-ssh.md) を参照。

## 本番と反映

- 本番は `ssh main-server` の `/home/kite/BellTeam`。`origin` は GitHub の `kitepon/BellTeam` で、`main` を正とする（旧サーバー独立履歴はタグ `server-history-20260925`）。
- BellTeam コンテナの再起動・再作成・停止を伴う操作は、実行前に必ず一度止まり、オーナーの許可を取ってから行う。通常のデプロイも対象とし、作業開始や実装の承認だけで再起動の許可を得たと扱わない。例外は、会話の部品（`conversation-entry`）が終了したまま 5 分戻らない時だけとし、外部復旧担当（ベル）は許可なしで、記録を保存してから現行の正規設定のまま本体コンテナだけを作り直す。image と設定は変えず、結果はトロニーへ報告する（オーナー裁定 2026-11-05）。
- 反映は commit してから `scripts/deploy.sh` 一回で行う。GitHub の `main` へ push し、本番は `git merge --ff-only` で取り込むだけで、本番側で commit を作らない。本番の作業ツリーに未 commit の変更があれば反映を止める。反映すると Bot 全員が停止し、次のメッセージで起動する。`scripts/deploy.sh` は反映前に処理待ち一覧を `runtime/backups/` へ保存する。止めた Bot へ「再開しろ」は自動で送らない。
- 内部本番を含む BellTeam 更新は、必ず製品試験担当センチへ対象と差分を渡し、必要な事前試験と受入結果を受けて進める（配布・image 実装の担当はモリー、本番実行判断はトロニー）。可能な限り商用コンテナを内部で先に使い、`BELLTEAM_DEPLOY_IMAGE=repo@sha256:digest` と既存 quiet 対象を指定する経路では、受け入れた同じ image を再 build せず使う。内部 profile 等の外付け差分は [distribution/internal/README.md](distribution/internal/README.md) に従う。未変更 public 構成と内部構成を混同しない。
- `config/bots.json` は GitHub の `main` の内容が本番の台帳になる。変える時は commit して反映する。
- コンテナ image に同梱する基盤（Node.js・Corepack・Aiterm・Throughline・GitHub CLI・1Password CLI・mcp-lazy 等）は、特別な理由がある固定品（`Dockerfile` 参照）を除き版を固定せず、商用候補 build 時にキャッシュなしで公式現行版を導入する。AI CLI 本体（Claude Code・Codex・Grok・Cursor）はサーバー image に同梱せず、利用者がアプリの「AI の認証」から `/home/bell/.local` へ導入・更新する（a451、オーナー裁定 2026-11-19）。`bellteam-update-cursor` は互換のための空入口として残る。Claude Code は席で自動更新させない（`DISABLE_AUTOUPDATER=1`）。
- API 入口は `http://192.168.1.2:18891/api/...`（`127.0.0.1` では bind しない）。token は本番の `runtime/web.env` の `BELLTEAM_WEB_TOKEN`。

## 試験

- 機能図と現行設計から、変更する機能の入出力と直接の呼出境界を特定し、その契約に関係する試験だけを実行する。
- 全試験を定型の完了条件にしない。機能をまたぐ契約を変更するなど、範囲を絞れない具体的な理由がある場合だけ試験範囲を広げる。

## 会話の引き継ぎ

- Throughline で会話が替わった時の最初の操作は、`call_list` で引き継ぐ通話を確かめ、使っている通話すべてへ `call_send` で移動を知らせることだけとする。他の作業はその後に行う。
- 移動の連絡には担当者・通話 ID・新しい会話 ID・返答待ちの内容を書く。会話 ID は実測した値だけを書く（Claude Code は `CLAUDE_CODE_SESSION_ID`）。通常の返信へ移動の連絡を兼ねさせない。
