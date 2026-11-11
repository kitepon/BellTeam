# 機能担当と変更の手順

Owner 2026-11-02指示による本体分担。機能を分離し、担当が自分の責任範囲を単独で更新できることを完成条件とする。役職設定だけで分離完了としない。

## 機能図の正本

- 各担当の正本は `modules/<機能>/README.md` とそこから辿る機能内の図。公開窓口と使用する接点は同じ場所の `module.json`。
- [全体機能図](feature-map.md)は各moduleの接続情報から `node scripts/render-feature-map.mjs` で生成する。生成物は手で直さず、各moduleの正本を直して再生成する。全体には機能内部を複製しない。
- [全体データフロー](data-flow.md)は要求・返却・通知・保存と状態所有の唯一の全体正本。対象版・範囲・制限を同文書に示し、内部は担当の正本へリンクする。
- 接続先の `provides` に存在する窓口を `uses` で参照する。内部の図・入出力・所有データ・実装・関連試験は機能担当が一か所で管理する。別製品内部は当該製品の正本へリンクする。
- 最初の移管では既存の複数機能が混ざった詳細図を章単位で移し、旧箇所は新正本へのリンクにする。旧全体図は `feature-map-legacy-20261101.md` の履歴資料。
- 全員は変更前に全体図から担当図、使用先、呼出元の図へ辿る。相手の内部状態を直接参照・更新する接続を作らない。横断する契約変更は両担当で入出力と互換性を合わせ、全体接続はトロニーが整合する。

## 担当と既存コードの初期所有

| 担当 | 機能 | 初期の主要範囲 |
| --- | --- | --- |
| キロ | AI実行制御 | AitermTransport/Client、DeliveryJob、SeatActivity、BotSessionState、AiControl、Goal、SeatTurns、IdleSessions。モデル保存後の適用と再開まで |
| N102 | 会話・履歴 | Messenger、RoomMessenger/Registry/History、ConversationStore、画像、履歴/SSE、SelfTurns、TurnReports、通話の本体受入口 |
| ベロータ | メンバー・予定 | BotRegistry、ProjectFilesのメンバー構造と指示、Owner規範、アバター/設定画、Schedule定義・実行発行 |
| ミカ | 利用設定・通知 | Onboarding、HarnessAuth、AuthUI、FeatureSettings、質問/秘密入力、PushNotifications、Subscriptions、Cloudflare利用認証 |
| アドミ | Web | web全体の状態・操作・表示。サーバーの機能判定を画面へ複製しない |
| モリー（2026-11-08まではエピネル） | 実行環境・更新復旧 | 全module共通交換runner/controller・世代/close-drain、bootstrap/supervisor/lifecycle、SeatRuntime/短命runner、CLI/hook登録、状態移行、installer、backup/restore、更新実行の製品コード |
| ビスケット | 記憶・知識 | MemoryService/Search、記憶形式と検索索引、短期記憶の方針。DB実行proxyはエピネル |
| モリー | 商用配布 | Docker/Compose/profile、package、候補CI、image/source受入、公式版発行・promotionのコード（2026-11-08 Owner裁定、旧センチ）。センチは製品試験だけ |
| モリー | 薄い親・共通入口 | 安定facade、共通HTTP/MCP dispatch、全module共通ledger/adapter組立、機能間接続・必要な結合試験と通常main統合 |
| シグナル | diagnostics専任 | 診断factory/閉dispatcher、report/code/集約・唯一writer、同state restore、close-drain、管理GET契約。BugHubはフラジャイル |
| トロニー | 全体設計・統合裁定 | 全体設計・公開契約/診断方針裁定、共通規範、全体図整合、優先順位、本番反映・Owner判断 |
| アークレンジャー・ブラック | 相関図 | 作業中メンバーとBot間依頼の現在グラフ（snapshot/SSE）と各アプリ共通の動き仕様。独立module子（protocol・両端channel・dispatcher・core・entry）として単独交換する。親facade・effect窓口・mountと起動/閉集合はモリー、署名・導入はセンチ、描画はApple/Web/Windowsの各担当。2026-11-08 Owner依頼・トロニー割当 |
| フローラ | Lattice工程表 | Latticeの取り込み（Lattice本体の変更はスノーホワイトへ依頼）、プロジェクトごとの工程表の保管（server state）、全席のMCP道具 `lattice`、アプリ向け読取口（snapshot/SSE）と各アプリ共通の画面仕様。独立module子（protocol・両端channel・dispatcher・core・entry）とbody側の薄いHTTP/MCP handlerを持つ。facade・effect窓口・mount・MCP登録・起動/閉集合・包装/配布はモリー。Web画面 `web/lattice-*` はフローラ、Apple/Windowsの描画はラピ・アニスが画面仕様どおり作りフローラが受け取る（2026-11-11 Owner割当、トロニー裁定） |

Apple/Windowsクライアントは各ベル、Aitermはエレグ、Throughlineはリヴァリン、Bridgeはリター、mcp-lazyはレオナ、RTKはドリリー、testgateはシラツル、BugHubはフラジャイル、Approval Boxはナユタ、Caveatはノア。各正本と公開接点は modules の索引へ接続する。OS・ホストはエマ等の既担当。

## 混在箇所の分離と単独更新

`bot-administration.mjs` は設定・停止のキロと削除のベロータが混在する。両者は自機能の実装を独立moduleへ抽出し、共通入口の切替と既契約内の通常統合はモリーが持つ。契約変更や責任境界の衝突はトロニーへ具体差分を返す。`room-registry.mjs` の部屋正本はN102、予定の共通処理はベロータ。部屋特有の参加者検証はN102の公開窓口で行う。

