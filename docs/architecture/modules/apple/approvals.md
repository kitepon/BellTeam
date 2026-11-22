# 決裁箱（Approval Box拡張）の描画

[全体図](overview.md) / [機能索引](function-index.md)。データは、この端末が持つ決裁（peer-channel、[v0.2](../approval-box-extension/peer-channel-v0.2.md)・[サインインと端末の承認](../approval-box-extension/peer-channel-signin.md)）で、サーバーに内容はない。工程表とのつながりの口は [/api/approvals/by-*](../approval-box-extension/contract/approvals-contract.md)（IDと状態だけ）。画面・導線・失敗の表示・文言は [screen-spec](../approval-box-extension/screen-spec.md) が正本で、ここではApple側の部品と状態の持ち主だけを書く。アプリが決裁箱（Approval Box）に持つサインインは、BellTeamのサインインとは別の2つ目のライブラリの接続で、BellTeamのサーバーはそのパス・アカウントID・端末の鍵を見ない。IDは通信にだけ使い、画面に出さない。

## 入口と置き場所（Owner 2026-11-16：MacとiPhoneで決裁箱が見つからない）

| 端末 | 入口（案A：左メニューの先頭の固定行） | 画面 |
| --- | --- | --- |
| iPhone | 「会話」タブのメンバー見出しの下、最初の行（`HomeView`の`ApprovalsEntryRow`）。タブは5つのまま | `store.approvalsScreenOpen`で押し込む画面（`navigationDestination`）。詳細はsheet（大） |
| iPad | サイドバーの検索の下に固定（`DesktopWorkspaceView.sidebar`）→ `selectedTab = 6` | 詳細の列（`NavigationStack`）。幅1360pt未満はiPhoneの流れ（一覧＋sheet） |
| Mac | 同じ固定行 → `MainWindow.bringToFront("approvals")`。窓は1つだけ、1360×860 | 窓（`WindowGroup id: "approvals"`）。1360pt以上で3列（一覧500｜詳細520｜工程とのつながり） |
| 工程表の詳細（指揮官の札） | 「決裁」ブロックの「決裁を開く」→ `AppStore.openApprovals(decision:)`（iPhoneは`approvalsScreenOpen`、iPad・Macは`approvalsRequest`を各コンテナが受ける） | その決裁の詳細を選んで開く（`ApprovalsModel.openRequest`） |
| 決裁の「工程表の工程を開く」 | `AppStore.openLatticeCard(project:card:)` → `latticeOpenRequest`＋`latticeOpenCard` | 工程表をその札の詳細で開く（`LatticeHomeView`が`.card`で受ける。iPhoneは相関図タブの工程表側、Macは工程表の窓を前へ） |

## 部品と流れ（a490h2r：端末の決裁をpeer-channelで読み、答える）

```mermaid
flowchart LR
  Run["App/BellBotApp.swift RootView ApprovalsRunner：前面の間 ApprovalsModel.run → ApprovalBoxLink.start（1回だけ）。読み直す＝いま生きていなければ retryNow"] --> Model
  Entry["入口（上の表）ApprovalsEntryRow：数＝pendingCount"] --> Model
  Model["Core/Approvals.swift ApprovalsModel（AppStore.approvals）&lt;br/&gt;gate・summary・open・done・sending・notes。summary は端末の決裁から数える（今日の回答・今日来た数・待ち・急ぎ・保留）。済みは端末の履歴で、もう読み足すものは無い"]
  Link["Core/PeerApprovals/ApprovalBoxLink.swift（状態機械は signin.md の1つ）&lt;br/&gt;SignedOut・SigningIn・Joining・NotEntitled・NeedsApproval・Waiting・Live・Reconnecting"]
  Link --&gt;|"state → gate / decisions → open・done"| Model
  Link --&gt;|"2つ目の LoginBillingClient：https://approval-box.kitepon.dev/auth/v1、自分のパスの置き場（Keychain service dev.kitepon.bellbot.approval-box）、Web サインインだけ（ASWebAuthenticationSession、scheme approvalbox-websignin）、購入なし"| AB["Approval Box（Nayuta）：auth/v1・/pc/v1"]
  Link --&gt;|"check().k（アカウント番号はここだけ。ログにも BellTeam にも出さない）"| Dev
  Dev["Core/PeerApprovals/PeerDevice.swift（actor）：レジストリの写し・genesis（5.1）・承認（5.3）・コネクタごとのセッション・署名つきの答えと保留"]
  Dev --&gt;|"/pc/v1（PeerChannel Swift パッケージ、契約 0.5.9）"| AB
  Dev --&gt;|"keys（Secure Enclave または Keychain）・レジストリ"| Store["PeerDeviceStore（Keychain service dev.kitepon.bellbot.approval-box.peer）"]
  Dev --&gt;|"受けた決裁・添付（blob id＝SHA-256）"| Hist["PeerDecisionHistory（アカウントごとのフォルダ、ファイル保護つき）"]
  Hist --&gt; Link
  Model --&gt; Screen["ApprovalsScreen：待ち／保留／済み・出どころの絞り込み（外部だけ。BellTeamの出どころは、工程とのつながりを足す時に加える）・今日の回答の輪&lt;br/&gt;ApprovalCard"]
  Screen --&gt;|"札を押す"| Detail["ApprovalDetailView：背景・添付（端末の blob を id と照合）・答えを選ぶ・指示を書いて返す・保留にする"]
  Detail --&gt;|"answer / hold → Link → PeerDevice：署名してそのセッションで送り、コネクタの ack を待つ"| Dev
  Dev -.->|"ack：accepted → 結果の文（届いた）/ closedElsewhere・stale・draftKept・refused → 文を出して選びは残す。自動では再送しない"| Model
  Model --> GateView["ApprovalGateView：状態ごとの画面と出口（signin.md 3章。Approval Boxにサインイン・やめる・承認をお願いする・確かめ直す・今すぐ試す・Approval Boxからサインアウト）"]
```

