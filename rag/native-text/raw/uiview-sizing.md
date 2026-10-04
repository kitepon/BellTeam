出典: https://developer.apple.com/documentation/swiftui/uiviewrepresentable/sizethatfits(_:uiview:context:).md
取得日: 2026-09-30
確度: Apple公式仕様の原文

<!--
{
  "availability" : [
    "iOS: 16.0.0 -",
    "iPadOS: 16.0.0 -",
    "macCatalyst: 16.0.0 -",
    "tvOS: 16.0.0 -",
    "visionOS: 1.0.0 -"
  ],
  "documentType" : "symbol",
  "framework" : "SwiftUI",
  "identifier" : "/documentation/SwiftUI/UIViewRepresentable/sizeThatFits(_:uiView:context:)",
  "metadataVersion" : "0.1.0",
  "role" : "Instance Method",
  "symbol" : {
    "kind" : "Instance Method",
    "modules" : [
      "SwiftUI"
    ],
    "preciseIdentifier" : "s:7SwiftUI19UIViewRepresentableP12sizeThatFits_6uiView7contextSo6CGSizeVSgAA08ProposedI4SizeV_0C4TypeQzAA0cD7ContextVyxGtF"
  },
  "title" : "sizeThatFits(_:uiView:context:)"
}
-->

# sizeThatFits(_:uiView:context:)

Given a proposed size, returns the preferred size of the composite view.

```
@MainActor @preconcurrency func sizeThatFits(_ proposal: ProposedViewSize, uiView: Self.UIViewType, context: Self.Context) -> CGSize?
```

## Parameters

`proposal`

The proposed size for the view.

`uiView`

Your custom view object.

`context`

A context structure containing information about the
current state of the system.

## Return Value

The composite size of the represented view controller.
Returning a value of `nil` indicates that the system should use the
default sizing algorithm.

## Discussion

This method may be called more than once with different proposed sizes
during the same layout pass. SwiftUI views choose their own size, so one
of the values returned from this function will always be used as the
actual size of the composite view.

---

Copyright &copy; 2026 Apple Inc. All rights reserved. | [Terms of Use](https://www.apple.com/legal/internet-services/terms/site.html) | [Privacy Policy](https://www.apple.com/privacy/privacy-policy)