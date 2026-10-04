出典: https://developer.apple.com/documentation/uikit/uiwindowscene/geometrypreferences/mac
取得日: 2026-09-27
確度: Apple公式仕様の原文

<!--
{
  "availability" : [
    "iOS: -",
    "iPadOS: -",
    "macCatalyst: 16.0.0 -",
    "tvOS: -",
    "visionOS: -"
  ],
  "documentType" : "symbol",
  "framework" : "UIKit",
  "identifier" : "/documentation/UIKit/UIWindowScene/GeometryPreferences/Mac",
  "metadataVersion" : "0.1.0",
  "role" : "Class",
  "symbol" : {
    "kind" : "Class",
    "modules" : [
      "UIKit"
    ],
    "preciseIdentifier" : "c:objc(cs)UIWindowSceneGeometryPreferencesMac"
  },
  "title" : "UIWindowScene.GeometryPreferences.Mac"
}
-->

# UIWindowScene.GeometryPreferences.Mac

An object that represents the geometry preferences for a window scene in an app built with Mac Catalyst.

```
class Mac
```

## Overview

Use this class to express macOS-specific geometry preferences when you call [`requestGeometryUpdate(_:errorHandler:)`](/documentation/UIKit/UIWindowScene/requestGeometryUpdate(_:errorHandler:)).

## Topics

### Creating a geometry preferences object

[`convenience init(systemFrame: CGRect)`](/documentation/UIKit/UIWindowScene/GeometryPreferences/Mac/init(systemFrame:))

Initializes a new window scene geometry preferences object with the specified window frame.

[`init()`](/documentation/UIKit/UIWindowScene/GeometryPreferences/Mac/init())

Initializes a new window scene geometry preferences object.

### Accessing geometry information

[`var systemFrame: CGRect?`](/documentation/UIKit/UIWindowScene/GeometryPreferences/Mac/systemFrame)

The preferred frame of the scene, in system coordinates.

[`@property (nonatomic, assign) CGRect systemFrame;`](/documentation/UIKit/UIWindowSceneGeometryPreferencesMac/systemFrame)

The preferred frame of the scene, in system coordinates.

## See Also

[`var effectiveGeometry: UIWindowScene.Geometry`](/documentation/UIKit/UIWindowScene/effectiveGeometry)

The current values for the window scene’s geometry in system space.

[`func requestGeometryUpdate(UIWindowScene.GeometryPreferences, errorHandler: ((any Error) -> Void)?)`](/documentation/UIKit/UIWindowScene/requestGeometryUpdate(_:errorHandler:))

Requests an update to the window scene’s geometry using the specified geometry preferences object.

[`@property (nonatomic, assign) CGRect systemFrame;`](/documentation/UIKit/UIWindowSceneGeometryPreferencesMac/systemFrame)

The preferred frame of the scene, in system coordinates.

## Relationships

### Conforms To

[`NSObjectProtocol`](/documentation/ObjectiveC/NSObjectProtocol)

[`Equatable`](/documentation/Swift/Equatable)

[`Sendable`](/documentation/Swift/Sendable)

[`CustomStringConvertible`](/documentation/Swift/CustomStringConvertible)

[`Hashable`](/documentation/Swift/Hashable)

[`SendableMetatype`](/documentation/Swift/SendableMetatype)

[`CustomDebugStringConvertible`](/documentation/Swift/CustomDebugStringConvertible)

[`CVarArg`](/documentation/Swift/CVarArg)

### Inherits From

[`GeometryPreferences`](/documentation/UIKit/UIWindowScene/GeometryPreferences)

---

Copyright &copy; 2026 Apple Inc. All rights reserved. | [Terms of Use](https://www.apple.com/legal/internet-services/terms/site.html) | [Privacy Policy](https://www.apple.com/privacy/privacy-policy)
