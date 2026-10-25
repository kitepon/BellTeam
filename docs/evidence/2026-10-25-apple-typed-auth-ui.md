# Appleの型付き認証案内（人工検証）

## 契約と修理範囲

Root Draft PR #94の`9e1b0c94548cb0b187fbdcb84a42519d4f098ae1`を読んだ。初期設定と通常の4ハーネス認証は、従来の`auth`内に`auth_ui`を返す。入力は既存の`/api/setup/auth/input`と`/api/harness-auth/:harness/input`へ、`auth_ui.binding`全フィールド、`auth_ui.prompt_digest`、型付き`response`をそのまま送る。RootがNative向けの`expected_binding`と`expected_prompt_digest`へ変換する。AppleはID・digest・CLIキーを生成しない。

旧Apple画面は`input_required`だけで自由入力とEnter/Up/Down/Tabを出していた。両画面で共通の型付き案内を使い、公式リンク、利用者コード、選択肢、認証コード欄を`auth_ui`から表示する。入力種別とbindingとdigestが揃わない状態ではPOSTしない。結果不明のPOST後は明示GETまで入力を止め、先に始まったGETが新しい結果へ上書きしない。

## 人工検証

- `test/helpers/auth-ui-server.mjs`はClaudeの`open_url`、Codexの`device_code`、Grokの`select`、Cursorの`paste_code`を返す。URLとコードは人工値で、公式CLIと実認証には接続しない。
- iPhone Simulatorの4ハーネス画面試験は1件成功・失敗0。Claude/Codexでは`input_required=true`でもコード欄を表示せず、Grokの`option-2`とCursorの`authorization_code`だけをPOSTした。送信には完全なbindingと64文字digestが含まれ、旧`text`/`key`は無い。XCResult: `~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-bf30729c2d6d/result-bundles/test_sim_2026-10-25T13-12-04-065Z_pid8412_37d5233d.xcresult`。
- 初回画面試験でGrokの2番目をタップすると1番目がPOSTされた。SwiftUIの`Form`内で自動ボタンが行のタップを共有したため、選択肢に`.buttonStyle(.bordered)`を設定し、同じ試験で`option-2`のPOSTを確認した。
- `HarnessAuthenticationTests`と`OnboardingTests`の関連15件は成功・失敗0。型付きbinding/digestの往復、結果不明502後の自動GET・POST抑止と明示GETでの解除を含む。XCResult: `~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-bf30729c2d6d/result-bundles/test_sim_2026-10-25T13-16-03-770Z_pid8412_717b69e9.xcresult`。
- 旧`input_required=true`だけを返すAPIでは、旧URLと利用者コードがあっても入力欄とCLIキーを表示しない。通常の確認・取消・通信エラー表示と合わせた回帰画面試験、および4ハーネス型付き画面試験は計2件成功・失敗0。XCResult: `~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-bf30729c2d6d/result-bundles/test_sim_2026-10-25T13-17-36-082Z_pid8412_47c9fcca.xcresult`。
- 初期設定の人工APIを保留したGETと結果不明502でも確認した。旧GETがPOST成功の後で返っても認証済みを上書きせず、502後の自動GETと再POSTは0、明示GET後に現在の認証済み状態を表示した。focused単体試験2件成功・失敗0。XCResult: `~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-bf30729c2d6d/result-bundles/test_sim_2026-10-25T13-22-37-208Z_pid8412_acd027b4.xcresult`。
- iPhone Simulator DebugとMac Catalyst Debugのビルド成功。最初の画面試験呼出しと関連単体試験直後の呼出しは、Simulatorのテストランナー起動が`Busy`で拒否され、画面判定を開始していない。
- Nodeの`npm test`は91件成功・失敗0。新しい人工サーバーの構文確認と`git diff --check`も成功。
- 最終のfocused画面試験で、Grokが2番目の方法を選んだ後とCursorのコード画面にも、型付きURLから公式リンクが表示されることを確認した。4ハーネス1件成功・失敗0。XCResult: `~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-bf30729c2d6d/result-bundles/test_sim_2026-10-25T13-27-06-574Z_pid8412_3b123e6c.xcresult`。旧APIの回帰画面試験も最後のUI変更後に1件成功・失敗0。XCResult: `~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-bf30729c2d6d/result-bundles/test_sim_2026-10-25T13-25-51-395Z_pid8412_91aa355c.xcresult`。
- Rootの`paste_code`契約どおり、型付き案内でも有効なHTTPSのURLが欠ける時はコードを送れない。focused単体試験1件成功・失敗0。XCResult: `~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-bf30729c2d6d/result-bundles/test_sim_2026-10-25T13-29-15-828Z_pid8412_f0c55554.xcresult`。変更後のMac Catalyst Debugビルドも成功。
- URL条件を加えた後の4ハーネス画面試験も1件成功・失敗0。XCResult: `~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-bf30729c2d6d/result-bundles/test_sim_2026-10-25T13-30-40-309Z_pid8412_ad9ff218.xcresult`。
- Root PR #94で再現された「古いGET Aを保留→新しいGET Bで認証完了→Aの旧状態またはエラーが後着」の順序をAppleの通常認証と初期設定の両方で人工再現した。各GETの開始番号で最新だけを採用し、Aの旧waitingと503を無視した。先のPOST競合・結果不明と合わせてfocused4件成功・失敗0。XCResult: `~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-bf30729c2d6d/result-bundles/test_sim_2026-10-25T13-35-07-519Z_pid8412_2387b32b.xcresult`。

Root PR #94はDraftで、Nativeの正式版・他OS・実Owner認証は未受入。Appleの実認証、署名、配布、本番コンテナへの操作は行っていない。
