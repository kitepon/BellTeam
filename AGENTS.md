# BellTeam — このリポジトリで働くAIへの指示

本書はBellTeamプロジェクト固有の正典である。全プロジェクト共通の規範はグローバルの`AGENTS.md`／`CLAUDE.md`が正であり、矛盾する場合は本書を優先する。`CLAUDE.md`は`@AGENTS.md`の1行だけとし、本文は本書だけに置く。構造・パス・起動手順は`README.md`と`docs/current-design.md`が正であり、本書へ複製しない。

## 実装の範囲

- コード修正前に `docs/architecture/feature-map.md` から担当と接続先の機能図を読み、図の変更要否を判断してから全caller・試験・設定を含む範囲を決める。コードと必要な図を同じ差分で更新する。担当と図の正本は `docs/architecture/module-ownership.md` に従う。

- Mac・iPhone・Webで共通化できる処理は共通実装へ置き、OS・UI基盤・画面構成による差だけを個別実装へ置く。
- 安全装置・チェック機構・セキュリティ対策・追加のID体系・永続配送キューは実装しない。必要だと考えた時は、実装せずオーナーへ提案だけを出す。
- 補助プログラムの常駐・待受けは実装してよい。待受けるだけのためにAIを常時起動したり、変化のない確認を繰り返してAIを起こし続けたりしない。AIが不要な待受け・確認は、補助プログラムやcommand予定で行う。
- モバイル回線などの通信不良そのものはバグと扱わない。通信不良が起こる前提で、アプリは接続状態に応じて適切に動作し、回復を待ち、通信復旧後に適切に復帰する。対処や復帰が適切でないアプリの挙動は修理対象とする。
- 通信不良時にも全機能が動くことは要求しない。通信を必要とする機能が使えないことと、アプリの対処不良を区別する。
- 反復再試行はiPhoneアプリのSSE切断・一時的な接続失敗からの復旧だけに限る。認証・設定・応答形式の異常では止めて表示する。
- オーナーが決めた設計・責務境界・登録先は、確認を取らずに上書きしない。変更が必要だと思ったら、変更案を出して合意を得た後だけ行う。

## 予定

- AIを起こす必要のない予定（スクリプト実行・書き出し・到達確認など）はAIへの指示にせず、`command`予定にする。AIの1ターンを機械作業の起動に使わない（オーナー裁定 2026-09-04。チャイムの毎時2本がAIターンとして1日48回起動し、上流障害で待ち行列が詰まった実被弾）。

## 共有ツール（MCP）の登録

- 共有ツールは、必要なBotがそれぞれ自分の席へ登録する。オーナーがBellTeamコンテナへの標準搭載を指示したもの（通話ブリッジ`call-bridge`と、インフラ整備の部屋の担当プロダクト。2026-09-27）だけは、BellTeamが全BotのCLIへ登録する。今はRTK（担当ドリリー）が該当する。RTKのhookは、テストの関所（testgate。担当マクスウェル。2026-10-13 オーナー承認 K-X4DGPJ）が共通の置き場にある設置では、関所ごしに呼ぶ。
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
- BellTeamコンテナの再起動・再作成・停止を伴う操作は、実行前に必ず一度止まり、オーナーの許可を取ってから行う。通常のデプロイも対象とし、作業開始や実装の承認だけで再起動の許可を得たと扱わない。例外は、会話の部品（conversation-entry）が終了したまま5分戻らない時だけとし、外部復旧担当（ベル）は許可なしで、記録を保存してから現行の正規設定のまま本体コンテナだけを作り直す。imageと設定は変えず、結果はトロニーへ報告する（オーナー裁定 2026-11-05）。
- 反映はcommitしてから`scripts/deploy.sh`一回で行う。GitHubの`main`へpushし、本番は`git merge --ff-only`で取り込むだけで、本番側でcommitを作らない。本番の作業ツリーに未commitの変更があれば反映を止める。反映するとBot全員が停止し、次のメッセージで起動する。`scripts/deploy.sh`は反映前に処理待ち一覧を`runtime/backups/`へ保存する。止めたBotへ「再開しろ」は自動で送らない。
- 内部本番を含むBellTeam更新は、必ず配布担当センチへ対象と差分を渡し、必要な事前試験と結果を受けて進める。可能な限り商用コンテナを内部で先に使う。`BELLTEAM_DEPLOY_IMAGE=repo@sha256:digest`と既存quiet対象を指定する経路では、センチが公式現行版からbuildして受け入れた同じimageを再buildせず使う。内部profile等の外付け差分は`distribution/internal/README.md`に従う。未変更public構成と内部構成を混同しない。
- `config/bots.json`はGitHubの`main`の内容が本番の台帳になる。変える時はcommitして反映する。
- Node.js・CorepackとCLI（Claude・Codex・Grok・Cursor・Aiterm・Throughline・GitHub CLI）は版を固定しない。商用候補のbuild時はベースイメージを取得し、キャッシュなしで公式の現行版を導入する。内部先行利用と外部への昇格ではその同じimageを使う。`scripts/deploy.sh`のimage無指定経路は従来どおり毎回公式現行版からbuildする。永続volume上のCursorは反映前に、本体の鍵やhome/dataを渡さない使い捨てコンテナで公式`cursor-agent update`を実行する（SEC-014段階実装の承認、2026-10-15）。公開installerは本体を停止してからCursorを更新する。内部のimage指定経路は、旧本体を維持したまま既存quiet①の通過後にCursorを更新し、既存quiet②の通過後に本体を入れ替える。image無指定の従来deployも、設定されたquiet条件を更新前後で観測してから入れ替える。席の稼働中にCursorを更新する手順へは広げない。Claude Codeは席で自動更新させない（席の環境に`DISABLE_AUTOUPDATER=1`）。更新は`npm install -g`で席の`.local`へ写しを作り、席ごとに版がずれるため。席の`.local`に出来た写しはコンテナ起動時に片付け、全席がコンテナの物を使う（オーナーの指摘 2026-10-06）。
- Web APIは`http://192.168.1.2:18891/api/...`（`127.0.0.1`ではbindしない）。tokenは本番の`runtime/web.env`の`BELLTEAM_WEB_TOKEN`。

## 試験

- 機能図と現行設計から、変更する機能の入出力と直接の呼出境界を特定し、その契約に関係する試験だけを実行する。
- 全試験を定型の完了条件にしない。機能をまたぐ契約を変更するなど、範囲を絞れない具体的な理由がある場合だけ試験範囲を広げる。

## 会話の引き継ぎ

- Throughlineで会話が替わった時の最初の操作は、`call_list`で引き継ぐ通話を確かめ、使っている通話すべてへ`call_send`で移動を知らせることだけとする。他の作業はその後に行う。
- 移動の連絡には担当者・通話ID・新しい会話ID・返答待ちの内容を書く。会話IDは実測した値だけを書く（Claude Codeは`CLAUDE_CODE_SESSION_ID`）。通常の返信へ移動の連絡を兼ねさせない。
