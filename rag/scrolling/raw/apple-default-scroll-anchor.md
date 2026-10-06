出典: https://developer.apple.com/documentation/swiftui/view/defaultscrollanchor(_:).md
取得日: 2026-10-07
確度: Apple公式原文

<!--
{
  "availability" : [
    "iOS: 17.0.0 -",
    "iPadOS: 17.0.0 -",
    "macCatalyst: 17.0.0 -",
    "macOS: 14.0.0 -",
    "tvOS: 17.0.0 -",
    "visionOS: 1.0.0 -",
    "watchOS: 10.0.0 -"
  ],
  "documentType" : "symbol",
  "framework" : "SwiftUI",
  "identifier" : "/documentation/SwiftUI/View/defaultScrollAnchor(_:)",
  "metadataVersion" : "0.1.0",
  "role" : "Instance Method",
  "symbol" : {
    "kind" : "Instance Method",
    "modules" : [
      "SwiftUI"
    ],
    "preciseIdentifier" : "s:7SwiftUI4ViewPAAE19defaultScrollAnchoryQrAA9UnitPointVSgF"
  },
  "title" : "defaultScrollAnchor(_:)"
}
-->

# defaultScrollAnchor(_:)

Associates an anchor to control which part of the scroll view’s
content should be rendered by default.

```
nonisolated func defaultScrollAnchor(_ anchor: UnitPoint?) -> some View
```

## Discussion

Use this modifier to specify an anchor to control both which part of
the scroll view’s content should be visible initially and how
the scroll view handles content size changes.

Provide a value of [`center`](/documentation/SwiftUI/UnitPoint/center) to have the scroll
view start in the center of its content when a scroll view
is scrollable in both axes.

```
ScrollView([.horizontal, .vertical]) {
    // initially centered content
}
.defaultScrollAnchor(.center)
```

Provide a value of [`bottom`](/documentation/SwiftUI/UnitPoint/bottom) to have the scroll view
start at the bottom of its content when scrollable in the
vertical axis.

```
@Binding var items: [Item]
@Binding var scrolledID: Item.ID?

ScrollView {
    LazyVStack {
        ForEach(items) { item in
            ItemView(item)
        }
    }
}
.defaultScrollAnchor(.bottom)
```

The user may scroll away from the initial defined scroll position.
When the content size of the scroll view changes, it may consult
the anchor to know how to reposition the content.

---

Copyright &copy; 2026 Apple Inc. All rights reserved. | [Terms of Use](https://www.apple.com/legal/internet-services/terms/site.html) | [Privacy Policy](https://www.apple.com/privacy/privacy-policy)