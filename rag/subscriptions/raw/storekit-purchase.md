# 出典

- URL: https://developer.apple.com/documentation/storekit/product/purchase%28options%3A%29.md
- 取得日: 2026-09-28
- 確度: Apple公式文書の原文

<!--
{
  "availability" : [
    "iOS: 15.0.0 -",
    "iPadOS: 15.0.0 -",
    "macOS: 12.0.0 -",
    "tvOS: 15.0.0 -",
    "watchOS: 8.0.0 -"
  ],
  "documentType" : "symbol",
  "framework" : "StoreKit",
  "identifier" : "/documentation/StoreKit/Product/purchase(options:)",
  "metadataVersion" : "0.1.0",
  "role" : "Instance Method",
  "symbol" : {
    "kind" : "Instance Method",
    "modules" : [
      "StoreKit"
    ],
    "preciseIdentifier" : "s:8StoreKit7ProductV8purchase7optionsAC14PurchaseResultOShyAC0F6OptionVG_tYaKF"
  },
  "title" : "purchase(options:)"
}
-->

# purchase(options:)

Initiates a purchase for the product with the App Store and displays the confirmation sheet.

```
@MainActor func purchase(options: Set<Product.PurchaseOption> = []) async throws -> Product.PurchaseResult
```

## Parameters

`options`

A set of options you can associate with the purchase.

## Return Value

Returns a [`Product.PurchaseResult`](/documentation/StoreKit/Product/PurchaseResult).

## Discussion

StoreKit provides several APIs you can use to enable customers to initiate a purchase. Before using [`purchase(options:)`](/documentation/StoreKit/Product/purchase(options:)) consider the following APIs and choose the one that best suits your app’s implementation:

- Use [`PurchaseAction`](/documentation/StoreKit/PurchaseAction) for apps that use <doc://com.apple.documentation/documentation/SwiftUI> on any platform, including multi-scene apps for visionOS.
- Use [`purchase(confirmIn:options:)`](/documentation/StoreKit/Product/purchase(confirmIn:options:)-6dj6y) for apps that use <doc://com.apple.documentation/documentation/UIKit>.
- Use [`purchase(confirmIn:options:)`](/documentation/StoreKit/Product/purchase(confirmIn:options:)-8eai6) for apps that run on macOS and use <doc://com.apple.documentation/documentation/AppKit>.
- Use [`purchase(options:)`](/documentation/StoreKit/Product/purchase(options:)) for apps that runs on watchOS.

> Important:
> If you use StoreKit views such as ``doc://com.apple.storekit/documentation/StoreKit/ProductView``, ``doc://com.apple.storekit/documentation/StoreKit/StoreView``, or ``doc://com.apple.storekit/documentation/StoreKit/SubscriptionStoreView`` you don’t need to call any other API to initiate a purchase. StoreKit manages the purchase action automatically, including presenting the purchase confirmation UI. For more information, see <doc://com.apple.storekit/documentation/StoreKit/storekit-views>.

### Use the purchase API

Call the [`purchase(options:)`](/documentation/StoreKit/Product/purchase(options:)) method when a customer initiates a purchase, either within your app or after selecting a promoted Apple In-App Purchase on the App Store. This method brings up the system-confirmation sheet. The user can confirm to complete the transaction or cancel it.

Include the purchase options to provide additional information about the purchase, such as:

- [`appAccountToken(_:)`](/documentation/StoreKit/Product/PurchaseOption/appAccountToken(_:)) to associate the purchase with the resulting transaction
- [`promotionalOffer(offerID:keyID:nonce:signature:timestamp:)`](/documentation/StoreKit/Product/PurchaseOption/promotionalOffer(offerID:keyID:nonce:signature:timestamp:)), if the customer is redeeming a promotional offer for an auto-renewable subscription
- [`quantity(_:)`](/documentation/StoreKit/Product/PurchaseOption/quantity(_:)), if the customer is purchasing more than one of the product

The following example illustrates calling [`purchase(options:)`](/documentation/StoreKit/Product/purchase(options:)) using the `options` parameter to provide an app account token:

```swift
let appAccountToken = <# Generate an app account token. #>
let purchaseResult = try await product.purchase(options: [
    .appAccountToken(appAccountToken)
])
```

If you’re testing your app in the sandbox environment, test an Ask to Buy scenario by setting the [`simulatesAskToBuyInSandbox(_:)`](/documentation/StoreKit/Product/PurchaseOption/simulatesAskToBuyInSandbox(_:)) purchase option to `true`. For more information about Ask to Buy, see [Approve what kids buy with Ask to Buy](https://support.apple.com/en-us/HT201089).

This method may throw a [`Product.PurchaseError`](/documentation/StoreKit/Product/PurchaseError) or [`StoreKitError`](/documentation/StoreKit/StoreKitError).

For more information about purchases that users initiate on the App Store, see [Promoting Apple In-App Purchases](/documentation/StoreKit/promoting-in-app-purchases).

---

Copyright &copy; 2026 Apple Inc. All rights reserved. | [Terms of Use](https://www.apple.com/legal/internet-services/terms/site.html) | [Privacy Policy](https://www.apple.com/privacy/privacy-policy)