状態の出口（signin.md 2章）：Live の切れ方は、4401 pass_ended・/pc/v1 の 401＝サインアウト（期限とは言わない）、4410＝パス・端末の鍵・レジストリ・履歴を消してサインアウト、レジストリから外された＝NeedsApproval、中継に届かない＝Reconnecting（1,2,4…30秒の待ち、回数の上限なし、手動の「今すぐ試す」は待っている次の1回を直ちに実行し並列には増やさない）。購読が無い＝NotEntitled（「確かめ直す」で再確認）。サインアウトしても BellTeam のサインインは残る。端末の削除画面は作らない（SEC-086 は対象外）。

サインインは Apple を先に出し（Owner の Approval Box のアカウントは Apple ID）、Google は2つ目（Nayuta 2026-11-23）。戻りは scheme `approvalbox-websignin` だけ（確認済みリンクは Approval Box 自身のアプリ専用）。

ライブ試験（2026-11-23 04:40 JST、approval-box 9e26153 のローカル開発サーバー 127.0.0.1:8788、iOS シミュレータ。`ApprovalBoxLiveTests`、`PEER_DEV_URL` が無ければ何もしない）：ラボの承認者（dev:approve）が作った登録簿に対し、ApprovalBoxLink が NeedsApproval → 16文字のコードを出す Waiting → dev:admit で承認 → Live → コネクタ経由の依頼が届く → 先頭の選択肢で答える → コネクタ側が answered。Web ブラウザの段は試験で動かせないため、パスは開発サーバーの偽サインインからライブラリの Testing の口で取り、同じパスの置き場を ApprovalBoxLink が読む。`ApprovalBoxLive` は実機・本番・通知・TURN を含まない。

工程表とのつながり（a490h2r、`Core/PeerApprovals/ApprovalLinks.swift` の `ApprovalLinkResolver`）：決裁の中身は端末だけにあり、BellTeam のサーバーに聞くのは ID と状態だけ。`GET /api/approvals/by-decision?id=` が {project, plan, task, state} を返せば BellTeam の決裁（出どころ bellteam、つながりあり）、404 なら外部または未接続（破線の「つながっていません」）、それ以外の失敗は何も足さない。工程の名前と前後は、アプリが読める工程表（`/api/lattice/charts/:project`、20秒の写し）の札とエッジから描く。見つかったつながりは30秒ごとに読み直し、404は30秒後にもう一度聞く（サーバーのつなぎ込みは自分の間隔で動く）。工程表の詳細の「決裁を開く」は `by-task`（ID と状態だけ。件名が無い時は「決裁（待ち）」）から同じ決裁の詳細を開く。

この版に入れていないもの（次の段）：通知拡張（NSE）による本文なしの起こし、実機 iPhone での確認、BellTeam のサーバーへ「この端末が見せた決裁」を知らせる D7b の報告。
