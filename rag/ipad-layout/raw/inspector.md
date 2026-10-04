出典: https://developer.apple.com/documentation/swiftui/view/inspector%28ispresented%3Acontent%3A%29.md
取得日: 2026-09-30
確度: Apple公式一次資料

<!--
{
  "availability" : [
    "iOS: 17.0.0 -",
    "iPadOS: 17.0.0 -",
    "macCatalyst: 17.0.0 -",
    "macOS: 14.0.0 -"
  ],
  "documentType" : "symbol",
  "framework" : "SwiftUI",
  "identifier" : "/documentation/SwiftUI/View/inspector(isPresented:content:)",
  "metadataVersion" : "0.1.0",
  "role" : "Instance Method",
  "symbol" : {
    "kind" : "Instance Method",
    "modules" : [
      "SwiftUI"
    ],
    "preciseIdentifier" : "s:7SwiftUI4ViewPAAE9inspector11isPresented7contentQrAA7BindingVySbG_qd__yXEtAaBRd__lF"
  },
  "title" : "inspector(isPresented:content:)"
}
-->

# inspector(isPresented:content:)

Inserts an inspector at the applied position in the view hierarchy.

```
nonisolated func inspector<V>(isPresented: Binding<Bool>, @ContentBuilder content: () -> V) -> some View where V : View
```

## Parameters

`isPresented`

A binding to `Bool` controlling the presented state.

`content`

The inspector content.

## Discussion

Apply this modifier to declare an inspector with a context-dependent
presentation. For example, an inspector can present as a trailing
column in a horizontally regular size class, but adapt to a sheet in a
horizontally compact size class.

```
struct ShapeEditor: View {
    @State private var presented: Bool = false
    var body: some View {
        MyEditorView()
            .inspector(isPresented: $presented) {
                TextTraitsInspectorView()
            }
    }
}
```

> Note: Trailing column inspectors have their presentation state
> restored by the framework.

> Seealso: ``doc://com.apple.SwiftUI/documentation/SwiftUI/InspectorCommands`` for including the default inspector
> commands and keyboard shortcuts.

---

Copyright &copy; 2026 Apple Inc. All rights reserved. | [Terms of Use](https://www.apple.com/legal/internet-services/terms/site.html) | [Privacy Policy](https://www.apple.com/privacy/privacy-policy)