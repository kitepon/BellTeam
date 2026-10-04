出典: https://developer.apple.com/documentation/swiftui/scene/defaultsize(width:height:)
取得日: 2026-09-27
確度: Apple公式仕様の原文

<!--
{
  "availability" : [
    "iOS: 17.0.0 -",
    "iPadOS: 17.0.0 -",
    "macCatalyst: 17.0.0 -",
    "macOS: 13.0.0 -",
    "visionOS: 1.0.0 -"
  ],
  "documentType" : "symbol",
  "framework" : "SwiftUI",
  "identifier" : "/documentation/SwiftUI/Scene/defaultSize(width:height:)",
  "metadataVersion" : "0.1.0",
  "role" : "Instance Method",
  "symbol" : {
    "kind" : "Instance Method",
    "modules" : [
      "SwiftUI"
    ],
    "preciseIdentifier" : "s:7SwiftUI5ScenePAAE11defaultSize5width6heightQr14CoreFoundation7CGFloatV_AItF"
  },
  "title" : "defaultSize(width:height:)"
}
-->

# defaultSize(width:height:)

Sets a default width and height for a window.

```
nonisolated func defaultSize(width: CGFloat, height: CGFloat) -> some Scene
```

## Parameters

`width`

The default width for windows created from a scene.

`height`

The default height for windows created from a scene.

## Return Value

A scene that uses a default size for new windows.

## Discussion

Use this scene modifier to indicate a default initial size for a new
window that the system creates from a [`Scene`](/documentation/SwiftUI/Scene) declaration. For
example, you can request that new windows that a [`WindowGroup`](/documentation/SwiftUI/WindowGroup)
generates occupy 600 points in the x-dimension and 400 points in
the y-dimension:

```
@main
struct MyApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
        .defaultSize(width: 600, height: 400)
    }
}
```

The size that you specify acts only as a default for when the window
first appears. People can later resize the window using interface
controls that the system provides. Also, during state restoration,
the system restores windows to their most recent size rather than
the default size.

If you specify a default size that’s outside the range of the window’s
inherent resizability in one or both dimensions, the system clamps the
affected dimension to keep it in range. You can configure the
resizability of a scene using the [`windowResizability(_:)`](/documentation/SwiftUI/Scene/windowResizability(_:))
modifier.

The default size modifier affects any scene type that creates windows
in macOS, namely:

- [`WindowGroup`](/documentation/SwiftUI/WindowGroup)
- [`Window`](/documentation/SwiftUI/Window)
- [`DocumentGroup`](/documentation/SwiftUI/DocumentGroup)
- [`Settings`](/documentation/SwiftUI/Settings)

If you want to specify the size input in terms of size instance,
use [`defaultSize(_:)`](/documentation/SwiftUI/Scene/defaultSize(_:)) instead.

---

Copyright &copy; 2026 Apple Inc. All rights reserved. | [Terms of Use](https://www.apple.com/legal/internet-services/terms/site.html) | [Privacy Policy](https://www.apple.com/privacy/privacy-policy)