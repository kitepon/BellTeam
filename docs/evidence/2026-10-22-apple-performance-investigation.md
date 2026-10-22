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

試作と読み位置修理はビルド57の候補へ含めた。TestFlightへはまだ配布していない。

## iPhone現行56の実機基準

USB接続とiPhoneミラーリングで導入済みのBellTeam 56を開き、送信・設定変更をせず会話のスクロールを記録した。最初の30秒Time Profilerでは短いスクロール2回で250ms超の停止0件。続く41秒のSwiftUI記録では連続スクロールで過去ログの追加まで進み、画面の引っかかり判定0件。250ms超の停止は記録開始0.77秒後の約496msが1件で、スクロール操作開始前のため操作由来とは判定しない。SwiftUIの記録には `MessageText` と `EnrichedMarkdownText` のbody更新が各52回、`MessageRow` が20回、MarkdownのUIView更新が55回あった。現行56のdSYMのUUIDは記録された本体と一致する。原本は `runtime/apple/performance-20261022/iphone-56-*` に置いた。

この操作窓ではオーナーのいう全体的なカクつきを再現できていない。ミラーリング経由の文字入力は30回の試行が1文字にまとまり、入力遅延の試験として成立しなかった。試験文字は送らずに消した。入力の全プロセス記録は採取したが、実入力性能の判定へは使わない。ミラーリングアプリは正規終了した。

## iPhone本体の入力中に検出した停止

オーナーがUSB接続のiPhone本体で日本語入力・変換した36秒のSwiftUI記録では、BellTeamのメインスレッドに開始20.23秒から約571.81msの停止を1件検出した。対応する高頻度Time Profiler標本では、停止付近のメインスレッド6,388標本のうち約4,305標本に `HomeView.bots` の並べ替えが含まれ、`BellDate.parse` とICUの日付解析が比較の中で繰り返された。`AppStore.sceneChanged(to:) → refreshFromView() → refresh()` の呼び出しも同じ窓にある。これは画面復帰に伴う一覧更新の可能性があり、**日本語入力そのものが停止を起こしたとは断定しない**。一方、会話画面の背後にあるホーム画面でも並べ替えが走り、全体的な一時停止を作れることは実機の呼び出し履歴で確認した。記録と抽出XMLは `runtime/apple/performance-20261022/iphone-56-native-input-*` に置いた。入力した本文は記録・報告していない。

`BellDate.parse` は呼び出すたびにISO8601日時解析器を新たに作っていた。`HomeView.bots` と `HomeView.rooms` は並べ替えの比較ごとに左右の日時を解析していた。`BellDate` の解析器をMainActor上で共有し、ホーム画面の各行の日付を並べ替え前に一度だけ計算する修正を作った。同じbody更新中に一覧を二度計算しないよう、表示部品へ計算済み配列を渡す。日時の比較順と同時刻の元の順序は維持する。iPhone SimulatorのDebugビルドと `ConversationFreezeUITests` 1件、Mac CatalystのDebugビルド、`npm test` 635件が成功。修正後のiPhone実機の停止時間は未測定。

## ビルド57の配布前確認

- 固定ソースは `0c3423bc91b862bba88a6ab1437fe1ea693a55bc`。アーカイブ時に `HEAD` とGitHubの `origin/main` が一致し、作業ツリーはcleanだった。公開対象が既定ブランチの祖先であることも確認した。
- iPhone/iPad: `runtime/apple/performance-57/ios-57-corrected.xcarchive` から `ios-export/BellTeam.ipa` を生成。SHA-256は `34abc1e5c15dbc422579cf2288e31e78527e40f4e26bbb3ea910d85df33322d5`。IPA内の本体と通知拡張はともに1.0.3（57）。archiveの厳格な署名確認とApple公式の事前検証は成功。
- Mac Catalyst: `runtime/apple/performance-57/mac-57.xcarchive` から `mac-export/BellTeam.pkg` を生成。SHA-256は `b9b4138deecd2df00ef3ab8effae9f109c5862c899798d2a70442c41a6595a57`。archiveの本体と通知拡張はともに1.0.3（57）。archiveの厳格な署名確認、pkgのInstaller署名確認、Apple公式の事前検証は成功。
- 最初のiOS archive `ios-57.xcarchive` は通知拡張が56だったため配布候補から外した。正本 `project.yml` と生成済み拡張 `Info.plist` を57へ揃えたcommit `0c3423b` から、上記の修正版を作り直した。Appleへの送信はまだ行っていない。

## 次に確かめること

1. オーナーがiPhone本体で日本語入力・変換する間に、USBで実入力を短く記録する。ミラーリングを経由しない操作で、入力欄の更新と停止時間を確認する。
2. 修正候補をiPhoneへ届けた後、同じ会話の入力・画面復帰で停止時間を比べる。`.equatable()` の実機効果と入力欄の重さも分ける。トロニーから会話件数と本文長の集計は受領済み。
3. 現行56で検出した約572msの停止がビルド57で減るか、iPhone実機の同じ画面復帰・入力操作で比べる。iPad・Macの共通動作も確認する。

実Botの編集・削除画面を反復する旧試験は再開しない。本番とTestFlight配布物は変更していない。旧担当が追加した人工100行fixtureは `PreviewFixtures.swift` と `ConversationView.swift` にあり、合成計測へ利用した。修正範囲は `MessageText.swift` の比較、`ConversationView.swift` の `.equatable()` と位置固定状態、`ConversationScrollUITests.swift` の可視判定と新着後の取得判定、`BellTheme.swift` の日時解析器、`HomeView.swift` の並べ替え。`project.yml` と生成済み `Info.plist` のビルド番号は57へ採番した。
