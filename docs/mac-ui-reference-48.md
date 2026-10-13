# Mac画面の参考資料 — BellTeam 1.0.1（48）

Windows版の画面設計で、Mac版の配置・情報量・操作を比較するための原寸PNG。撮影したアプリのソースはcommit `2282987910420e1e06fdd9fce17099785a0d7200`。Mac CatalystのDebugビルドを1280×820のウィンドウで開いた。

メンバー・ルーム・会話は`PreviewFixtures.swift`の作り物のデータを使用した。モデル候補、予定、設定の表示に必要なAPI応答もローカルの作り物のサーバーから返した。実際のメンバー名・会話・認証情報は含まない。設定の接続先`bellteam.example`も表示用の例である。

| 画面 | 原寸PNG |
| --- | --- |
| 一覧・会話・詳細の3ペイン。ファストの印と、同じ席の処理中を1行にまとめた表示 | [01-workspace.png](assets/mac-ui-reference-48/01-workspace.png) |
| 独立したメンバー編集ウィンドウ。AI設定のファストモード | [02-member-editor.png](assets/mac-ui-reference-48/02-member-editor.png) |
| 予定の一覧 | [03-schedules.png](assets/mac-ui-reference-48/03-schedules.png) |
| 設定の上部 | [04-settings.png](assets/mac-ui-reference-48/04-settings.png) |
| 設定の下部 | [05-settings-lower.png](assets/mac-ui-reference-48/05-settings-lower.png) |

設定は縦に長いため、上部と下部の2枚に分けた。各PNGはウィンドウ全体を含み、縮小加工していない。
