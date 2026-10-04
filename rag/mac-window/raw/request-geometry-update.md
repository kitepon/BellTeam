出典: https://developer.apple.com/documentation/uikit/uiwindowscene/requestgeometryupdate(_:errorhandler:)
取得日: 2026-09-27
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
  "framework" : "UIKit",
  "identifier" : "/documentation/UIKit/UIWindowScene/requestGeometryUpdate(_:errorHandler:)",
  "metadataVersion" : "0.1.0",
  "role" : "Instance Method",
  "symbol" : {
    "kind" : "Instance Method",
    "modules" : [
      "UIKit"
    ],
    "preciseIdentifier" : "c:objc(cs)UIWindowScene(im)requestGeometryUpdateWithPreferences:errorHandler:"
  },
  "title" : "requestGeometryUpdate(_:errorHandler:)"
}
-->

# requestGeometryUpdate(_:errorHandler:)

Requests an update to the window scene’s geometry using the specified geometry preferences object.

```
func requestGeometryUpdate(_ geometryPreferences: UIWindowScene.GeometryPreferences, errorHandler: ((any Error) -> Void)? = nil)
```

## Parameters

`geometryPreferences`

The geometry information to use for the request.

`errorHandler`

An optional closure to call when an error occurs. The system may call the error handler asynchronously.

## Discussion

Use this method to explicitly request geometry changes to the window scene. The following code shows an example of requesting the window scene to rotate to a landscape orientation in iOS.

```swift
// In a view controller, get the window scene.
guard let windowScene = view.window?.windowScene else { return }

// Request the window scene to rotate to any landscape orientation.
windowScene.requestGeometryUpdate(.iOS(interfaceOrientations: .landscape)) { error in
    // Handle denial of request.
}
```

---

Copyright &copy; 2026 Apple Inc. All rights reserved. | [Terms of Use](https://www.apple.com/legal/internet-services/terms/site.html) | [Privacy Policy](https://www.apple.com/privacy/privacy-policy)
