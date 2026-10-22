# Appleアプリの操作遅延調査（進行中）

## 依頼と優先順位

オーナーの症状は、iPhone・iPad・Mac版でスクロール、文字入力、ログ表示などが全体的にカクつき、動いては止まるというもの。AIの生成速度は対象外。電池の減りも気になるとの申告があるが、消費電力は未計測。最優先はiPhone。

## 現時点で確かめたこと

- 2026-10-22、作業元は `c66b329`、`main` と `origin/main` が一致し、作業ツリーは開始時clean。`c3a5edfa` から現行までApple本体コードの差分はない。
- `AppStore.startEvents()` はSSE callbackのたびに `eventRevision` を増やして全体の `refreshFromView()` を要求する。表示中の `ConversationContent` は同じrevisionで `load()` に進み、更新では会話の最新20件、末尾より後の全件、queueを要求して、取得済み配列を `messages.map` で組み直す。入力の本文は別の `ConversationDraft` が所有しており、文字入力を共通通知へ直接載せてはいない。
- 会話画面は初回10件、過去は20件ずつ取得し、取得済み全行を `VStack` へ配置する。本文は `EnrichedMarkdownText`。既存の `ConversationFreezeUITests` は10件の人工データで更新・スクロール・入力の操作継続を確認する試験で、大量の履歴や実機のフレーム時間を測る試験ではない。
- トロニーの読み取り調査では、サーバーの `/api/events` は接続先ごとに絞らず全購読者へ通知する。共通watchは最初の変更から50msの窓でまとめる。即時通知は別経路。現行通知には会話の宛先IDが無く、Appleの `BellAPI.events()` も `type` だけを渡す。別Bot・別ルームの変更で表示中会話の取得が走る構造はコードから確認できる。ただし60秒の読み取り観測では `messages` は0件だった。通知が今回の継続的なカクつきを支配するという証拠はない。
- 専用iPhone 16 Pro Max Simulator（iOS 26.5）へ現行ソースのDebug 1.0.3（56）を合成会話で起動できた。10件程度を0.2秒ごとに変えるプレビュー中の8秒標本では、メインスレッドの約5,717点中4,500点が待機にあり、静止後の8秒標本では約6,347点すべて待機にあった。停止した旧担当が残した人工100行の試験fixtureで同じ更新を約100件へ増やすと、メインスレッドの約6,208点中3,111点が待機にあった。10件と100件は同じDebug Simulator・同じ0.2秒更新で、初回起動の影響を避けるため各2回目の起動を比較した。この標本は行数によるCPU処理の増加を示すが、フレーム落ちや実機の電池消費は測っていない。標本原本は `runtime/apple/performance-20261022/` に圧縮保存した。試験アプリと専用Simulatorは終了済み。
- このMacに導入済みのMac版は1.0.2（54）。対応するdSYMのarm64 UUIDは導入済み本体と一致する。iPhone(Kaito) は後にUSBで接続され、iPhone 16 Pro Max / iOS 26.6.2、導入済みBellTeam 1.0.3（56）を確認した。先のオフライン状態は解消した。
- トロニーの本番履歴の読み取り集計では、Bot会話60履歴の表示行数は中央値215、p90は1,356、最大5,405。本文長は1行あたり中央値182、p90は1,085、最大46,218コードポイント。最新10行の本文長合計は非空56履歴で中央値3,390、p90は6,464、最大10,220。最新30行では中央値10,834.5、p90は21,073、最大34,947。これは保存履歴の分布で、iPhoneが実際に保持する行数や描画時間ではない。

## 小規模な修理候補の実験

