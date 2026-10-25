# Apple共通入力欄の行高が更新されない不具合

オーナーはiPhone・iPad・Macの入力欄について、本文が増えても入力欄が広がらず、4行程度で内部スクロールになり、時には1行しか見えないと報告した。iPhone・iPad・Macが使う`ConversationView`内の同じ`MessageInput`と`MessageTextView`を調査した。

## iPhoneでの再現

iPhone 16 Pro Max / iOS 26.5 Simulatorの隔離プレビュー会話で、入力欄へ`A\nB\nC\nD`を入力した。修理前は本文の値が4行でも、入力欄の高さは1行時19.33ptから変わらず、画面には末尾の`D`だけが見えた。[修理前の画面](images/2026-10-25-composer-height-before.png)。画面試験原本は`~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-bf30729c2d6d/result-bundles/test_sim_2026-10-25T07-09-18-840Z_pid8412_72f87992.xcresult`で、1件失敗の理由も19.33pt→19.33ptだった。実Botへは送信していない。

## 原因と修理

`textViewDidChange`は`MessageTextView`の行高キャッシュを無効にするが、UIKitの固有サイズを無効にしない。`ConversationDraft`が親SwiftUIへ変更を通知するのは空欄表示と送信可否が変わる時だけなので、2文字目以降の改行では`UIViewRepresentable.sizeThatFits`が再評価されず、1行のレイアウトに残る。

既存の`invalidateSizeMeasurement()`から`invalidateIntrinsicContentSize()`を呼び、UIKitから親レイアウトへ再計測を伝える。文字ごとのアプリ全体通知、行数の重複状態、追加の再試行は設けない。

同じiPhone試験は修理後1件成功・失敗0件となり、4行全体が見えた。[修理後の画面](images/2026-10-25-composer-height-after.png)。原本は`~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-bf30729c2d6d/result-bundles/test_sim_2026-10-25T07-11-45-280Z_pid8412_ea3c2c43.xcresult`。

## iPadとMacの確認

iPad Pro 11インチ（M5）/ iOS 27.0 Simulatorでも同じ4行画面試験が1件成功・失敗0件だった。[iPadの4行画面](images/2026-10-25-composer-ipad-four-lines.png)。指定時はiOS 26.5のSimulatorを選んだが、試験ツールが同名のiOS 27.0を使用したため、実行結果は27.0として記録する。原本は`~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-bf30729c2d6d/result-bundles/test_sim_2026-10-25T07-58-56-825Z_pid8412_d8f382f8.xcresult`。Simulatorは試験後にShutdownを確認した。

iPhoneでは10行の日本語本文をシステムのペーストメニューから貼り付け、本文の全行が入力値へ入り、入力欄が5行分まで広がって末尾とカーソルが見える画面試験が1件成功・失敗0件だった。[貼り付け後の画面](images/2026-10-25-composer-iphone-paste-ten-lines.png)。原本は`~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-bf30729c2d6d/result-bundles/test_sim_2026-10-25T08-04-08-986Z_pid8412_c335412b.xcresult`。日本語の文字列を貼った結果であり、実際のIME変換操作を試した結果ではない。

Macでは通常版と別識別子`dev.kitepon.bellbot.scrollprobe`のDebug版を隔離プレビュー会話で起動し、物理キー入力による同じ4行を確認した。入力欄は1行21pt→4行84ptに広がり、6行では105ptの上限で止まり、末尾の`F`とカーソルが見えた。[Macの4行](images/2026-10-25-composer-mac-four-lines.png)、[6行の上限](images/2026-10-25-composer-mac-six-lines.png)。全文選択後に`G`へ置き換えると21ptへ縮み、長い本文の折り返しでも63ptへ広がった。試験後は隔離アプリを通常終了し、PID消失を確認した。

Jevのアクセシビリティ値の直接設定は、表示値だけを変えて`UITextViewDelegate`の文字変更を通さなかったため、Macの製品挙動の証拠に使っていない。物理キー操作で得た値と画面を上の結果とした。Macの窓幅変更は操作ツールが時間切れとなり実施できず、実際の日本語IME変換も未確認。通常のオーナーアプリには触れていない。

## 版66の内部配布と実使用

上の記録は修理時点の観測である。修理PR #83と版番号PR #84をGitHub `main`へ統合し、オーナーの新たな許可を受けて版66をiOS・Macの内部TestFlightへ配布した。両platformでAppleの`VALID`と`IN_BETA_TESTING`を確認。MacはTestFlightから66へ更新し、本体・通知拡張の番号、署名、起動後の一覧を確認した。署名ソース、配布物のハッシュ、Apple受付番号と導入結果は[版66配布記録](2026-10-25-apple-build66-manifest.json)にまとめた。

オーナーは通常使用で「入力した行が見える」と回答した。これを入力欄の実使用合格と判定する。回答に端末名と操作順は含まれていないので、実際の日本語IME変換やMac窓幅変更を個別に確認済みとは扱わない。
