出典: https://developer.apple.com/documentation/swiftui/scrollviewproxy/scrollto(_:anchor:).md
取得日: 2026-10-07
確度: Apple公式原文

<!--
{
  "availability" : [
    "iOS: 14.0.0 -",
    "iPadOS: 14.0.0 -",
    "macCatalyst: 14.0.0 -",
    "macOS: 11.0.0 -",
    "tvOS: 14.0.0 -",
    "visionOS: 1.0.0 -",
    "watchOS: 7.0.0 -"
  ],
  "documentType" : "symbol",
  "framework" : "SwiftUI",
  "identifier" : "/documentation/SwiftUI/ScrollViewProxy/scrollTo(_:anchor:)",
  "metadataVersion" : "0.1.0",
  "role" : "Instance Method",
  "symbol" : {
    "kind" : "Instance Method",
    "modules" : [
      "SwiftUI"
    ],
    "preciseIdentifier" : "s:7SwiftUI15ScrollViewProxyV8scrollTo_6anchoryx_AA9UnitPointVSgtSHRzlF"
  },
  "title" : "scrollTo(_:anchor:)"
}
-->

# scrollTo(_:anchor:)

Scans all scroll views contained by the proxy for the first
with a child view with identifier `id`, and then scrolls to
that view.

```
func scrollTo<ID>(_ id: ID, anchor: UnitPoint? = nil) where ID : Hashable
```

## Parameters

`id`

The identifier of a child view to scroll to.

`anchor`

The alignment behavior of the scroll action.

## Discussion

If `anchor` is `nil`, this method finds the container of the identified
view, and scrolls the minimum amount to make the identified view
wholly visible.

If `anchor` is non-`nil`, it defines the points in the identified
view and the scroll view to align. For example, setting `anchor` to
[`top`](/documentation/SwiftUI/UnitPoint/top) aligns the top of the identified view to the top of
the scroll view. Similarly, setting `anchor` to [`bottom`](/documentation/SwiftUI/UnitPoint/bottom)
aligns the bottom of the identified view to the bottom of the scroll
view, and so on.

---

Copyright &copy; 2026 Apple Inc. All rights reserved. | [Terms of Use](https://www.apple.com/legal/internet-services/terms/site.html) | [Privacy Policy](https://www.apple.com/privacy/privacy-policy)