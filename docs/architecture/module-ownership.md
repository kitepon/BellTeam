# 機能担当と変更の手順

Owner 指示による本体分担の現行正本。機能を分離し、担当が自分の責任範囲を単独で更新できることを完成条件とする。2026-11 の初期分担・移管経緯は [移管履歴](../archive/module-ownership-history-202611.md) を参照。

## 機能図の正本

- 各担当の正本は `modules/<機能>/README.md` とそこから辿る機能内の図。公開窓口と使用する接点は同じ場所の `module.json`。
- [全体機能図](feature-map.md) は各 module の接続情報から `node scripts/render-feature-map.mjs` で生成する。生成物は手で直さず、各 module の正本を直して再生成する。全体には機能内部を複製しない。
- [全体データフロー](data-flow.md) は要求・返却・通知・保存と状態所有の唯一の全体正本。対象版・範囲・制限を同文書に示し、内部は担当の正本へリンクする。
- 接続先の `provides` に存在する窓口を `uses` で参照する。内部の図・入出力・所有データ・実装・関連試験は機能担当が一か所で管理する。別製品内部は当該製品の正本へリンクする。
- 全員は変更前に全体図から担当図、使用先、呼出元の図へ辿る。相手の内部状態を直接参照・更新する接続を作らない。横断する契約変更は両担当で入出力と互換性を合わせ、全体接続はトロニーが整合する。

## 現在の担当と所有範囲

| 担当 | 機能 | 主要範囲 |
| --- | --- | --- |
| トロニー | 全体設計・統合裁定 | 全体設計・公開契約/診断方針裁定、共通規範、全体図整合、優先順位、本番反映・Owner 判断 |
| エピネル | 通常 main 採用 gate | 通常 `main` への統合・採用 gate |
| センチ | 製品試験・受入 | 候補 image / モジュールの事前試験・製品受入確認（配布コード所有はモリー） |
| モリー | 本体・実行環境・共通入口・商用配布 | 薄い親・安定 facade・共通 HTTP/MCP dispatch・全 module 共通 ledger/adapter 組立・共通交換 runner/controller・世代/close-drain・bootstrap/supervisor/lifecycle・SeatRuntime/短命 runner・CLI/hook 登録・DB 実行 proxy・状態移行・installer・backup/restore・更新実行コード・Docker/Compose/profile・package・候補 CI・公式版発行/promotion コード |
| キロ | AI 実行制御 | AitermTransport/Client、DeliveryJob、SeatActivity、BotSessionState、AiControl、Goal、SeatTurns、IdleSessions。モデル保存後の適用と再開まで |
| N102 | 会話・履歴 | Messenger、RoomMessenger/Registry/History、ConversationStore、画像、履歴/SSE、SelfTurns、TurnReports、通話の本体受入口 |
| ベロータ | メンバー・予定 | BotRegistry、ProjectFiles のメンバー構造と指示、Owner 規範、アバター/設定画、Schedule 定義・実行発行、削除業務 |
| ミカ | 利用設定・通知 | Onboarding、HarnessAuth、AuthUI、FeatureSettings、質問/秘密入力、PushNotifications、Subscriptions、Cloudflare利用認証、運営の通知中継（`services/notifications`、本番ホストのOS部分はエマ、Tronie裁定 2026-11-27） |
| アドミ | Web 受付（web-gateway） | ネイティブアプリ向けの公開 HTTP 受付（`http-gateway`・版交換・更新 adapter。ブラウザ版画面は 2026-11-22 終了） |
| ビスケット | 記憶・知識 | MemoryService/Search、記憶形式と検索索引、短期記憶の方針 |
| シグナル | diagnostics 専任 | 診断 factory/閉 dispatcher、report/code/集約・唯一 writer、同 state restore、close-drain、管理 GET 契約（BugHub 本体はフラジャイル） |
| ライ | 認証仲介 | 固定のコマンド1つにだけ秘密を渡す独立module子（`auth-mediation`）。方針・許可・監査・item cache・1Passwordの読取トークンの使用、Bot用MCP道具、席のscript用socket、main-server用host socket。設計: [auth-mediation](modules/auth-mediation/README.md)（2026-11-26 Owner指名・設計のみ）。仕様の出どころ・item書込・移行はサクラ、秘密の保管はミカ、mount・supervision・配布・席MCP登録はモリー、main採用はエピネル、製品試験はセンチ、本番はトロニー |
| クラスト | 端末接続 | 端末登録、SSH/sudo 秘密参照、ホスト信頼、到達性、sudo 実行記録、C8 端末 CLI 保守、Aiterm へ渡す端末ターゲット |
| アークレンジャー・ブラック | 相関図 | 作業中メンバーと Bot 間依頼の現在グラフ（snapshot/SSE）と各アプリ共通の動き仕様。独立 module 子として単独交換（親 facade・effect・mount はモリー、描画は各アプリ担当） |
| フローラ | Lattice 工程表 | Lattice の取り込み（本体変更はスノーホワイト）、工程表保管、全席 MCP `lattice`、アプリ向け読取口（snapshot/SSE）と共通画面仕様。独立 module 子＋薄い HTTP/MCP handler（親 facade・effect・mount・MCP 登録・包装/配布はモリー、描画は各アプリ担当） |
| デルタ | 決裁箱拡張 | 決裁箱の決裁を工程表へつなぐ有料の追加機能（任意）。決裁箱の公開接点での読み・回答、決裁 1 件と工程 1 件の対応記録、`/api/approvals/*`、画面設計（決裁箱本体はナユタ、工程書込口はフローラ、セッション保管はミカ、親 facade・mount はモリー、描画は各アプリ担当） |

