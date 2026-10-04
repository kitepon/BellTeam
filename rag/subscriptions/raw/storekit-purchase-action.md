# 出典

- URL: https://developer.apple.com/documentation/storekit/purchaseaction.md
- 取得日: 2026-09-28
- 確度: Apple公式文書の原文

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
  "framework" : "StoreKit",
  "identifier" : "/documentation/StoreKit/PurchaseAction",
  "metadataVersion" : "0.1.0",
  "role" : "Structure",
  "symbol" : {
    "kind" : "Structure",
    "modules" : [
      "StoreKit",
      "SwiftUI"
    ],
    "preciseIdentifier" : "s:17_StoreKit_SwiftUI14PurchaseActionV"
  },
  "title" : "PurchaseAction"
}
-->

# PurchaseAction

An action that starts an Apple In-App Purchase.

```
@MainActor @preconcurrency struct PurchaseAction
```

## Overview

StoreKit provides several APIs you can use to enable customers to initiate a purchase. Choose the API that suits your app’s implementation, specifically:

- Use `PurchaseAction` for apps that use <doc://com.apple.documentation/documentation/SwiftUI>, including multi-scene apps for visionOS.
- Use [`purchase(confirmIn:options:)`](/documentation/StoreKit/Product/purchase(confirmIn:options:)-3bivf) for apps that use <doc://com.apple.documentation/documentation/UIKit>.
- Use [`purchase(options:)`](/documentation/StoreKit/Product/purchase(options:)) if your app runs on watchOS or macOS.

> Important:
> If you use StoreKit views such as ``doc://com.apple.storekit/documentation/StoreKit/ProductView``, ``doc://com.apple.storekit/documentation/StoreKit/StoreView``, or ``doc://com.apple.storekit/documentation/StoreKit/SubscriptionStoreView`` you don’t need to call any other API to initiate a purchase. StoreKit manages the purchase action automatically, including presenting the purchase confirmation UI. For more information, see <doc://com.apple.storekit/documentation/StoreKit/storekit-views>.

### Use the purchase action API

Use `PurchaseAction` instead of [`purchase(options:)`](/documentation/StoreKit/Product/purchase(options:)) for SwiftUI implementations, including multi-scene apps for visionOS. Call the instance to start an Apple In-App Purchase.

To use this API, read the `PurchaseAction` environment value to get an instance of the structure for a given <doc://com.apple.documentation/documentation/SwiftUI/Environment>. You call the instance directly because it defines a [`callAsFunction(_:options:)`](/documentation/StoreKit/PurchaseAction/callAsFunction(_:options:)) method that Swift calls when you call the instance.

When you initiate an Apple In-App Purchase, the system presents UI for the customer to confirm the purchase details. The purchase action you get from the environment automatically includes the UI context. It presents the confirmation UI in proximity to the scene in which the view displays.

The following code shows an example of starting an Apple In-App Purchase when a person taps a button:

```swift
struct PurchaseExample: View {
    @Environment(\.purchase) private var purchase: PurchaseAction
    let product: Product
    let purchaseOptions: [Product.PurchaseOption]

    var body: some View {
        Button {
            Task {
                let purchaseResult = try? await purchase(product, options: purchaseOptions)
                 // Process the purchase result.
            }
        } label: {
            Text(product.displayName)
        }
    }
}
```

Note that the second line in the code example can omit the type name, as follows, because the compiler can infer the type:

```swift
@Environment(\.purchase) private var purchase
```

## Topics

### Calling the action

[`func callAsFunction(Product, options: Set<Product.PurchaseOption>) async throws -> Product.PurchaseResult`](/documentation/StoreKit/PurchaseAction/callAsFunction(_:options:))

Starts an Apple In-App Purchase for the indicated product and purchase options.

### Instance Methods

[`func callAsFunction(AdvancedCommerceProduct, compactJWS: String, options: Set<AdvancedCommerceProduct.PurchaseOption>) async throws -> AdvancedCommerceProduct.PurchaseResult`](/documentation/StoreKit/PurchaseAction/callAsFunction(_:compactJWS:options:))

## Relationships

### Conforms To

[`SendableMetatype`](/documentation/Swift/SendableMetatype)

[`Sendable`](/documentation/Swift/Sendable)

---

Copyright &copy; 2026 Apple Inc. All rights reserved. | [Terms of Use](https://www.apple.com/legal/internet-services/terms/site.html) | [Privacy Policy](https://www.apple.com/privacy/privacy-policy)