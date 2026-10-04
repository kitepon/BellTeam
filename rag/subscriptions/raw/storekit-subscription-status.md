# 出典

- URL: https://developer.apple.com/documentation/storekit/product/subscriptioninfo/status(for:).md
- 取得日: 2026-10-02
- 確度: Apple公式文書の原文

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
  "identifier" : "/documentation/StoreKit/Product/SubscriptionInfo/status(for:)",
  "metadataVersion" : "0.1.0",
  "role" : "Type Method",
  "symbol" : {
    "kind" : "Type Method",
    "modules" : [
      "StoreKit"
    ],
    "preciseIdentifier" : "s:8StoreKit7ProductV16SubscriptionInfoV6status3forSayAE6StatusVGSS_tYaKFZ"
  },
  "title" : "status(for:)"
}
-->

# status(for:)

Gets the subscription status for a subscription group identifier.

```
static func status(for groupID: String) async throws -> [Product.SubscriptionInfo.Status]
```

## Parameters

`groupID`

The subscription group identifier of the subscription to get status for.

## Return Value

An array of [`Product.SubscriptionInfo.Status`](/documentation/StoreKit/Product/SubscriptionInfo/Status-swift.struct). This array is empty if the customer has never subscribed to a product in this subscription group.

## Discussion

To get the subscription group identifier of a subscription, see [`subscriptionGroupID`](/documentation/StoreKit/Product/SubscriptionInfo/subscriptionGroupID) in [`Product.SubscriptionInfo`](/documentation/StoreKit/Product/SubscriptionInfo), or [`subscriptionGroupID`](/documentation/StoreKit/Transaction/subscriptionGroupID) in [`Transaction`](/documentation/StoreKit/Transaction). You originally create subscription group identifiers when you set up Apple In-App Purchases in App Store Connect. For more information, see [Offer auto-renewable subscriptions](https://help.apple.com/app-store-connect/#/dev75708c031).

Users can only buy one auto-renewable subscription within a group at a time. However, the returned array may contain multiple status values if your subscription supports Family Sharing, and the person has access to other subscriptions in the group through Family Sharing. For more information about Family Sharing, see [Enable Family Sharing for your subscriptions](https://developer.apple.com/news/?id=ksfkdwpr).

---

Copyright &copy; 2026 Apple Inc. All rights reserved. | [Terms of Use](https://www.apple.com/legal/internet-services/terms/site.html) | [Privacy Policy](https://www.apple.com/privacy/privacy-policy)