クライアント・独立製品の担当：
- クライアント：Apple（iPhone/iPad/Mac）＝ラピ、Windows＝アニス、Linux / Android＝ネオン
- 外部・独立製品：Aiterm/Steer＝エレグ、Throughline＝リヴァリン、call-bridge＝リター、mcp-lazy＝レオナ、RTK＝ドリリー、testgate＝シラツル、BugHub＝フラジャイル、Approval Box＝ナユタ、Lattice（`@quolu/lattice`）＝スノーホワイト、Caveat＝ノア、OS・ホスト＝エマ等。各正本と公開接点は `modules/` の索引へ接続する。

## 混在箇所の分離と単独更新

- `bot-administration.mjs` は設定・停止のキロと削除のベロータが混在するため、各機能の独立 module へ抽出し、共通入口の切替はモリーが持つ。契約変更や責任境界の衝突はトロニーへ具体差分を返す。
- `room-registry.mjs` の部屋正本は N102、予定の共通処理はベロータ。部屋特有の参加者検証は N102 の公開窓口で行う。
- `seat-runtime.mjs` と `run-seat-runtime.mjs` はモリーが機構を持ち、ProjectFiles や記憶の業務処理は各所有者へ委譲する。共有 CLI JSON の書込・完了はモリー、メンバー削除の完了はベロータ。
- `mcp-tools.mjs`、共通 HTTP handler、`application-services/runtime`、`application-features` 等の混在入口は、各機能の公開 handler/説明/schema/登録情報へ分け、共通入口（モリー）は登録と接続だけを持つ。
- 単独更新の成立条件は、機能内部の修理に他担当の内部コード・私有データの編集が不要で、公開窓口を使う関連試験を自分で実行できること（別プロセス化・別リポジトリ化・別リリース化自体は必須要件としない）。

## モジュール更新の現在の受渡し

- 薄い親・安定 facade・全 module 共通 ledger/adapter 組立・共通交換 runner/controller・配布コードは **モリー**、通常 main 採用 gate は **エピネル**、製品試験・受入確認は **センチ**、全体判断・本番実行は **トロニー**。
- 業務内部は web-gateway（アドミ）、notifications/usage（ミカ）、members（ベロータ）、conversation（N102）、execution（キロ）、memory（ビスケット）、diagnostics（シグナル）、work-graph（アークレンジャー・ブラック）、lattice（フローラ）、approval-box-extension（デルタ）。
- 未供給 module は未対応を明示し、正本を読めない状態で成功へ投影しない。

## コード変更の順序（全担当共通）

1. 全体図、担当図、関連する呼出元・使用先の図を読む。
2. 対象コードの版に対応する図を読み、機能・入出力・状態所有・接続・失敗の扱いの変更要否を判断する。図が無い製品は [共通規範](../../config/common-agents.md) に従い、図の整備完了までコード変更を待つ。図と現物の不一致は先に直す。
3. 変更する実装、全 caller、test/fixture、設定、export とデータへの影響を確認して作業範囲を決める。
4. コードを修正し、必要な機能図・接続情報を同じ差分で更新する。図を変えない時は既存図に収まる理由を変更説明へ短く書く。
5. 機能の入出力と直接境界に必要な検証を行い、全体図を再生成する。全体試験の定型再走や新しい承認待ちの関所は追加しない。

各担当は自分の `docs/` へ手順・状態・継続を保存し、この正本をリンクする。共通規範の文章や他機能の図を個人 `docs/` へ複製しない。