`MessageText` の本文・文字サイズ・行間・アクセシビリティIDを比較し、変化しない本文のSwiftUI更新を省く `.equatable()` を会話行へだけ追加した。合成100行の本文は計43,420文字で、本番履歴の最新50行の多い側（p90の32,649、最大54,650コードポイント）に近い規模だが、行の構成・内容・取得状態は異なる。0.2秒更新で、同じ専用SimulatorのDebugビルドを2回目の起動後に8秒採取すると、メインスレッドの待機以外の標本は変更前3,097/6,208点、変更後2,273/6,350点。呼び出し木の `EnrichedMarkdownText.styleConfig` は変更前270点、変更後166点。行数増加でMarkdownのスタイル計算・装飾描画が増える仮説と、未変更本文の再評価を抑えると一部減ることを、この合成条件では支持する。比較は各1回で、実機・Release・通常のイベント頻度・スクロール操作・電池消費への効果は未確認。

変更後の `ConversationFreezeUITests/testConversationRemainsResponsiveDuringUpdatesAndScrolling` は専用iPhone Simulatorで1件成功した。更新中のスクロール・キーボード・詳細操作を確認する既存試験であり、性能の数値目標を判定するものではない。100行を静止させてスクロールするCPU標本は、操作ツールの大きなアクセシビリティ画面読み取りが混ざったため比較から外した。

## 調査中に再現した読み位置の欠陥

`ConversationScrollUITests/testOlderMessagesLoadAutomaticallyAtTopAndKeepPosition` は、`.equatable()` の有無にかかわらず、元のコードで旧先頭行が画面外の `y=6770` へ飛んで2回失敗した。試験動画には、追加した過去20行の先頭へ画面が移る様子が残る。失敗時のログでは、固定した旧先頭行の境界が `1554`、表示領域が `688` の時点で固定を解除していた。行追加直後はMarkdownの高さが段階的に変わり、一時的に境界が画面外へ出る。固定行が配置後に一度見える前に解除したことが原因。

`ScrollTracker` に `awaitingGrowth → correcting → aligned` の状態を持たせ、行の追加・高さの更新後に固定行が見えるまで位置補正を続ける。変更後、同じ試験をログなしで連続2回成功した。`ConversationScrollUITests` の5件中、新着試験だけは当初失敗した。動画では試験が最古行を読み込んだだけで画面に見えたと誤認し、上端に届かないまま新着確認を始めていた。試験を実際の可視状態までスクロールするよう直し、追加後の取得回数が増えたことを判定して、当該1件と関連5件の一括実行が成功した。最終の関連5件は同じ実行で5件成功。Mac CatalystのDebugビルドも成功。これは合成履歴での読み位置修理であり、オーナーの全体的な操作遅延の根因と同一とは判定しない。

試作と読み位置修理はビルド57へ含め、既存のオーナー用内部TestFlightへ配布した。

## iPhone版56の実機基準

USB接続とiPhoneミラーリングで導入済みのBellTeam 56を開き、送信・設定変更をせず会話のスクロールを記録した。最初の30秒Time Profilerでは短いスクロール2回で250ms超の停止0件。続く41秒のSwiftUI記録では連続スクロールで過去ログの追加まで進み、画面の引っかかり判定0件。250ms超の停止は記録開始0.77秒後の約496msが1件で、スクロール操作開始前のため操作由来とは判定しない。SwiftUIの記録には `MessageText` と `EnrichedMarkdownText` のbody更新が各52回、`MessageRow` が20回、MarkdownのUIView更新が55回あった。現行56のdSYMのUUIDは記録された本体と一致する。原本は `runtime/apple/performance-20261022/iphone-56-*` に置いた。

この操作窓ではオーナーのいう全体的なカクつきを再現できていない。ミラーリング経由の文字入力は30回の試行が1文字にまとまり、入力遅延の試験として成立しなかった。試験文字は送らずに消した。入力の全プロセス記録は採取したが、実入力性能の判定へは使わない。ミラーリングアプリは正規終了した。

## iPhone本体の入力中に検出した停止

