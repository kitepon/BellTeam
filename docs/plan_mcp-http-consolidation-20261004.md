# 席ごとに起きるMCPを1プロセスのHTTPへ寄せる

## 目的

席（BotのCLI）ごとに起きるMCPのプロセスを減らす。席が増えても、BellTeamが標準で載せるMCPのメモリが席数に比例しない形にする（オーナー指示 2026-10-03）。

## 現状（本番の実測 2026-10-03 23時UTC、15席稼働）

| MCP | 本数 | 1本 | 合計 |
|---|---|---|---|
| bellteam `src/mcp-server.mjs` | 15 | 100MB | 1.5GB |
| call-bridge `src/call-bridge-mcp.mjs`（mcp-remote同居） | 15 | 100MB | 1.5GB |
| approval-box `cli.mjs` | 16 | 78MB | 1.3GB |
| aiterm `dist/index.js`＋`aiterm-wait-cli.js` | 15＋5 | 80MB | 1.6GB |
| Codexプラグイン openai-developers | 10 | 48MB | 0.5GB |

素のnodeはコンテナ内で1本42MB。席ごとにnodeを起こす床が大半を占める。

## 実測（Mac 2026-10-04、記録用のHTTP MCPへ4つのCLIを直結）

Claude Code 2.1.288、Codex CLI 0.160.0、Grok 1.0.46、Cursor 2026.10.01。4つとも設定だけでStreamable HTTPへ直結し、道具を呼べた。

| | 最初に話す版 | 席の名札をヘッダへ写す設定 | 変数が無い時のヘッダ | `tools/call`の`_meta` |
|---|---|---|---|---|
| Claude | `server/discover`を2026-07-28で試し、`initialize` 2025-11-25へ戻る | `headers`の`${VAR}` | 文字列`${VAR}`のまま | `claudecode/toolUseId` |
| Codex | `initialize` 2025-06-18 | `env_http_headers`（値に変数名）。`http_headers`の`${VAR}`は展開しない | ヘッダを送らない | `threadId`・`sessionId`・`x-codex-turn-metadata` |
| Grok | `server/discover`を2026-07-28で試し、`initialize` 2025-11-25へ戻る | `headers`の`${VAR}` | 文字列`${VAR}`のまま | `progressToken`だけ |
| Cursor | `initialize` 2025-11-25 | `headers`の`${env:VAR}` | 文字列`${env:VAR}`のまま | 無し |

- Grokを別の変数値で2本同時に動かしても、名札は混ざらなかった。
- Grokのプロジェクト側の設定は、信頼していないフォルダでは起動しない（`--trust`が要る）。共有設定（`~/.grok/config.toml`）に置く項目には影響しない。
- Aitermは親の会話を要求ごとの`_meta`とclientNameで決めている（`aiterm-mcp` `src/index.ts`の`codexParentFromRequest`・`claudeParentFromRequest`）。Approval Boxも同じ`_meta`を使う。どちらもHTTP経由で届くことを上の表で確かめた。

## 判明した前提

- 席の環境に`BELLTEAM_BOT_ID`は無い（本番の席のプロセスで確認）。今までは作業フォルダで席を決めていた。HTTPでは作業フォルダが届かないので、席のCLIの環境変数をヘッダへ写す。
- 変数が無いプロセス（席がAitermで起こした子など）は、名札が無いか展開前の文字列のまま届く。受け側は席を決められない要求としてエラーを返す。今は同じフォルダで動く子が親の席として扱われているので、ここは挙動が変わる。
- Approval Boxは`lastChannel`とCursor・Grokのchannel対応をMCPプロセスの中に持つ。1プロセスにするには会話の識別を明示する変更が要る（ナユタの見積もり: Linuxの4CLI検証まで3〜5作業日）。Claudeの待ち受けhookはHTTP化では減らない。
- `mcp-server.mjs`をsupervisorへ移すと、台帳・ルーム・記憶の書き手が1つになる。重い処理（アバターの読み込み、記憶の検索）は本体のイベントループで動くようになる（トロニーの指摘）。
- 通話MCPでmcp-remoteが担っているのは、合言葉のファイル読み込み・LANのhttp許可・`http-only`・席の名札の4つ（トロニーの指摘）。直結では、合言葉は変数名だけを設定へ書く。