`seat-runtime.mjs` と `run-seat-runtime.mjs` はエピネルが機構を持ち、ProjectFilesや記憶の業務処理は各所有者へ委譲する。共有CLI JSONの書込・完了はエピネル、メンバー削除の完了はベロータ。削除から共有設定更新へ渡す情報と失敗の扱いを契約にする。

`mcp-tools.mjs`、共通HTTP handler、`application-services/runtime`、`application-features` 等の混在入口は、各機能の公開handler/説明/schema/登録情報へ分ける。機能担当が自分の入出力・説明・関連試験を同じ変更で更新でき、共通入口担当モリーは登録と接続を持つ。初回抽出で同じ共通ファイルを別々の担当が同時に全面編集しない。個別checkoutと範囲を明示し、必要な統合差分を渡す。恒久的に全機能の内部変更をトロニーへ依頼する構造にはしない。

単独更新の成立は、機能内部の修理に他担当の内部コード・私有データの編集が不要で、公開窓口を使う関連試験を自分で実行できること。公開契約を変える場合は利用先との調整を含む。単独更新を別プロセス化・別リポジトリ化・別リリース化の要件にはしない。

## コード変更の順序（全担当共通）

1. 全体図、担当図、関連する呼出元・使用先の図を読む。
2. 対象コードの版に対応する図を読み、機能・入出力・状態所有・接続・失敗の扱いの変更要否を判断する。図が無い製品は[共通規範](../../config/common-agents.md)に従い、レヴィアタン指導下のリファクタリング完了まで修理を含むコード変更を待つ。図と現物の不一致は先に直す。
3. 変更する実装、全caller、test/fixture、設定、exportとデータへの影響を確認して作業範囲を決める。
4. コードを修正し、必要な機能図・接続情報を同じ差分で更新する。図を変えない時は既存図に収まる理由を変更説明へ短く書く。
5. 機能の入出力と直接境界に必要な検証を行い、全体図を再生成する。全体試験の定型再走や新しい承認待ちの関所は追加しない。

各担当は自分のdocsへ手順・状態・継続を保存し、この正本をリンクする。共通規範の文章や他機能の図を個人docsへ複製しない。

## 最初の割当と完了の報告

- キロ：モデル切替の待機契約修理と自動適用/再開設計。Cinderella08:40再発とElegg08:51未適用の読取・正規復旧条件を優先して返す。
- N102：会話・部屋・履歴・自主回答の図とwriter所有を分離。775e26/b7ba50の本体側既記録と新担当境界を引き継ぎ、旧失敗の成功への変更はしない。
- ベロータ：削除完了/予定/規範を分離。Andersonの正規pending再開と削除完了を共有CLI同期から独立させる修理をエピネルと進める。
- ミカ：利用設定・認証・通知を公開機能へ分離。質問/秘密入力の保存と通知失敗の違い、各機能の部分成功を保持する。
- アドミ：Web担当図と既公開APIへの依存を独立させる。商用更新通知のロゴ右表示・操作フローは定義済み6機能から設計する。
- エピネル：実行基盤/共有CLI JSON更新/移行を分離。削除競合修理を担当し、商用更新6機能の実行側をセンチ・アドミ・ベルと設計する。

各担当は「図の正本、公開契約、所有範囲、分離したコードと残る共有箇所、必要な試験結果」を返す。担当移管・source分離・本番反映の成立をそれぞれ明記する。本番/一般配布のOwner保留は継続し、新担当の任命だけで解除しない。

## 11/3 共通実装の正式移管

Ownerの正式割当によりintegration moduleの実装ownerをモリーへ移す。通常main統合もモリーが作者成果照合・必要結合・図合成・競合解消・push・CI/source binding・採用SHA返却まで一貫して持ち、毎回Root採否を待つ条件にしない。Rootは全体設計/公開契約・診断方針裁定/優先順位/本番・Owner判断を持つ。runtime移管19fad7fの子起動停止・版交換/adoption/戻しと固定root記録writer/有限watch/取消/OS observerはエピネル、機能内部は各担当、配布はセンチ。共通callerは公開接点だけを使い、内部sourceの変更は所有者が持つ。既成功群の再走を新gateにせず、変更した直接境界を検証する。移管は本番・資格利用・OS権限の承認を追加しない。

## 11/8 本体担当の一本化

Owner承認・トロニー伝達（2026-11-08）により、本体コンテナ（親の組立・実行環境・部品の入れ替え・image）と「本体を止めずに更新できる」性質の唯一の担当をモリーにする。runtime module（上表の実行環境・更新復旧）の所有はエピネルからモリーへ移り、通常mainの採用gateはモリーからエピネルへ移る。部品の業務内部の担当、試験・供給センチ、全体判断・本番トロニーは変わらない。この文書の他の表・節にある旧割当（実行環境・更新復旧、DB実行proxy、installer動作実装、seat-runtime/共有CLI JSONのエピネル、通常main統合のモリー）は、この節が優先する。日付付きの履歴は書き換えない。

## モジュール更新の現在の受渡し

薄い親・安定facade・全module共通ledger/adapter組立はモリー、共通交換runner/controllerはモリー。業務内部はwebアドミ、notifications/usageミカ、membersベロータ、conversation N102、executionキロ、memoryビスケット、diagnosticsシグナル、配布モリー（製品試験センチ）。diagnosticsのFragile一時割当は撤回、BugHub担当は変えない。個別の入出力・同state writer・世代/close-drain・失敗出力は各moduleの正本、共通接続はintegrationの正本へ置く。既3controllerのadapter/共通ledgerを先行し、会話/usage/memory等の全納品を待つ条件にしない。未供給moduleは未対応を明示し、正本を読めない状態で成功へ投影しない。
