# iPhoneの画像変更で選択が消える経路と、操作シートの取り付け先の修理

オーナーの報告は「画像変更画面を開いた直後、数秒以内に、一回再読み込みが入るみたいで、ユーザーの画像選択が無効化されててしまう」（実機iPhone）。決裁箱「iPhone画像変更の「再読み込み」の後、画面はどこに戻る？」（K-ZLWUDV）への回答は「写真一覧が閉じて『画像変更・画像調整』のボタン画面に戻る」、添え書きで「切り抜き画面は出るが位置・拡大が初期値に戻る、も発生」。

修理前のsourceは`93fbf0eaf9ebcc86f3b124e3f8e10dab8edb5a78`（GitHub main）。

## 反例

Codex側ベルが人工iPhoneで作った反例をそのまま使った。Bot小画像の「画像変更」で詳細GETを4.5秒遅らせ、「画像情報を確認しています…」の表示中に人工SSEのBot更新を届け、ホームへ移してから前面へ戻すと、写真一覧が8秒待っても開かない。試験は`ProfileTerminalUITests.testPhoneImageChangePreparationSurvivesBotRefreshAndForegroundReturn`（Codex側の未commit原本を複写。原本のSHA256は`b5faeffabb702bc4266c3823bfeea9ab4f18f49941022c51c355e8c9e03ed1d5`、fixtureは`fb7913eaf965ed4935d054e56d6ae0962e0ba294ddced06b9c91deb49cc02f9e`、引継ぎJSONは`cacba591b737afe2a97958ade7d3829f9b5d848ce2714cb1e55a4e745526ab4a`）。修理前のsourceで3回走らせ、3回とも328行で失敗した。

## 観測した機構

`os_log`で各Viewの`onAppear`/`onDisappear`と`AvatarActionLifetime.generation`を記録した（記録は調査用で製品差分に含めない）。

- 画像操作シートの中身`BotProfileAvatarActions`とその中の`AvatarImagePicker`が、`onDisappear`（generation=2）の直後に`onAppear`（generation=1）で現れる。generationが1へ戻るのは`@State`が新品になった証拠で、シートの中身が丸ごと破棄・再生成されている。親の`BotProfileHero`と`ConversationDetailView`は`onAppear`が1回だけで生き残る。
- 再生成が起こるのは、シート出現の約0.6秒後（詳細シートの再配置）と、ホームからの前面復帰（1回の復帰で3〜5回）。人工SSEによるBot一覧更新だけでは起こらない。
- 再生成の道連れで`AvatarImagePicker.onDisappear`→`cancelPreparation`が準備Taskを取り消し、「prepare done ok=false cancelled=true」となってPhotosPickerは開かない。写真一覧が開いた後に再生成が起こると、`presenting`が新品のfalseに戻って一覧が閉じる（オーナー回答の「写真一覧が閉じてボタン画面に戻る」）。切り抜き中なら`AvatarCropEditor`の`zoom`/`offset`が初期値に戻る（同「初期値に戻る」）。
- 切り分け。詳細シートの`presentationDetents`を外すと0.6秒後の再生成は消えるが前面復帰の再生成は残る。詳細の兄弟`.sheet`を外す、`ScrollView`を外す、`.sheet(item:)`を`.sheet(isPresented:)`へ変える、`.fullScreenCover`へ変える、`.disabled`/`.interactiveDismissDisabled`を外す、のいずれも再生成は残る。詳細画面の根（`NavigationStack`直下）に付いた`.sheet(isPresented: $showingScreen)`の`BotScreenView`は、同じ前面復帰で`onAppear`1回のまま生き残る。

結論: 子View（`BotProfileHero`）に付けた`.sheet`は、前面復帰や詳細シートの再配置のような環境変化で中身が作り直される。画面の根に付けたシートは作り直されない。

実機では、PhotosPickerを開く・閉じるだけでscenePhaseがinactive/activeへ動き、実serverの更新も重なるため、「画像変更画面を開いた直後、数秒以内」に同じ再生成が起こる。実機のrequest/操作時刻を結んだ実測ではなく、人工再現とオーナー回答の一致による判断である。

## 修理

