出典: https://developer.apple.com/documentation/swiftui/view/id(_:).md
取得日: 2026-09-30
確度: Apple公式仕様の原文

<!--
{
  "availability" : [
    "iOS: 13.0.0 -",
    "iPadOS: 13.0.0 -",
    "macCatalyst: 13.0.0 -",
    "macOS: 10.15.0 -",
    "tvOS: 13.0.0 -",
    "visionOS: 1.0.0 -",
    "watchOS: 6.0.0 -"
  ],
  "documentType" : "symbol",
  "framework" : "SwiftUI",
  "identifier" : "/documentation/SwiftUI/View/id(_:)",
  "metadataVersion" : "0.1.0",
  "role" : "Instance Method",
  "symbol" : {
    "kind" : "Instance Method",
    "modules" : [
      "SwiftUI"
    ],
    "preciseIdentifier" : "s:7SwiftUI4ViewPAAE2idyQrqd__SHRd__lF"
  },
  "title" : "id(_:)"
}
-->

# id(_:)

Binds a view’s identity to the given proxy value.

```
nonisolated func id<ID>(_ id: ID) -> some View where ID : Hashable
```

## Discussion

When the proxy value specified by the `id` parameter changes, the
identity of the view — for example, its state — is reset.

---

Copyright &copy; 2026 Apple Inc. All rights reserved. | [Terms of Use](https://www.apple.com/legal/internet-services/terms/site.html) | [Privacy Policy](https://www.apple.com/privacy/privacy-policy)