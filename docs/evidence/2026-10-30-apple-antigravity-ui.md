# AntigravityのApple共通UI

本体の`/api/harness-auth`一覧は、各CLIに`reloginSupported`を返す。Antigravityは`false`で、再認証開始のAPIは409のまま。Appleの共通設定画面はこのtyped値だけを読み、`false`なら「認証し直す」と取消・入力欄を出さず、既存の`startWarning`による公式CLI案内と「状態を更新」を表示する。旧サーバーが欄を返さない時は従来の表示を保つ。CLI名や案内文の解析で可否を決めない。

初回設定は既存の`setup.harnesses`と`AuthenticationInstructions`を使う。Antigravity専用の認証処理や資格保存は追加していない。メンバー編集は既存のAntigravity選択肢と共通のモデル・effort Pickerを使い、不透明なモデルIDを変換せず保存する。

## 有限検証

- iPhone Simulator 26.5：設定のAntigravity行で公式CLI案内・状態更新を表示し、start/cancel/inputを表示せず、人工APIへのGETは2回・POSTは0。旧サーバーの欠測時は既4CLIの従来確認表示を保持するデコード試験と合わせて2件成功。XcodeBuildMCP呼出しは300秒でtime outしたが、保存された`xcodebuild`ログの`TEST EXECUTE SUCCEEDED`とXCResultの2件成功・失敗0を別に確認した。XCResult `~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-bf5fe1dd20e1/result-bundles/test_sim_2026-10-30T11-04-10-349Z_pid45005_ca2124d6.xcresult`、その相対ファイル列と内容SHA256から計算したtree SHA256 `d8321b118e1cd435cafb21d26cf7a3703919e2e7616ec8c357cb560dadd218ea`。実ログ556,368B、SHA256 `654db0ac43605f63fe3e738d4b1d7fa3024ac1855ea9358f3f2d3f5cfffea5bd`。
- iPad Simulator 26.5：同じ設定画面と、Antigravityの不透明モデルID・effortのAPI保存後GET確認を2件成功。XCResult `~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-bf5fe1dd20e1/result-bundles/test_sim_2026-10-30T11-12-52-923Z_pid45005_d7552385.xcresult`、tree SHA256 `49e553e5005540bbc0ae8e254fd3bf92d0f362d4a56cff1cf548f3cc236a0256`。実ログ75,648B、SHA256 `60ee7f1999274e98d76b2ec6a5b4e6b2e1c7fb4e6b9bf5defd7e0bb089d90fae`。
- iPhone Simulator 26.5：人工初期設定でAntigravityを選択し、typed HTTPS URL・利用者コードを表示。人工の`paste_code`へ更新後、SecureFieldの入力をbinding・prompt digest付きで一回送信し、認証済みの表示まで確認した。案内役を起動していない。focused UI 1件成功。XCResult `~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-bf5fe1dd20e1/result-bundles/test_sim_2026-10-30T11-24-06-690Z_pid45005_23387364.xcresult`、tree SHA256 `7cdf43b727f5a0254d95d6afc58f3b86f1cb2acc9c65a43bd914a822dd118cc6`。実ログ67,926B、SHA256 `1d6992b182a63fbb299901b3e4ef5bfd4cb2e2c06365667964911f0c9f23e9ac`。
- iPad Simulator 26.5：既存Botの編集PickerでCLIをAntigravity、モデルを`ag-model/phase-one`、effortを`high`に選び、人工PATCH本文を確認。保存後に編集画面を開き直し、同値を読戻した。試験専用サーバーへ分離した最終focused UIは1件成功。XCResult `~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-bf5fe1dd20e1/result-bundles/test_sim_2026-10-30T11-36-48-372Z_pid45005_ea619945.xcresult`、tree SHA256 `4821ade452c8ce3577e732aecca91cd99c80d47369857a7e022f1c238a8a2ad4`。実ログ62,768B、SHA256 `0e555d19aa717f69712cb5c85b796544266a689c2662e7dce5d3833a8ce75466`。
- Mac Catalyst Debug：`CODE_SIGNING_ALLOWED=NO`で一回ビルドし実process exit0、`BUILD SUCCEEDED`。本体は1.0.3(78)、x86_64・arm64。`runtime/apple/antigravity-ui/mac-build.log`のSHA256は`64d34225e2723b0ba2414cbf6a07a94e6e014cfbd52a1185f95719a17090cb6a`。ログの既存actor隔離警告とAppIntents metadata省略警告は実終了0と分ける。

今回のApple製品差分は認証optionの任意Boolと設定の共通Viewだけ。Mac実UIの操作、公式OAuth、実資格、実機設定、署名・配布・一般公開は未実施。キャラ画像の選択消失は別担当の未修理事象で、この検証をその回復へ代入しない。
