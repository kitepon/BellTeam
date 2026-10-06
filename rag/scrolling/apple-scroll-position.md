# SwiftUIのスクロール位置と計測

出典: [scrollTo](https://developer.apple.com/documentation/swiftui/scrollviewproxy/scrollto(_:anchor:))、[onScrollGeometryChange](https://developer.apple.com/documentation/swiftui/view/onscrollgeometrychange(for:of:action:))。取得日2026-10-07。確度: Apple公式原文。

`scrollTo`のanchorは、対象ビュー内とスクロール領域内の同じ点を揃える。高さが後から変わる本文には、その配置更新後の位置確認が必要である。

`onScrollGeometryChange`はiOS・iPadOS・Mac Catalyst 18以降で、BellTeamのiOS 17からの共通実装には使えない。位置の計測はGeometryReaderとPreferenceKeyで行う。スクロール中の毎フレームの値を画面全体の更新通知に載せない。

原文は[scrollTo](raw/apple-scrollto.md)と[位置計測](raw/apple-scroll-geometry.md)に保存した。

`defaultScrollAnchor(_:)`はiOS・iPadOS・Mac Catalyst 17以降で使える。初期表示と内容の高さの変化を扱い、利用者は初期位置からスクロールできる。末尾を初期位置にする最小候補として、独自の高さ追従処理より先に試す。位置保持の実効結果は画面で確認する。[公式原文](raw/apple-default-scroll-anchor.md)。
