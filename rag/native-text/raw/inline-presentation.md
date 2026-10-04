出典: https://developer.apple.com/documentation/foundation/inlinepresentationintent.md
取得日: 2026-09-30
確度: Apple公式仕様の原文

<!--
{
  "availability" : [
    "iOS: 15.0.0 -",
    "iPadOS: 15.0.0 -",
    "macCatalyst: 15.0.0 -",
    "macOS: 12.0.0 -",
    "tvOS: 15.0.0 -",
    "visionOS: 1.0.0 -",
    "watchOS: 8.0.0 -"
  ],
  "documentType" : "symbol",
  "framework" : "Foundation",
  "identifier" : "/documentation/Foundation/InlinePresentationIntent",
  "metadataVersion" : "0.1.0",
  "role" : "Structure",
  "symbol" : {
    "kind" : "Structure",
    "modules" : [
      "Foundation"
    ],
    "preciseIdentifier" : "c:@E@NSInlinePresentationIntent"
  },
  "title" : "InlinePresentationIntent"
}
-->

# InlinePresentationIntent

A type that defines presentation intent for runs of characters for traits like emphasis, strikethrough, and code voice.

```
struct InlinePresentationIntent
```

## Topics

### Getting inline presentation types

[`static var code: InlinePresentationIntent`](/documentation/Foundation/InlinePresentationIntent/code)

An intent that represents a code voice presentation.

[`static var emphasized: InlinePresentationIntent`](/documentation/Foundation/InlinePresentationIntent/emphasized)

An intent that represents an emphasized presentation.

[`static var lineBreak: InlinePresentationIntent`](/documentation/Foundation/InlinePresentationIntent/lineBreak)

An intent that represents a line break.

[`static var softBreak: InlinePresentationIntent`](/documentation/Foundation/InlinePresentationIntent/softBreak)

An intent that represents a soft line break.

[`static var strikethrough: InlinePresentationIntent`](/documentation/Foundation/InlinePresentationIntent/strikethrough)

An intent that represents a strikethrough presentation.

[`static var stronglyEmphasized: InlinePresentationIntent`](/documentation/Foundation/InlinePresentationIntent/stronglyEmphasized)

An intent that represents a strongly emphasized presentation.

[`static var inlineHTML: InlinePresentationIntent`](/documentation/Foundation/InlinePresentationIntent/inlineHTML)

An intent that represents an inline HTML presentation.

[`static var blockHTML: InlinePresentationIntent`](/documentation/Foundation/InlinePresentationIntent/blockHTML)

An intent that represents a block HTML presentation.

### Initializers

[`init(rawValue: UInt)`](/documentation/Foundation/InlinePresentationIntent/init(rawValue:))

Creates an inline presentation intent using the raw value you specify.

## Relationships

### Conforms To

[`Hashable`](/documentation/Swift/Hashable)

[`Sendable`](/documentation/Swift/Sendable)

[`SetAlgebra`](/documentation/Swift/SetAlgebra)

[`Equatable`](/documentation/Swift/Equatable)

[`OptionSet`](/documentation/Swift/OptionSet)

[`SendableMetatype`](/documentation/Swift/SendableMetatype)

[`ExpressibleByArrayLiteral`](/documentation/Swift/ExpressibleByArrayLiteral)

[`RawRepresentable`](/documentation/Swift/RawRepresentable)

[`BitwiseCopyable`](/documentation/Swift/BitwiseCopyable)

[`Escapable`](/documentation/Swift/Escapable)

[`Decodable`](/documentation/Swift/Decodable)

[`Copyable`](/documentation/Swift/Copyable)

[`Encodable`](/documentation/Swift/Encodable)

---

Copyright &copy; 2026 Apple Inc. All rights reserved. | [Terms of Use](https://www.apple.com/legal/internet-services/terms/site.html) | [Privacy Policy](https://www.apple.com/privacy/privacy-policy)