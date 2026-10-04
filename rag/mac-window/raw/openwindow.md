出典: https://developer.apple.com/documentation/swiftui/environmentvalues/openwindow
取得日: 2026-09-27
確度: Apple公式仕様の原文

<!--
{
  "availability" : [
    "iOS: 16.0.0 -",
    "iPadOS: 16.0.0 -",
    "macCatalyst: 16.0.0 -",
    "macOS: 13.0.0 -",
    "visionOS: 1.0.0 -"
  ],
  "documentType" : "symbol",
  "framework" : "SwiftUI",
  "identifier" : "/documentation/SwiftUI/EnvironmentValues/openWindow",
  "metadataVersion" : "0.1.0",
  "role" : "Instance Property",
  "symbol" : {
    "kind" : "Instance Property",
    "modules" : [
      "SwiftUI"
    ],
    "preciseIdentifier" : "s:7SwiftUI17EnvironmentValuesVAAE10openWindowAA04OpenF6ActionVvp"
  },
  "title" : "openWindow"
}
-->

# openWindow

A window presentation action stored in a view’s environment.

```
var openWindow: OpenWindowAction { get }
```

## Discussion

Use the `openWindow` environment value to get an [`OpenWindowAction`](/documentation/SwiftUI/OpenWindowAction)
instance for a given [`Environment`](/documentation/SwiftUI/Environment). Then call the instance to open
a window. You call the instance directly because it defines a
[`callAsFunction(id:)`](/documentation/SwiftUI/OpenWindowAction/callAsFunction(id:)) method that Swift calls
when you call the instance.

For example, you can define a button that opens a new mail viewer
window:

```
@main
struct Mail: App {
    var body: some Scene {
        WindowGroup(id: "mail-viewer") {
            MailViewer()
        }
    }
}

struct NewViewerButton: View {
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Button("Open new mail viewer") {
            openWindow(id: "mail-viewer")
        }
    }
}
```

You indicate which scene to open by providing one of the following:

- A string identifier that you pass through the `id` parameter,
  as in the above example.
- A `value` parameter that has a type that matches the type that
  you specify in the scene’s initializer.
- Both an identifier and a value. This enables you to define
  multiple window groups that take input values of the same type like a
  <doc://com.apple.documentation/documentation/Foundation/UUID>.

Use the first option to target either a [`WindowGroup`](/documentation/SwiftUI/WindowGroup) or a
[`Window`](/documentation/SwiftUI/Window) scene in your app that has a matching identifier. For a
`WindowGroup`, the system creates a new window for the group. If
the window group presents data, the system provides the default value
or `nil` to the window’s root view. If the targeted scene is a
`Window`, the system orders it to the front.

Use the other two options to target a `WindowGroup` and provide
a value to present. If the interface already has a window from
the group that’s presenting the specified value, the system brings the
window to the front. Otherwise, the system creates a new window and
passes a binding to the specified value.

---

Copyright &copy; 2026 Apple Inc. All rights reserved. | [Terms of Use](https://www.apple.com/legal/internet-services/terms/site.html) | [Privacy Policy](https://www.apple.com/privacy/privacy-policy)