オーナーがUSB接続のiPhone本体で日本語入力・変換した36秒のSwiftUI記録では、BellTeamのメインスレッドに開始20.23秒から約571.81msの停止を特定した。対応する高頻度Time Profiler標本では、停止付近のメインスレッド6,388標本のうち約4,305標本に `HomeView.bots` の並べ替えが含まれ、`BellDate.parse` とICUの日付解析が比較の中で繰り返された。`AppStore.sceneChanged(to:) → refreshFromView() → refresh()` の呼び出しも同じ窓にある。これは画面復帰に伴う一覧更新の可能性があり、**日本語入力そのものが停止を起こしたとは断定しない**。一方、会話画面の背後にあるホーム画面でも並べ替えが走り、全体的な一時停止を作れることは実機の呼び出し履歴で確認した。記録と抽出XMLは `runtime/apple/performance-20261022/iphone-56-native-input-*` に置いた。入力した本文は記録・報告していない。

後で`potential-hangs`表を全件読み直すと、56の36秒記録にはBellTeamメインスレッドの250ms超が計6行（約486ms〜1.15秒）あった。上記の日時解析へ原因を絞ったのは最初の約572msの1件で、残る5件の根因は未特定。当初「1件」と報告したのは特定済みの停止だけで、表の全件数としては不正確だった。

`BellDate.parse` は呼び出すたびにISO8601日時解析器を新たに作っていた。`HomeView.bots` と `HomeView.rooms` は並べ替えの比較ごとに左右の日時を解析していた。`BellDate` の解析器をMainActor上で共有し、ホーム画面の各行の日付を並べ替え前に一度だけ計算する修正を作った。同じbody更新中に一覧を二度計算しないよう、表示部品へ計算済み配列を渡す。日時の比較順と同時刻の元の順序は維持する。iPhone SimulatorのDebugビルドと `ConversationFreezeUITests` 1件、Mac CatalystのDebugビルド、`npm test` 635件が成功。修正後のiPhone実機の停止時間は未測定。

## ビルド57の配布前確認

- 固定ソースは `0c3423bc91b862bba88a6ab1437fe1ea693a55bc`。アーカイブ時に `HEAD` とGitHubの `origin/main` が一致し、作業ツリーはcleanだった。公開対象が既定ブランチの祖先であることも確認した。
- iPhone/iPad: `runtime/apple/performance-57/ios-57-corrected.xcarchive` から `ios-export/BellTeam.ipa` を生成。SHA-256は `34abc1e5c15dbc422579cf2288e31e78527e40f4e26bbb3ea910d85df33322d5`。IPA内の本体と通知拡張はともに1.0.3（57）。archiveの厳格な署名確認とApple公式の事前検証は成功。
- Mac Catalyst: `runtime/apple/performance-57/mac-57.xcarchive` から `mac-export/BellTeam.pkg` を生成。SHA-256は `b9b4138deecd2df00ef3ab8effae9f109c5862c899798d2a70442c41a6595a57`。archiveの本体と通知拡張はともに1.0.3（57）。archiveの厳格な署名確認、pkgのInstaller署名確認、Apple公式の事前検証は成功。
- 最初のiOS archive `ios-57.xcarchive` は通知拡張が56だったため配布候補から外した。正本 `project.yml` と生成済み拡張 `Info.plist` を57へ揃えたcommit `0c3423b` から、上記の修正版を作り直した。Appleへ送ったのは修正版だけ。

## ビルド57の内部TestFlight配布

- オーナーの申請「ビルド57をオーナー用内部TestFlightへ送る」で、iPhone/iPadとMacの両方に許可を受けた。送信前に成果物のSHA-256が上記の値と一致し、App Store Connectに57が未登録であることを確認した。
- iOS IPAをApple公式`altool`経由で1回送信し、`No errors uploading archive`を得た。delivery UUIDとbuild IDは`8f1e9146-51d6-41b0-9b87-f43caa3eb305`。App Store Connectで`1.0.3 / IOS`、`processingState=VALID`を読み戻した。
- Mac pkgも同様に1回送信し、`No errors uploading archive`を得た。delivery UUIDとbuild IDは`6f2200ec-14b0-4b6d-9d97-68dcf710198a`。`1.0.3 / MAC_OS`、`processingState=VALID`を読み戻した。
- 両buildを既存の内部グループ「BellTeam オーナー」`58133050-1c39-4915-b6da-aac18b95921b`へ追加し、APIがそれぞれのbuild IDとgroup IDを返した。再読取の`internalBuildState`は両方`IN_BETA_TESTING`。`asc_get_build`はグループ関連そのものを返さないため、紐付けは追加APIの応答と内部テスト状態で確認した。
- iPhone(Kaito)ではTestFlightに57の更新が表示され、そこから導入した。`devicectl`で導入済みBellTeamが`1.0.3 (57)`であることと、起動してホーム画面が表示できることを確認した。
- MacもTestFlightに57の更新が表示され、そこから導入した。`/Applications/BellTeam.app/Contents/Info.plist`のビルド番号は57。起動してホーム画面が表示できることを確認し、確認のために開いたアプリは終了した。iPad実機への導入・操作は未確認。

