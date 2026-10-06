出典: https://developer.apple.com/documentation/swiftui/view/onscrollgeometrychange(for:of:action:).md
取得日: 2026-10-07
確度: Apple公式原文

<!--
{
  "availability" : [
    "iOS: 18.0.0 -",
    "iPadOS: 18.0.0 -",
    "macCatalyst: 18.0.0 -",
    "macOS: 15.0.0 -",
    "tvOS: 18.0.0 -",
    "visionOS: 2.0.0 -",
    "watchOS: 11.0.0 -"
  ],
  "documentType" : "symbol",
  "framework" : "SwiftUI",
  "identifier" : "/documentation/SwiftUI/View/onScrollGeometryChange(for:of:action:)",
  "metadataVersion" : "0.1.0",
  "role" : "Instance Method",
  "symbol" : {
    "kind" : "Instance Method",
    "modules" : [
      "SwiftUI"
    ],
    "preciseIdentifier" : "s:7SwiftUI4ViewPAAE22onScrollGeometryChange3for2of6actionQrqd__m_qd__AA0eF0Vcyqd___qd__tctSQRd__lF"
  },
  "title" : "onScrollGeometryChange(for:of:action:)"
}
-->

# onScrollGeometryChange(for:of:action:)

Adds an action to be performed when a value, created from a
scroll geometry, changes.

```
nonisolated func onScrollGeometryChange<T>(for type: T.Type, of transform: @escaping (ScrollGeometry) -> T, action: @escaping (T, T) -> Void) -> some View where T : Equatable
```

## Parameters

`type`

The type of value transformed from a [`ScrollGeometry`](/documentation/SwiftUI/ScrollGeometry).

`transform`

A closure that transforms a [`ScrollGeometry`](/documentation/SwiftUI/ScrollGeometry)
to your type.

`action`

A closure to run when the transformed data changes.

- oldValue: The old value that failed the comparison check.
- newValue: The new value that failed the comparison check.

## Discussion

The geometry of a scroll view changes frequently while scrolling.
You should avoid updating large parts of your app whenever
the scroll geometry changes. To aid in this, you provide two
closures to this modifier:

- transform: This converts a value of [`ScrollGeometry`](/documentation/SwiftUI/ScrollGeometry) to a
  your own data type.
- action: This provides the data type you created in `of`
  and is called whenever the data type changes.

For example, you can use this modifier to know when the user scrolls
a scroll view beyond the top of its content. In the following example,
the data type you convert to is a `Bool` and the action is called
whenever the `Bool` changes.

```
@Binding var isBeyondZero: Bool

ScrollView {
    // ...
}
.onScrollGeometryChange(for: Bool.self) { geometry in
    geometry.contentOffset.y < geometry.contentInsets.top
} action: { wasBeyondZero, isBeyondZero in
    self.isBeyondZero = isBeyondZero
}
```

If multiple scroll views are found within the view hierarchy,
only the first one will invoke the closure you provide and a runtime
issue will be logged. For example, in the following view, only the
vertical scroll view will have its geometry changes invoke the provided
closure.

```
VStack {
    ScrollView(.vertical) { ... }
    ScrollView(.horizontal) { ... }
}
.onScrollGeometryChange(for: Bool.self) { geometry in
     ...
} action: { oldValue, newValue in
    ...
}
```

For responding to non-scroll geometry changes, see the
[`onGeometryChange(for:of:action:)`](/documentation/SwiftUI/View/onGeometryChange(for:of:action:)) modifier.

---

Copyright &copy; 2026 Apple Inc. All rights reserved. | [Terms of Use](https://www.apple.com/legal/internet-services/terms/site.html) | [Privacy Policy](https://www.apple.com/privacy/privacy-policy)