`BotProfileHero`が持っていた画像操作の状態（操作対象・選択画像・詳細設定・保存待ち・保存中・結果表示・大画像）を`BotProfileImageState`（`ObservableObject`）へ移し、操作シートは`botProfileImageActions(bot:images:)`で画面の根へ付ける。iPhoneは`ConversationDetailView`の`NavigationStack`直下、iPad/Macは`DesktopInspector`の根に付け、両方とも`@StateObject`で同じ状態をHeroへ渡す。保存・確認・破棄の処理、保存待ち選択の契約、PATCHの内容、API、`AvatarImagePicker`/`AvatarCropEditor`は変えていない。

## 有限検証

- 修理後、同じ反例試験を2回走らせた。1回目は写真一覧（PhotosPicker）が開いたうえで一覧の読込（「読み込み中…」）が8秒に間に合わず失敗した（再インストール直後のPhotosUI初回起動。録画のSHA256 `0c8fdd5c9dcbe4637939d665f5eb4b675671851a216729f2a4a96156f929b530`）。一覧読込遅れという製作者の判定で、失敗結果はそのまま保持する。2回目は成功し、記録では`Actions onAppear`1回、準備完了後に一覧が開き、切り抜きへ進んだ。
- 関連試験の結果は下の表。

XCResultと録画は`~/Library/Developer/BellTeam-evidence/2026-10-30-apple-avatar-sheet-root/`に置いた（修理前の失敗3回は`prep-repro-1〜3.xcresult`、修理後の反例試験は`fix-prep-1.xcresult`（一覧読込遅れの失敗、録画`fix-prep-1-recording.mp4`）と`fix-prep-2.xcresult`（成功）、関連試験は`fix-related-1.xcresult`）。試験はiPhone 17 Pro Simulator（iOS 26.5、OS build `23F77`）、人工server`test/helpers/profile-terminal-ui-server.mjs`。6件のXCResult summaryの`devicesAndConfigurations[].device`を照合した。初報のiOS 27.0は環境表記の誤りとして訂正する。Xcode 27.1（27A9275）は製作者の初報であり、保持原本による独立照合はしていない。

| 試験（`ProfileTerminalUITests`） | 結果 |
| --- | --- |
| testPhoneImageChangePreparationSurvivesBotRefreshAndForegroundReturn（反例） | 成功 |
| testPhoneChosenPhotoSurvivesBotRefreshBeforeUse | 成功 |
| testPhoneCropEditorKeepsAdjustmentAcrossBotRefresh | 成功 |
| testPhoneAvatarSheetShowsCurrentImagesWithoutReloadingOnOpen | 成功 |
| testPhoneSmallCropSavesWithoutReplacingLargeImage | 成功 |
| testPhoneLargeCropSavesSquareSelectionAndKeepsSmallImage | 成功 |
| testPhoneImageTargetsStaySeparateAndCancelDoesNotSave | 成功 |
| testOldProfileSchemaKeepsTextSaveAndDisablesNewImageEditing | 成功 |

8件成功・失敗0（`fix-related-1.xcresult`）。

## 未確認

- 実機iPhoneでの回復は未確認。実機では版78にこの修理は入っていない。
- 製作者はiPad/MacのUI試験を走らせていない。別途センチが同じ製品source `bf8e5b2` のiPad Simulator 26.5/23F77で画像調整のfocused試験1件成功（切り抜き保持と小画像3項目のみの一回保存）、Mac Catalyst arm64/x86_64の署名無しbuild終了0を確認した。iPad写真importとMacの実UI操作は未確認。
- 実オーナー画像・実Bot・署名・配布・本番の操作はしていない。

## 環境表記の訂正と原本の扱い

2026-10-30、保存済み6XCResult summaryを根拠に環境表記を訂正した。元commit `bf8e5b2851fe27369475b76324fd7f7be4b927e3` の文書と、製作者の元`manifest.json`（7880B、SHA256 `db8abd79a98f9fbc685a2871447ca17367b776d2469c7be704dd4724a10b7227`）は履歴として保持し、過去の試験結果は改変しない。修理前3件と`fix-prep-2`は診断ログ注入あり、`fix-prep-1`と関連8件は製品sourceと同内容・診断注入なし。診断sourceの完全復元とxcodebuild全文logは残っていない。訂正に伴う製品sourceの変更、既試験の再走は行っていない。