## iPhone版57の配布後確認

30秒のTime ProfilerをiPhone実機の全プロセスで記録し、BellTeamをホームへ戻して再表示する操作を2回行った。BellTeamのメインスレッドは1,526標本で、その呼び出し履歴に`HomeView.bots.getter`が36標本、`HomeView.recentFirst`が32標本あった。記録した本体UUID`0B1F326C-D78C-34C8-890E-DD17B0C34978`はビルド57のdSYMと一致し、アプリ内のフレームはそのdSYMで確認した。原本は`runtime/apple/performance-20261022/iphone-57-home-profile.trace`、抽出は同じ場所の`iphone-57-home-*.xml`。

250ms超の停止は約612msと586msの2件。どちらの時間窓も、メインスレッド標本はアプリ切り替え時の`FBSSceneSnapshotAction`とSwiftUIレイアウトに集中し、`HomeView.bots`や日時解析のフレームは上位に無い。56の記録はiPhone本体の日本語入力、57の記録はミラーリングでのアプリ切り替えで、採取方法も異なる。これらの標本数や停止件数を修正前後の同条件比較として扱わず、入力中の改善判定は保留する。

オーナーがiPhone本体でBellTeam 57の会話を開き、短文の日本語入力・変換・消去を行った36秒のSwiftUI記録を別に採取した。56と同じ端末・計測テンプレートを使い、ミラーリングは終了した。`potential-hangs`表にはBellTeamメインスレッドの約397msのMicrohangが1行、別にSpringBoardの約278msが1行ある。BellTeamの停止付近2,532標本ではAttributeGraphの型情報走査とSwiftの型名処理が多く、ビルド57のdSYMで引いたアプリ内フレームには`RootView`と`SubscriptionContent`の型情報生成がある。`HomeView.bots`と日時解析は、この停止の上位フレームに無い。原本は`runtime/apple/performance-20261022/iphone-57-native-input-swiftui.trace`、抽出は同じ場所の`iphone-57-native-input-*.xml`。

56の同形式36秒記録の停止6行に対し、57は1行まで減った。ただし入力文・操作順・画面状態を機械的に固定していないため、この差を再現性ある短縮率とは扱わない。57にも停止が残り、スクロールとログ表示の実機性能、電池消費は未判定。オーナーは57を「明らかに軽くなった」が「満足はできない」と評価した。

オーナーは後続方針として、実測を必須にせずAppleアプリのコード上の非効率を複数agentで洗い出し、確認できた効率化をすべて適用して次の内部TestFlightへ出すよう指示した。現行57の改善で完了とはせず、共通コードとOS別画面の調査・修理を続ける。

## コード監査とビルド58の修理

オーナーの指定どおり、実機の性能数値を採用条件にせず、会話表示・入力・画像、状態更新、ホームと予定一覧、Markdownライブラリを複数担当で静的に確認した。既存の画面・通信契約を保ったまま確認できた反復処理を修理した。

