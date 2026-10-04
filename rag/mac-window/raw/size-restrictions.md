出典: https://developer.apple.com/documentation/uikit/uiwindowscene/sizerestrictions
取得日: 2026-09-27
確度: Apple公式仕様の原文

<!--
{
  "availability" : [
    "iOS: 13.0.0 -",
    "iPadOS: 13.0.0 -",
    "macCatalyst: 13.1.0 -",
    "tvOS: 13.0.0 -",
    "visionOS: 1.0.0 -"
  ],
  "documentType" : "symbol",
  "framework" : "UIKit",
  "identifier" : "/documentation/UIKit/UIWindowScene/sizeRestrictions",
  "metadataVersion" : "0.1.0",
  "role" : "Instance Property",
  "symbol" : {
    "kind" : "Instance Property",
    "modules" : [
      "UIKit"
    ],
    "preciseIdentifier" : "c:objc(cs)UIWindowScene(py)sizeRestrictions"
  },
  "title" : "sizeRestrictions"
}
-->

# sizeRestrictions

The minimum and maximum size of the app’s windows.

```
var sizeRestrictions: UISceneSizeRestrictions? { get }
```

## Discussion

When the value of this property is not `nil`, use it to change the default minimum and maximum window sizes for your app. If the value of this property is `nil,` the system doesn’t allow you to set window size restrictions.

---

Copyright &copy; 2026 Apple Inc. All rights reserved. | [Terms of Use](https://www.apple.com/legal/internet-services/terms/site.html) | [Privacy Policy](https://www.apple.com/privacy/privacy-policy)