# AppleアプリのAI動作停止（2026-10-21）

オーナーはメンバーの今の動作を止める入口を依頼した。メンバー・会話・予定は削除しない。サーバー・API・transportとWeb入口はトロニー、iPhone・Mac共通アプリはベルが担当する。本番メンバーを試験で停止しない。

アプリ修理は`811be73`、取消を結果未確認として扱う補足は`2e91407`。個別会話では動作中・送信待ちのメンバーに、入力欄と送信ボタンの間で■の停止ボタンを表示する。ルームでは対象メンバーの行に停止を表示する。確認ダイアログは出さず、下書きは保持する。

アプリはbody無しの`POST /api/bots/:botId/stop`を送る。HTTP 200の応答で`botId`が対象と一致し、`status=stopped`、`online=false`の時だけ、その時点のAiterm席の停止を確認済みと表示する。HTTP 502・通信断・応答の欠落や不一致・要求の取消は結果未確認として扱い、自動再送しない。キューから項目が消えたことだけを停止完了の根拠にしない。成功後は既存のGETとSSEで会話・キュー・一覧を更新する。新しい依頼でメンバーが再起動しても、前回の停止確認を取り消さない。配送の`stopped`は会話で「停止」と表示する。

Simulatorでは停止APIの200・不一致・202・502・通信断・404を扱う対象2件、個別会話の■と下書き保持・ルームの対象別停止のUI2件、配送状態3件が成功した。Mac Catalystのビルドは成功。最初のUI試験は生成済みXcodeプロジェクトに新ファイルが未登録で0件となったため、`xcodegen`で再生成して2件の実行結果を確認した。既存の`WKWebsiteDataStore.default()`のactor警告は今回の変更箇所ではない。

内部配布候補はcommit`48169ab`の1.0.2（55）。`runtime/apple/ai-stop-55/`にiPhone archive・IPAとMac Catalyst archive・pkgを保存した。本体と通知拡張の版は両platformで1.0.2（55）。IPA内の両署名、Mac archiveの署名とpkgの署名を検証し、Apple公式`altool`の事前検証は両成果物で`No errors validating archive`。IPAのSHA-256は`08c0957e24a838c031d861efa63f7038d01e2231979e4e4780668b5cb08ef568`、pkgは`97d0297cf46ede0986109df3cbcba7bcf8a41b09f167abe0341f0ed9ad8e73d4`。

Appleへの送信、TestFlight内部配布、端末導入・起動、実メンバー停止は未実施。サーバーAPIの実装・隔離試験の結果を照合した後、内部TestFlight送信は従来の成果物ごとの個別承認に従う。
