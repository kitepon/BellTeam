# 停止対応版の内部TestFlight配布（2026-10-22）

オーナーの「TestFlightで使わせてくれ」という指示により、iPhone/iPadとMacの停止対応版を既存の「BellTeam オーナー」内部グループへ配布する。一般公開審査と実メンバー操作は対象外。Macの実画面も操作しない。

## 固定ソースと成果物

- 元ソース: BellTeam main `e8a304a1c2902a5178e76a1668d86e2f590a2acb`。停止UIの `583df46` と本体受入の `0cfa60b` を含む。
- 本体と通知拡張を共に `1.0.3 (56)` に採番したcommit: `60ad24b`。
- iOS: `runtime/apple/ai-stop-56/ios-56.xcarchive` → `ios-export/BellTeam.ipa`。SHA-256 `87af07ef63cd788d5ce2eda1ab38838286502446d862576fa4aa98b076bbcc58`。
- Mac Catalyst: `runtime/apple/ai-stop-56/mac-56.xcarchive` → `mac-export/BellTeam.pkg`。SHA-256 `7903fb9e996edb412ad21d0d7d3e6ecdaa0d21793c1c6df868cfd181171edc0e`。
- 両archiveの本体・通知拡張とも `1.0.3 (56)`、archiveの `codesign --verify --deep --strict` は成功。pkgはApple発行Installer証明書による署名を確認。
- Apple公式 `altool --validate-app` は両成果物とも `No errors validating archive`。

## Appleへの転送

- iOS IPAは1回だけ送信し、`altool` が `No errors uploading archive` を返した。delivery UUID: `9542d039-253c-4855-8b14-2b1c396f9d09`。
- Mac pkgも1回だけ送信し、同じ受付結果を得た。delivery UUID: `60082179-0b38-467f-9e95-f9342de7d7bc`。
- iOS build ID `9542d039-253c-4855-8b14-2b1c396f9d09`。公式APIの `preReleaseVersion` は `1.0.3 / IOS`、`processingState` は `VALID`。既存内部グループ「BellTeam オーナー」ID `58133050-1c39-4915-b6da-aac18b95921b` への追加APIは成功し、再読取の `internalBuildState` は `IN_BETA_TESTING`。
- Mac build ID `60082179-0b38-467f-9e95-f9342de7d7bc`。同じAPIの `preReleaseVersion` は `1.0.3 / MAC_OS`、`processingState` は `VALID`。同じ内部グループへの追加APIは成功し、再読取の `internalBuildState` は `IN_BETA_TESTING`。
- `asc_get_build` はbeta group relationshipそのものを返さないため、紐付けの証拠は追加APIが返したbuild ID/group IDと、その後の `IN_BETA_TESTING` の読戻しを組み合わせたもの。owner端末への導入と停止操作の実試験は実施していない。
