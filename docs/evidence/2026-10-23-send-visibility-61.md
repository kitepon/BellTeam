# 送信本文が入力欄の背後に残る問題 — Apple版61

出典: オーナーの版60実機判定と画面、トロニーとの既存通話102・103・107、BellTeamの隔離iPhone Simulator試験とDebug配置ログ、オーナーの版61実機回答。取得日: 2026-10-23。確度: 人工履歴・隔離通信での再現と修理後の位置は実測。版61のiPhone操作感はオーナー本人の確認結果。

## 版60の残症状と原因

オーナーのiPhoneでは、送信した白い吹き出しの上端だけが入力欄の背後に残った。通話で確認した同時刻のPOSTはHTTP200まで2,411msだが、対応候補の履歴保存は開始から78msだった。画像と時刻だけでは主スレッド停止を証明できない。一方、版60の試験は本文行の存在だけを確認し、有効な会話領域に読めるかを測っていなかった。

隔離試験では、35件の先行履歴と長い直前返信を読み、かなキーボードを開き直して短文を送った。POST応答を保留してSSEだけ先に送ると、版60は仮行・正本行とも本文下端が画面上の877.7pt、有効な会話領域の下端が567.7ptで、約310pt下に隠れた。スクロールしないで最初から末尾にいる条件では同じ試験が通る。

Debug時系列では、仮行追加による高さ変化で古い`visibleAnchor`へ戻す処理が走り、4ms後の明示的な末尾スクロール要求を、さらに2回の高さ変化による旧位置補正が打ち消した。修理は`ConversationView.swift`のスクロール状態だけに置いた。送信で末尾へ移る意図を仮行追加前に立て、末尾到達までは旧読書位置の補正を適用しない。通常の過去ログ閲覧時の位置保持は残す。

変更ファイルは`ios/BellBot/BellBot/Views/ConversationView.swift`、可視性のUI試験`ios/BellBot/BellBotUITests/NetworkLifecycleProbeUITests.swift`、人工履歴・保留POST・先着SSEの`test/fixtures/bughub-ui-probe.mjs`、版61の`ios/BellBot/project.yml`と本体・通知拡張の`Info.plist`。

## 修理後の確認

同じ人工条件で仮行と正本行の本文全体が入力欄より上に表示され、応答待ち中の追加入力とその下書き保持、会話スクロールも成功した。関連UI試験では、通常の即時表示、読書中の新着で末尾へ飛ばない動作、過去ログ追加時の位置保持の計4件が成功。Debug専用のアプリ内時刻では仮行の初回配置が押下処理から19.4ms、本文全体の初回可視化が229.6msだった。XCTestの操作・待機時間を含むUI発見時刻とは分けた値であり、実機の停止時間や電池消費を示すものではない。Debug計測コードは製品差分から除去した。

版61の最終ソースでiPhoneの同可視性試験を再実行し、仮行・正本行とも本文下端491.7pt、入力欄上端567.7ptだった。Mac Catalyst Debugビルドは成功し、`TESTGATE_FULL=1 npm test`は705件成功、失敗・skipゼロ。変更後のアプリを実機へ入れた結果ではないため、オーナーの体感判定は保留する。

版60の送信失敗・結果不明・連続同文・画像・背景復帰の扱いと既存IDによる正本照合は変更していない。診断分類の別件修理は、この版の表示修理へ混ぜていない。

## 版61の内部配布と導入後確認

製品ソースと版番号のcommitは`a0289ea634d14a7a412c660f004b9448914f8351`で、GitHub `main`へ通常pushした。アーカイブ時にAppleソースの未commit差分はなく、このcommitが`origin/main`の祖先であることを確認した。iPhone/iPadとMacのアーカイブは両方成功し、本体と通知拡張はいずれも`1.0.3 (61)`。両アーカイブの厳格な署名検証、iOS IPAとMac pkgのApple公式事前検証、Mac pkgのInstaller署名確認が成功した。

| 成果物 | SHA-256 | Apple build ID | 読戻した状態 |
| --- | --- | --- | --- |
| iPhone/iPad用`runtime/apple/send-visibility61/ios-export/BellTeam.ipa` | `c36d7c8d75eff4d7953bb42dd433fb9dccd5e62e6d6eb19dbab6634a4c9fc820` | `db20a4ea-475a-4cd2-8139-ab09c9036509` | `VALID`、オーナー用内部グループで`IN_BETA_TESTING` |
| Mac用`runtime/apple/send-visibility61/mac-export/BellTeam.pkg` | `e53605497d7a87dd72c6cbdce54264a7e61cfac730e8267e54e0479fc0e4491f` | `667db38e-e583-4a78-8bc1-7fc5e512820c` | `VALID`、同グループで`IN_BETA_TESTING` |

MacのTestFlight画面が版61と「アップデート」を表示したことを確認して導入した。`/Applications/BellTeam.app`本体と通知拡張は61で、厳格な署名検証とGatekeeperの`source=Testflight`判定は成功。通常起動し、トロニーの直接会話を開き、試験文字の物理入力で送信ボタンが有効、全消去で無効に戻ることを確認した。試験文字は送信せず、確認用に起動したアプリは終了した。

TestFlightの操作はまず`jev-desktop`へ依頼したが、項目選択が`ACTION_NOT_SUPPORTED`で止まった。画面を読み直して対象を版61に限定し、同じ上流の`agent-desktop`で更新した。BellTeamサーバー本体の変更と本番コンテナ再起動は行っていない。

オーナーは決裁箱「BellTeam版61の送信直後の見え方を確認」に「本文がすぐ全文見え、操作も問題ない」と回答した。これはiPhone実機での本人確認であり、停止時間の計測値ではない。版61の送信本文の可視性修理は受入合格と判定する。
