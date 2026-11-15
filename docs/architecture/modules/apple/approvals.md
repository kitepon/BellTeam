# 決裁箱（Approval Box拡張）の描画

[全体図](overview.md) / [機能索引](function-index.md)。データの契約は [/api/approvals/*](../approval-box-extension/contract/approvals-contract.md)、画面・導線・失敗の表示・文言は [screen-spec](../approval-box-extension/screen-spec.md) が正本で、ここではApple側の部品と状態の持ち主だけを書く。アプリは決裁箱の本体を直接呼ばない（契約の口だけ）。IDは通信にだけ使い、画面に出さない。

## 入口と置き場所（Owner 2026-11-16：MacとiPhoneで決裁箱が見つからない）

| 端末 | 入口（案A：左メニューの先頭の固定行） | 画面 |
| --- | --- | --- |
| iPhone | 「会話」タブのメンバー見出しの下、最初の行（`HomeView`の`ApprovalsEntryRow`）。タブは5つのまま | `store.approvalsScreenOpen`で押し込む画面（`navigationDestination`）。詳細はsheet（大） |
| iPad | サイドバーの検索の下に固定（`DesktopWorkspaceView.sidebar`）→ `selectedTab = 6` | 詳細の列（`NavigationStack`）。幅1360pt未満はiPhoneの流れ（一覧＋sheet） |
| Mac | 同じ固定行 → `MainWindow.bringToFront("approvals")`。窓は1つだけ、1360×860 | 窓（`WindowGroup id: "approvals"`）。1360pt以上で3列（一覧500｜詳細520｜工程とのつながり） |
| 工程表の詳細（指揮官の札） | 「決裁」ブロックの「決裁を開く」→ `AppStore.openApprovals(decision:)`（iPhoneは`approvalsScreenOpen`、iPad・Macは`approvalsRequest`を各コンテナが受ける） | その決裁の詳細を選んで開く（`ApprovalsModel.openRequest`） |
| 決裁の「工程表の工程を開く」 | `AppStore.openLatticeCard(project:card:)` → `latticeOpenRequest`＋`latticeOpenCard` | 工程表をその札の詳細で開く（`LatticeHomeView`が`.card`で受ける。iPhoneは相関図タブの工程表側、Macは工程表の窓を前へ） |

## 部品と流れ

```mermaid
flowchart LR
  Run["App/BellBotApp.swift RootView<br/>ApprovalsRunner：前面の間 ApprovalsModel.run を1本だけ回す（読み直すで作り直す）"] --> Model
  Entry["入口（上の表）<br/>ApprovalsEntryRow：数＝ApprovalsModel.pendingCount（全出どころ・絞り込みに関係なし）、待ち0は静か、急ぎは稲妻"] --> Model
  Model["Core/Approvals.swift ApprovalsModel（AppStore.approvals）<br/>gate・summary・open（待ち＋保留）・done（済み、開いた時に読む）・sending・notes・connectPhase"]
  Model -->|"読む：summary → ?status=pending,held → /connection"| API["BellAPI.approvalsResponse(path:method:body:headers:)<br/>状態と本文をそのまま返す（4xxの本文 {error:{code,…}} を読むため。401・Accessログイン・別ホストだけ認証切れ）"]
  Model -->|"SSE /api/approvals/events：summary → 数を置き換え / decision.* → その1件を読み直す"| API
  API -->|"ApprovalFailure.of(status,body)"| Gate["gate：403 not_entitled(none) → 契約が要る / (expired・revoked) → 契約切れ / 402 → 契約切れ / 409 not_connected → つなぐ / 404 → 旧本体（60秒ごと） / 401・403 → ログイン / 503・切断・35秒無通信 → 再接続（1,2,4…30秒、最後の一覧を薄く残す）"]
  Gate --> GateView["Views/ApprovalsView.swift ApprovalGateView（画面1・2・4・9）<br/>どの状態にも画面の中の出口がある：契約を確かめる・閉じる・決裁箱につなぐ・読み直す"]
  Model --> Screen["ApprovalsScreen：待ち／保留／済みの切り替え・出どころ すべて/BellTeam/外部（既定すべて。隠している間は琥珀の行 外部の決裁 N件を隠しています）・今日の回答の輪・待ち／急ぎ／保留<br/>ApprovalCard：回答待ち（輪郭とグロー）・急ぎ（琥珀の帯）・保留（破線）・外部から（灰色の札）"]
  Screen -->|"札を押す"| Detail["ApprovalDetailView：背景（リンクは1タップでブラウザ）・添付（sizeとsha256を本文と照合）・AIの推奨・答えを選ぶ・指示を書いて返す・保留にする・経過<br/>答える：選ぶ → その場が確認に変わる（答える／やめる）→ 送信中 → 結果の文"]
  Detail -->|"POST /:id/answer {optionId|text, version} + Idempotency-Key（同じ選びの再押しは同じキー）"| API
  Detail -->|"POST /:id/hold|unhold"| API
  API -->|"200：更新された決裁（delivered/fetched・waiting・unknown の文と色）/ 409 conflict：本文の最新の決裁で置き換え、送らない / 503・切断：答えは残る・同じキーで再押し"| Model
  Detail --> Chain["ApprovalChainPanel：前の／この／次の工程の小さな札・答えた時の一文・工程表の工程を開く。外部は破線の「つながっていません」"]
  GateView -->|"決裁箱につなぐ"| Connect["POST /connect → authorizationUrl をブラウザで開く（アプリはサインインを描かない）<br/>待つ：GET /connection を3秒ごと（connected → 読み直す / denied → もう一度つなぐ / expired → 戻る）。やめる＝DELETE /connect"]
  Screen -->|"つなぎを外す（2段の確認）"| Disconnect["DELETE /connection → つながっていません"]
