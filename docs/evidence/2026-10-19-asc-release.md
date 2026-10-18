# BellTeam 1.0.1のASC公開確認（2026-10-19）

Apple公式App Store Connect APIでアプリ `6816295589` を再照会した。iOS/iPadOSの1.0.1はビルド52（`1961a592-766c-4320-8b7e-7dce1c6122fb`）で、`READY_FOR_SALE` / `READY_FOR_DISTRIBUTION`。審査提出 `6865b146-e98b-4ee9-8684-5e4ef2e66ed5` は `COMPLETE`、アプリ版の項目は `APPROVED`。日本の公開App Store lookupもBellTeam 1.0.1を返し、現行版の公開時刻を2026-10-18 17:20:31 UTCと示した。公開ページは <https://apps.apple.com/jp/app/bellteam/id6816295589>。

macOSの1.0.1はビルド52（`6e245e23-4e58-4959-a160-85b33682ef60`）で、アプリ版と審査提出 `6c4eff78-4e81-4c2a-9441-d301ed39f749` はともに `IN_REVIEW`。両platformの`releaseType`は`AFTER_APPROVAL`で、Mac版は承認後に自動公開される設定。[Appleのリリース設定の説明](https://developer.apple.com/jp/help/app-store-connect/manage-your-apps-availability/select-an-app-store-version-release-option)も照合した。現時点でMac版の公開を確認したとは扱わない。

修理版53は[内部TestFlight配布の記録](2026-10-18-bughub-app-repair.md)のとおりで、今回のApp Store公開版には入っていない。ASCの設定、提出内容、ビルド、本番サーバーは変更していない。

トロニーへ通話 `f422de2d-eb86-4797-b608-4a821e5daecd` で上記を配送済み。サーバー側の監視と関連する利用者影響に気づいた場合の連絡を依頼した。