- `AppStore`は同値の一覧・設定・全体停止状態を再通知せず、変更のない通知アバターを再保存しない。アバターの取得は独立した対象を同時に解決する。SSEの初回`ready`は再取得を起こさず、切断後の`ready`は取りこぼした変更を再取得する。設定・全体停止・Bot一覧の通知は必要な対象だけを更新する。
- 会話は連続通知中の取得を進行中の1回へまとめ、取得済み行のうち変更した行だけ差し替える。表示行では送信者・返信者の名前を毎行の線形探索で求めず、Bot辞書を一度作る。変わらない行のMarkdown再評価を避ける。
- UIKitの入力欄は文字ごとにSwiftUIへ本文を公開せず、空欄・送信可能性など表示に必要な状態が変わる時と外部からの消去・復元時に通知する。入力欄の高さ計測、貼付可能な画像・ファイル判定を内容が変わらない間は再利用する。
- 会話画像は同じ認証付きURLの取得を共有し、表示寸法に合わせた縮小復号を背景で行う。アバターのdata URL復号と日時解析も同じ値なら再利用する。
- 予定はタブ表示中だけ取得し、連続通知中の取得をまとめる。Bot・ルームの独立した予定GETを同時に進め、画面の日時比較は各予定につき一度だけ解析する。背景移行では進行中のGETを取り消す。
- `enriched-markdown-ios`はコード枠の装飾走査をTextKitの表示範囲へ絞り、表示範囲が未確定な初回は全文を描く。装飾の再描画は寸法・スクロール位置・本文・スタイルが変わる時に行う。修正は同repoの`ae28d48`へ反映し、BellTeamのSwift Package参照をそのcommitへ更新した。

対象のSwift試験31件と会話スクロール5件は修正途中の専用シミュレーターで成功。Markdownライブラリの関連62件もiOSシミュレーターで成功。ビルド58への依存更新後、再接続後の一覧取得試験、質問カードの送信失敗表示、長いMarkdownを伴う過去ログ追加時の読み位置、予定の背景移行・復帰の各一点試験が成功した。質問カードの試験は修正前mainでも同じ失敗を再現し、実際の購読エラー文に期待値を合わせた。予定の試験は旧実装の逐次GET件数を前提としていたため、各対象を一度ずつ取得し背景で新規GETを起こさない契約へ合わせた。リポジトリの`npm test`は641件成功。画像のHTTPS fixtureが必要な画面試験2件は未実施。

## ビルド58の内部配布候補

Appleのソースcommitは`8fb39e4`で、Markdown依存は公開commit`ae28d48`。iPhone/iPad用`runtime/apple/performance-58/ios-58.xcarchive`と`ios-export/BellTeam.ipa`を作った。IPAのSHA-256は`e53f17f5a4ec72ab268056bc1421e23cb53eb7fe50effd5fb17a8cbdb6eb49ce`。アーカイブの本体・通知拡張とIPA内の両者はすべて1.0.3（58）。アーカイブの両署名が有効で、Apple公式の事前検証は`No errors validating archive`。

Mac Catalyst用`runtime/apple/performance-58/mac-58.xcarchive`と`mac-export/BellTeam.pkg`も作った。pkgのSHA-256は`15e88f0eb320d0437675bcb84b0934e37fecf3e60a9de64fe767a4c2fc2b5b90`。アーカイブの本体・通知拡張はともに1.0.3（58）。アプリとInstaller pkgの署名が有効で、Apple公式の事前検証は`No errors validating archive`。App Store Connectで送信前にビルド58が未登録であることを確認した。内部TestFlightへの送信・処理完了・端末導入はこの記録時点では未完了。

サーバーの履歴走査修理は別担当がPR49を本番へ反映した。Appleビルド58の変更はその本番反映に含まれない。サーバーの検証と反映結果は[サーバー履歴の性能記録](2026-10-22-server-history-performance.md)にある。SSEの宛先追加は発火元から常に正確な宛先を確定できず、[未合意の検討材料](../plan_sse-targeted-updates-20261022.md)に留めた。

実Botの編集・削除画面を反復する旧試験は再開していない。旧担当が追加した人工100行fixtureは合成計測だけに使用した。iPad実機の導入・操作、58の実機性能と電池消費は未確認であり、コード上の削減から体感改善率を推定しない。