## 実測で変えた点

- **席の名札は`AITERM_SESSION_ID`を使う。** 新しい`BELLTEAM_BOT_ID`は足さない。本番の席のCLIは`AITERM_SESSION_ID=<Bot ID>`を持つ（6席で確認）。Aitermがセッションごとに必ず明示して付けるので、席が起こした子は自分のセッション名になり、台帳に無い名札として判別できる。起動元の環境は別のプロセスへ流れることがある（Aitermが席を起こすtmuxサーバーの共通環境に、最初に起きた席の`BELLTEAM_PROJECT`が入っていた。再起動後は最初に起きた別の席の値に変わった）。同じ渡し方で新しい変数を足すと、席ではないプロセスが他の席の名札を持つおそれがある。
- **通話MCPはsupervisorが中継する。** CLIから通話ブリッジへ直結させない。合言葉と接続先を席の環境とCLIの設定へ出さずに済み、CLIが話す相手を実測済みのloopbackのhttpだけにできる。
- **名札が台帳に無い要求は、通話MCPでも拒む。** 通話ブリッジは名札の無いBellTeamの合言葉を所属全体として扱うので、名札なしで流すと席の子の権限が席より広くなる（トロニーの指摘）。以前は、席のフォルダの外で動くプロセスが名札なしで接続できた。

## 実装（ブランチ `bell/mcp-http`）

- `src/seat-mcp.mjs`: 内部入口の`/mcp`（BellTeam MCP）と`/mcp/call-bridge`（通話ブリッジへの中継）。
- `src/harness-config.mjs`: 4つのCLIの登録をHTTP直結へ変更。名札の書き方の差はここだけに置く。
- `src/mcp-server.mjs`・`src/call-bridge-mcp.mjs`とイメージの`mcp-remote`は削除。
- Macで、生成した設定のまま4つの実CLIから`get_self`と中継先の道具を呼び、席の判別・合言葉・発信者の名札・Codexの`threadId`の通過を確認した（2026-10-04）。

## 本番反映の結果（2026-10-03 23:48 UTC、`d39ca8d`）

- 席ごとの`mcp-server.mjs`・`call-bridge-mcp.mjs`・`mcp-remote`は0本（反映前は6席で12本、約1.26GB）。
- 再起動前に動いていた6席（Grok 1、Codex 2、Claude 3）すべてで、`get_self`が自分のIDを返し、通話の道具7つが見えた。
- 4つのCLIの設定に古い登録は無い。イメージに`mcp-remote`は無い。
- 名札なし・席が起こした子のセッション名・展開前の文字列は、`/mcp`も`/mcp/call-bridge`も403。内部入口はコンテナの外から届かない。
- 診断の記録に`SERVER_`系は0件。healthzは1ミリ秒未満。
- 席あたりの残りは、Aiterm約78MBとApproval Box約75MB。

## 残っている確認

- ブリッジ側の記録で発信者がBotごとになっていること、通話ブリッジの再起動後に席が再接続できること（トロニー）
- 停止が10秒の強制終了を待たずに終わること（今回止まったのは古いコードなので、次の反映で見る）
- CursorのBotは本番にいないため、本番では未確認（Macでは確認済み）

## 順番

1. 実測（済み）
2. BellTeam MCPと通話MCPを内部入口へ移す（済み、本番反映済み）
3. AitermとApproval BoxにHTTPの入口を足す提案（担当: エレグ、ナユタ）。席の名札はこの2製品へ持ち込まず、標準のHTTPの入口と要求ごとの`_meta`だけで成立する形に限る
