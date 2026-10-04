出典: https://developer.apple.com/documentation/storekit/transaction/currententitlements.md
取得日: 2026-10-03
確度: Apple公式原文

<!--
{
  "availability" : [
    "iOS: 15.0.0 -",
    "iPadOS: 15.0.0 -",
    "macOS: 12.0.0 -",
    "tvOS: 15.0.0 -",
    "visionOS: 1.0.0 -",
    "watchOS: 8.0.0 -"
  ],
  "documentType" : "symbol",
  "framework" : "StoreKit",
  "identifier" : "/documentation/StoreKit/Transaction/currentEntitlements",
  "metadataVersion" : "0.1.0",
  "role" : "Type Property",
  "symbol" : {
    "kind" : "Type Property",
    "modules" : [
      "StoreKit"
    ],
    "preciseIdentifier" : "s:8StoreKit11TransactionV19currentEntitlementsAC12TransactionsVvpZ"
  },
  "title" : "currentEntitlements"
}
-->

# currentEntitlements

A sequence of the latest transactions that entitle a customer to Apple In-App Purchases and subscriptions.

```
static var currentEntitlements: Transaction.Transactions { get }
```

## Discussion

The current entitlements sequence emits the latest transaction for each product the customer has an entitlement to, specifically:

- A transaction for each non-consumable Apple In-App Purchase
- The latest transaction for each auto-renewable subscription that has a [`Product.SubscriptionInfo.RenewalState`](/documentation/StoreKit/Product/SubscriptionInfo/RenewalState) state of [`subscribed`](/documentation/StoreKit/Product/SubscriptionInfo/RenewalState/subscribed) or [`inGracePeriod`](/documentation/StoreKit/Product/SubscriptionInfo/RenewalState/inGracePeriod)
- The latest transaction for each non-renewing subscription, including finished ones

Products that the App Store has refunded or revoked don’t appear in the current entitlements. Consumable Apple In-App Purchases also don’t appear in the current entitlements. To get transactions for unfinished consumables, use the [`unfinished`](/documentation/StoreKit/Transaction/unfinished) or [`all`](/documentation/StoreKit/Transaction/all) sequences in [`Transaction`](/documentation/StoreKit/Transaction).

The following example illustrates iterating through the current entitlements:

```swift
func refreshPurchasedProducts() async {
    // Iterate through the user's purchased products.
    for await verificationResult in Transaction.currentEntitlements {
        switch verificationResult {
        case .verified(let transaction):
            // Check the type of product for the transaction
            // and provide access to the content as appropriate.
            ...
        case .unverified(let unverifiedTransaction, let verificationError):
            // Handle unverified transactions based on your
            // business model.
            ...
        }
    }
}
```

---

Copyright &copy; 2026 Apple Inc. All rights reserved. | [Terms of Use](https://www.apple.com/legal/internet-services/terms/site.html) | [Privacy Policy](https://www.apple.com/privacy/privacy-policy)