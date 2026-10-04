# Macのアバター調整と詳細ボタン

取得日: 2026-10-03。出典: SwiftUIの実装、Macの実画面、XCTestの結果。確度: 実測済み。

Macでも小さい標準form sheetへ画像・拡大率の縦配置を載せていたため、調整操作が画面外になった。Macは画像と拡大率を横配置へ変更し、表示内容を680×520ptとし、UIKitのpreferredContentSizeで同じ寸法をform sheetへ渡した。Macの対応OSすべてで同じ処理を使う。iPhoneの縦配置は共通の画像切抜き・拡大率処理を使い、画面構成だけを分けた。メンバー・ルーム・オーナーのアバターは同じ調整画面を利用する。

三点の詳細ボタンは、開いている右ペインをもう一度開くため変化がなく、開閉ボタンと重複した。Macでは三点ボタンを削除し、既存の開閉ボタンへ統一した。iPhoneの詳細表示は保持した。

## 確認

- Macの実際のsheetが680×520ptになった。画像・拡大率・確定が同時に表示され、スクロールバーが無いことをagent-desktopの画像で確認した。
- AvatarImageTestsの関連3試験とサーバー全334試験が成功した。
- Debug限定の試験画像を使い、Jev Desktopから使用するボタンを押して調整の確定を確認した。

画面はruntime/mac-crop-35.png、操作はruntime/mac-crop-35-use.json、試験は/tmp/bellteam-crop-focused-tests.logに記録した。ビルド35のiPhone・Macの署名・書き出し・Appleへのアップロードは成功した。このMacは標準のinstall-mac.shで35へ導入し、署名確認と起動を確認した。

他担当の通話MCPとCLI設定の更新を取り込んだ。Appleアプリのコードに差分はなく、関連試験と統合後の全336試験が成功した。本番コンテナの再起動・再作成は行っていない。

Apple側でiPhone・Macのビルド35がVALID、Ownerグループへ登録済み、IN_BETA_TESTINGであることを確認した。記録はruntime/apple/mac-crop-35/testflight-35-proof.json。
