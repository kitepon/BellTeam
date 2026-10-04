出典: https://developer.apple.com/documentation/swiftui/windowresizability/contentminsize
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
  "identifier" : "/documentation/SwiftUI/WindowResizability/contentMinSize",
  "metadataVersion" : "0.1.0",
  "role" : "Type Property",
  "symbol" : {
    "kind" : "Type Property",
    "modules" : [
      "SwiftUI"
    ],
    "preciseIdentifier" : "s:7SwiftUI18WindowResizabilityV14contentMinSizeACvpZ"
  },
  "title" : "contentMinSize"
}
-->

# contentMinSize

A window resizability that’s partially derived from the window’s
content.

```
static var contentMinSize: WindowResizability { get set }
```

## Discussion

Windows that use this resizability have:

- A minimum size that matches the minimum size of the window’s content.
- No maximum size.

---

Copyright &copy; 2026 Apple Inc. All rights reserved. | [Terms of Use](https://www.apple.com/legal/internet-services/terms/site.html) | [Privacy Policy](https://www.apple.com/privacy/privacy-policy)