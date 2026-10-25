# AppleアプリのAI動作停止（2026-10-21）

オーナーはメンバーの今の動作を止める入口を依頼した。メンバー・会話・予定は削除しない。サーバー・API・transportとWeb入口はトロニー、iPhone・Mac共通アプリはベルが担当する。本番メンバーを試験で停止しない。

アプリ修理は`811be73`、取消を結果未確認として扱う補足は`2e91407`。個別会話では動作中・送信待ちのメンバーに、入力欄と送信ボタンの間で■の停止ボタンを表示する。ルームでは対象メンバーの行に停止を表示する。確認ダイアログは出さず、下書きは保持する。

アプリはbody無しの`POST /api/bots/:botId/stop`を送る。HTTP 200の応答で`botId`が対象と一致し、`status=stopped`、`online=false`の時だけ、その時点のAiterm席の停止を確認済みと表示する。HTTP 502・通信断・応答の欠落や不一致・要求の取消は結果未確認として扱い、自動再送しない。キューから項目が消えたことだけを停止完了の根拠にしない。成功後は既存のGETとSSEで会話・キュー・一覧を更新する。新しい依頼でメンバーが再起動しても、前回の停止確認を取り消さない。配送の`stopped`は会話で「停止」と表示する。

Simulatorでは停止APIの200・不一致・202・502・通信断・404を扱う対象2件、個別会話の■と下書き保持・ルームの対象別停止のUI2件、配送状態3件が成功した。Mac Catalystのビルドは成功。最初のUI試験は生成済みXcodeプロジェクトに新ファイルが未登録で0件となったため、`xcodegen`で再生成して2件の実行結果を確認した。既存の`WKWebsiteDataStore.default()`のactor警告は今回の変更箇所ではない。

内部配布候補はcommit`48169ab`の1.0.2（55）。`runtime/apple/ai-stop-55/`にiPhone archive・IPAとMac Catalyst archive・pkgを保存した。本体と通知拡張の版は両platformで1.0.2（55）。IPA内の両署名、Mac archiveの署名とpkgの署名を検証し、Apple公式`altool`の事前検証は両成果物で`No errors validating archive`。IPAのSHA-256は`08c0957e24a838c031d861efa63f7038d01e2231979e4e4780668b5cb08ef568`、pkgは`97d0297cf46ede0986109df3cbcba7bcf8a41b09f167abe0341f0ed9ad8e73d4`。

Appleへの送信、TestFlight内部配布、端末導入・起動、実メンバー停止は未実施。サーバーAPIの実装・隔離試験の結果を照合した後、内部TestFlight送信は従来の成果物ごとの個別承認に従う。

## 全体停止の追加依頼

オーナーから、担当が呼んだ相手の連鎖停止とBellTeam全体停止のON/OFFが追加で依頼された。連鎖停止の実行はAiterm、全体停止の状態・起動/配送/予定の制御はBellTeam本体が持つ。Appleアプリは全体停止の表示と操作を担当する。

アプリcommit`d1b2f39`で共通設定画面へトグルを追加した。GETの状態を正本として、ON要求の202は「停止中」、全対象を確認した`stopped`だけを停止済みと表示する。502・503・通信断ではPATCHを自動再送せずGETで状態を読み直す。GET不能なら古いON/OFFを隠し、状態未確認を表示する。SSEの`ai-control`と前面復帰でも読み直す。ON中に送信や手動予定実行が423で拒否された時は、全体停止中と案内する。Simulatorの対象4件とMac Catalystビルドが成功した。本番の全体停止は試していない。

上記の55 IPA・pkgは全体停止トグルを含まない旧候補となった。Appleへ送信しない。全体停止APIと連鎖停止の責務境界がmainで確定した後、新しい配布成果物を作る。

## 2026-10-22 会話を残す中断方式への訂正

オーナーはEsc相当で現在の処理を中断し、会話セッションを残す方式に訂正した。上記の`status=stopped`・`online=false`・再起動を前提とする個別停止の記録は、旧契約の履歴であり、新しい配布物の受入条件には使わない。

新しい個別API契約は、body無しの`POST /api/bots/:id/stop`に対し、HTTP 200で`botId`一致・`status=interrupted`・`sessionPreserved=true`が揃った場合だけ中断確認済みとする。`online`とキューの消失を成功条件にしない。200以外、不正応答、通信断では完了表示も自動再送もしない。個別会話には、同じ会話で新しい依頼を続けられると表示する。全体停止の`stopped`は、全対象の処理中断または実行なし、会話維持、コマンド終了が確認された状態として表示する。

AppleアプリのAPI判定・会話表示・全体停止表示と契約試験を更新した。Simulatorの個別API対象2件が成功し、Mac Catalystビルドも終了コード0で成功した。既存の`WKWebsiteDataStore.default()`のactor警告は残る。Nodeの関連gateと`TESTGATE_FULL=1 npm test`も終了コード0で成功した。本番メンバーの中断、Aiterm実runtimeの受入、Appleへの送信は行っていない。旧55のIPA・pkgは新方式も全体停止トグルも含まないため、配布しない。新たな採番・署名はruntime受入と成果物ごとの従来の条件が整ってから行う。

## 2026-10-22 停止操作の送信受付

サーバーの個別停止は`POST /api/bots/:id/stop`のHTTP 202 `{botId,status:"stop_sent"}`を返す方式へ変わった。これは通常中断操作を送った確認であり、処理の終了証明ではない。Appleアプリは202と対象ID・`stop_sent`の一致で「停止操作を送りました。会話は続けられます。」と表示する。旧HTTP 200の`interrupted`・`sessionPreserved:true`は別の確認済み結果として読み続ける。HTTP statusと本文が食い違う時、502、通信断、不正応答は成功扱いせず、自動再送しない。全体停止の`stopped`表示も全対象への操作送信成功を表す文言に直した。停止ボタンの位置と表示条件は変えていない。

Foundationだけの応答モデルを使った合成JSON単体確認7件は成功。既存URLProtocol試験のfixtureも202・旧200・不正応答へ更新し、Xcodeの`build-for-testing`でコンパイルした。アプリ本体のビルドも成功した。いずれもビルド専用で、Simulatorの起動・導入やXCTestの実行はしていない。Macの実画面、実メンバー、TestFlight、配布物にも触れていない。
