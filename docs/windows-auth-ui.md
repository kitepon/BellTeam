# Windowsのログイン・初回設定・AI認証

Mac版の設定と初回設定を基準に、画面改修版の色・部品へ統合した。画像は人工データだけを使った非表示描画で、本人の認証操作は含まない。

| 画面 | 確認画像 |
| --- | --- |
| 設定内のAI認証一覧 | [settings.png](assets/windows-auth-ui/settings.png) |
| 最初に使うAIの選択 | [setup.png](assets/windows-auth-ui/setup.png) |
| AI認証の公式サイトと利用者コード | [authentication.png](assets/windows-auth-ui/authentication.png) |

単体試験138件、全窓の非表示を検査する操作確認、.NET同梱x64ビルドが成功。模擬Cookieの保存と別プロセスからの復元、認証の開始を断る操作、専用入力の消去、値を失敗の詳細へ含めないこと、取消後の状態確認を試験した。Cookie試験後の専用WebView2プロセスとBellTeam.exeは0件。本番のAI認証を始める操作は実行していない。

前面確認はトロニーの開始連絡待ち。実際のCloudflare Accessログイン、AI認証、初回設定は未確認。通知は後続PRで実装する。
