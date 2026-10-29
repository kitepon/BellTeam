# SwiftUIのStateとViewの寿命

出典: [Apple Developer Documentation — Managing user interface state](https://developer.apple.com/documentation/swiftui/managing-user-interface-state)、[Demystify SwiftUI](https://developer.apple.com/videos/play/wwdc2021/10022/)。取得日: 2026-10-29。確度: Apple公式の仕様説明。

> Don’t use state properties for persistent storage because the life cycle of state variables mirrors the view life cycle.

> State and StateObject are the persistent storage associated with your view's identity.

この原文は、`body`の再評価だけでStateが消えるという主張ではない。Viewの寿命・identityが変わる時に、そのViewが所有するStateも変わることを示す。
