# Apple画像操作シートの現画像プレビュー

取消の修理を含む製品sourceは`fdc237ffe2e32e211adee90f0115df1cbcbff3fd`。版74の署名済みsource `05cee9c91d055db644ccd0f32c01965ea3d0d31d`と成果物には含めない。

オーナーは大小画像の操作シートで現在画像が見えず、開く時に再読み込みのような動きがあると指摘した。添付2枚はRootが確認し、こちらでは原本画像を直接読んでいない。ソースでは`BotProfileAvatarActions`にプレビューがなく、シートの`.task(id: bot.id)`が毎回Bot詳細をGETし、完了まで「画像変更」「画像調整」を表示しない。さらに中央揃えのVStackへ読み込み表示を追加すると、画像とボタンが一緒に移動した。

追加レビューで、変更前にシートに結び付いていた`.task`を手動の準備GET・調整GETへ移した際、シートの離脱による取消を引き継いでいないことが分かった。閉じた後の遅延成功で写真選択または調整画面が開く余地があり、遅延した認証エラーはアプリ全体のログイン要求へ進めた。これはソース経路の指摘で、実画面で古い写真選択が開いた再現ではない。

共有の`BotProfileHero`が持つ現在の小画像、取得済み大画像、大画像が小画像へ追従する場合を操作シートへ渡し、保存待ち選択のrenderを対象画像だけ優先して表示する。独立した大画像が未取得なら小画像を大画像として見せず、固定寸法のプレースホルダーを使う。画像とボタンは上端に固定し、読取状態・失敗はボタンより下へ出す。シートを開くだけの詳細GETを外し、調整を選んだ時、または写真選択を開く前に完全なsource/cropをGETする。写真選択前の認証失敗なら未選択のまま止まる。旧schema・認証・通常GET失敗は既存の説明と再読込経路で示し、元画像と保存待ち選択を消さない。保存の対象画像3項目、古い応答の一致確認、取消と明示破棄は変更しない。

準備GETは`AvatarImagePicker`、調整GETは`BotProfileAvatarActions`がTaskを保持し、シート離脱・保存中の無効化で取消す。開始時の操作世代が現在も有効な時だけ、GET成功、認証・通常失敗、写真選択表示、調整画面への移行を反映する。自動GET・PATCH再送は追加しない。

## 実測

- `AvatarImageTests/testProfileSheetPreviewUsesCurrentVariantAndPendingSelection`は1件成功・失敗0。小画像、独立大画像、小画像追従、独立大画像の未取得、対象別の保存待ち選択を確認。XCResult: `~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-bf5fe1dd20e1/result-bundles/test_sim_2026-10-29T04-40-33-012Z_pid49890_6aae5df4.xcresult`。
- `AvatarImageTests/testAvatarActionLifetimeRejectsLateSuccessAuthenticationAndFailure`は1件成功・失敗0。閉じる・無効化後の旧操作世代は再表示後も受け付けず、現在世代だけを受け付ける。XCResult: `~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-bf5fe1dd20e1/result-bundles/test_sim_2026-10-29T05-15-25-564Z_pid49890_e35abc6c.xcresult`。これは実画面での遅延認証を代用しない。
- 新しいiPhone UI試験はSimulatorがXCTest runner起動を`SBMainWorkspace Busy (Application failed preflight checks)`で拒否し、試験本体は未実行。XCResult: `~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-bf5fe1dd20e1/result-bundles/test_sim_2026-10-29T04-41-24-611Z_pid49890_a62e098c.xcresult`。この結果を合格扱いしない。
- 同じ人工サーバーとiPhone Simulatorでアプリを直接起動して観測。小画像シートを開いた時点でBot詳細GET 0・PATCH 0。15秒遅延の調整用GET中も現在画像と両ボタンの位置は同じで、取得後に既存の調整editorへ進んだ。小画像を取消して大画像シートを開いても詳細GETは累計1・PATCH 0。画面は[小画像](images/2026-10-29-apple-avatar-sheet-small.jpg)、[遅延GET中](images/2026-10-29-apple-avatar-sheet-small-loading.jpg)、[大画像](images/2026-10-29-apple-avatar-sheet-large.jpg)。写真選択の準備経路を追加した後も、シートopenは詳細GET 0・PATCH 0、画像変更を押した時だけ詳細GET 1の完了後にiOS写真選択が開くことを直接確認した。写真は選択していない。
- 取消修理後の人工iPhoneでは、15秒遅延の調整GETを開始してシートを閉じ、待機後も詳細画面に留まり調整editorは開かなかった。写真選択の準備GETでも閉じた後はpickerが現れず、シートを開き直した現行操作ではGET完了後にpickerが開いた。Bot詳細GETは各1回、PATCH 0。実画像の選択と遅延認証・失敗の実画面再現はしていない。
- 取消修理後のiOS Simulator focused試験と人工アプリのDebug build、Mac Catalyst Debug buildは終了0。Macログ `runtime/apple/avatar-sheet-preview/mac-cancel-build.log` のSHA256は`316aa124087eba54d0581514b9c8301144a1814fc8ee56afcfa00fb2341bfca9`。ログ中の`error: ... exit code 0`はXcodeの文で、実プロセス終了0とは区別する。既知のAppStore actor隔離警告以外の新しい警告は確認していない。

既成功の画像保存UI・Save・Node全群は再実行していない。Mac・iPadの実画面と実オーナー画像は未確認。人工サーバー、アプリ、Simulatorは終了確認済み。実Bot、版74の署名・upload、BellTeam本番は操作していない。
