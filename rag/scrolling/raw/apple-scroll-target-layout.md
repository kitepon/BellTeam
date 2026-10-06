出典: https://developer.apple.com/documentation/swiftui/view/scrolltargetlayout(isenabled:).md
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
  "identifier" : "/documentation/SwiftUI/View/scrollTargetLayout(isEnabled:)",
  "metadataVersion" : "0.1.0",
  "role" : "Instance Method",
  "symbol" : {
    "kind" : "Instance Method",
    "modules" : [
      "SwiftUI"
    ],
    "preciseIdentifier" : "s:7SwiftUI4ViewPAAE18scrollTargetLayout9isEnabledQrSb_tF"
  },
  "title" : "scrollTargetLayout(isEnabled:)"
}
-->

# scrollTargetLayout(isEnabled:)

Configures the outermost layout as a scroll target layout.

```
nonisolated func scrollTargetLayout(isEnabled: Bool = true) -> some View
```

## Discussion

This modifier works together with the
[`ViewAlignedScrollTargetBehavior`](/documentation/SwiftUI/ViewAlignedScrollTargetBehavior) to ensure that scroll views align
to view based content.

Apply this modifier to layout containers like [`LazyHStack`](/documentation/SwiftUI/LazyHStack) or
[`VStack`](/documentation/SwiftUI/VStack) within a [`ScrollView`](/documentation/SwiftUI/ScrollView) that contain the main repeating
content of your [`ScrollView`](/documentation/SwiftUI/ScrollView).

```
ScrollView(.horizontal) {
    LazyHStack(spacing: 10.0) {
        ForEach(items) { item in
            ItemView(item)
        }
    }
    .scrollTargetLayout()
}
.scrollTargetBehavior(.viewAligned)
```

A scroll target layout ensures that any target layout nested within
the primary one will not also become a scroll target layout.

```
LazyHStack { // a scroll target layout
    VStack { ... } // not a scroll target layout
    LazyHStack { ... } // also not a scroll target layout
}
.scrollTargetLayout()
```

---

Copyright &copy; 2026 Apple Inc. All rights reserved. | [Terms of Use](https://www.apple.com/legal/internet-services/terms/site.html) | [Privacy Policy](https://www.apple.com/privacy/privacy-policy)