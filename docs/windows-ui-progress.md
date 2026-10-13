# Windows画面の改修とMac版との比較

[Mac版の実画面](mac-ui-reference-48.md)を品質基準として、WPFで画面の構成と部品を改修した。以下はMac版と同じPreviewFixturesの人物・ルームを使い、Windowsの表示部品を非表示で描いた画像。Windowsのウィンドウ枠は含まず、前面での実操作の確認とは分ける。

| 画面 | Windowsの非表示描画 | 改修内容 |
| --- | --- | --- |
| 一覧・会話・詳細 | [01-workspace.png](assets/windows-ui-progress/01-workspace.png) | 項目ごとのプロフィール、テーマ色の吹き出し、時刻と配送状態、席・状態ごとにまとめた進行表示、入力欄の一体化 |
| メンバー編集 | [02-member-editor.png](assets/windows-ui-progress/02-member-editor.png) | 広い窓では人物・AI設定を左、プロフィール4欄を右へ配置。狭い窓は1列へ戻す |
| 予定 | [03-schedules.png](assets/windows-ui-progress/03-schedules.png) | 主画面内のカード。担当者の写真、内容、次回、実行・編集・削除を整理 |
| 設定 | [04-settings.png](assets/windows-ui-progress/04-settings.png) | 主画面内でプロフィール・接続先・追加機能を整理 |

Windowsでは写真から色を推定せず、利用者が設定したテーマ色を吹き出しへ反映する。テーマを変えた時も本文の選択を作り直さず、見た目を更新する。

## 確認

単体試験119件、.NET同梱x64ビルドが成功。`BellTeam.UiChecks`で、予定・設定から会話へ戻る、新着で読書位置を動かさない、過去ログを追加しても位置を保つ、という操作を実際のWPF部品で確認した。確認中に窓のハンドルを作っていないことも検査した。

```powershell
dotnet run --project windows/BellTeam.UiChecks/BellTeam.UiChecks.csproj -c Release
node windows/BellTeam.Tests/fixtures/mac-ui-reference.mjs windows/artifacts/publish-quality/BellTeam.exe windows/artifacts/mac-reference
```

後者は模擬サーバーの起動、4画面の描画、出力の確認、サーバーの終了までを行う。本番へ書き込まない。21:32 JSTの同梱版LAN読み取りsmokeは終了コード0で、local認証・41メンバー・3ルーム・履歴・SSE接続を確認した。

## 続ける内容

画面改修の途中結果をまとめた資料。Accessログイン・初回設定、AI認証、起動中の通知、FOXで前面に出した操作確認を続ける。Appleの購入とAPNs登録はWindowsの対象に含めない。

レビュー後、画像URLが無いメッセージの「画像／画像N枚」を復元した。未接続時のページ移動、ページへの書込中の終了、読込中の案内も非表示の表示部品で確認した。アイコンは32bitの8サイズ（16・20・24・32・40・48・64・256px）へ変換し、256pxはPNGで格納する。Windows 10のアイコン用フォントも指定した。
