# iPhoneの画像調整中に作業が戻る経路

修理sourceは`071fbedb46c20416da6997b3d29ebd071c7a5a24`。オーナーの観測は「画像変更・調整の作業中、リロードされたようにそれまでの作業が結果的になかったことになる。60秒も持たずに発生する」。一定周期、明示的な消去、保存前後、対象画像を原因前提にしない。

人工iPhoneの既存Bot詳細で小画像の「画像調整」を開き、拡大値を1から2.53へ変えた。人工SSEのBot更新1回では編集画面と2.53を保持した。続けてホーム画面へ移りアプリを前面へ戻すと、切り抜き画面が消え、小画像の操作シートへ戻った。失敗時のAX階層には「画像変更」「画像調整」があり、拡大Sliderは表示されなかった。再現XCResult: `~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-bf5fe1dd20e1/result-bundles/test_sim_2026-10-29T14-43-54-171Z_pid90630_a49ef59e.xcresult`。プレビューアプリは前面復帰時の通信更新を抑えるため、これは通信GETによる再読込の実証ではない。

段階的に状態の所有先を確認した。選択画像だけを親の`BotProfileHero`へ移すと、復帰後の操作シートには「選択した画像」が残ったが、編集画面は消えた。詳細設定も親へ移すと編集画面は残り、拡大値だけが初期値1へ戻った。元の`BotProfileAvatarActions`の`cropSource`・`settings`と`AvatarCropEditor`の調整値が、復帰で作り直された子Viewの状態にだけ依存していた。

既存の親`BotProfileHero`が、操作シートを開いている間の選択画像と詳細設定を保持する。編集後の切り抜き矩形も拡大・ドラッグの操作完了ごとに親へ渡し、子Viewが作り直された時に既存の`initialCrop`から復元する。新しい操作シートを利用者が開いた時は前回の編集中状態を消す。保存待ち選択の契約、対象画像だけのPATCH、再送、ID、APIは変えていない。

## 有限検証

- 人工Bot更新と前面復帰を同じ画像調整中に通すfocused UI試験は1件成功・失敗0。編集画面と変更後の拡大値を保持し、明示キャンセル後の開き直しでは未保存の調整値を持ち込まなかった。XCResult: `~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-bf5fe1dd20e1/result-bundles/test_sim_2026-10-29T15-04-34-984Z_pid90630_c6943bfa.xcresult`。
- 変更後の既存iPhone大小画像保存UI試験は2件成功・失敗0。小画像の保存は小画像tripletだけ、大画像の保存は大画像tripletだけをPATCHした。XCResult: `~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-bf5fe1dd20e1/result-bundles/test_sim_2026-10-29T14-53-50-898Z_pid90630_f6401585.xcresult`。
- 既存の小画像調整取消→大画像操作シートの試験は1件成功・失敗0。取消だけのPATCHは0。XCResult: `~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-bf5fe1dd20e1/result-bundles/test_sim_2026-10-29T15-03-09-958Z_pid90630_c43d272a.xcresult`。
- Mac Catalyst Debug buildは実終了0。ログ`runtime/apple/avatar-edit-reset/mac-build.log`のSHA256は`1c7eb1c7cd5709e048748756de280217f62b555179c4226a71a205f5bf804ed3`。Xcodeログ内の`error: ... exit code 0`文と既知のactor隔離警告は、実終了0と区別する。

この人工再現は、オーナーの実iPhoneで発生した全経路や写真選択中のシステムUI、保存後のサーバー状態を証明しない。実画像・実Bot・Host UI・Apple署名と配布は操作していない。Rootが別に隔離したBotRegistryの保存済み画像上書き競合は、保存後の別経路として扱い、このiPhoneシート修理の成功へ含めない。版78の旧署名無し候補はこの修理を含まない。
