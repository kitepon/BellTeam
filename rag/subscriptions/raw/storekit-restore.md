# 出典

- URL: https://developer.apple.com/documentation/storekit/appstore/sync%28%29.md
- 取得日: 2026-09-28
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
  "identifier" : "/documentation/StoreKit/AppStore/sync()",
  "metadataVersion" : "0.1.0",
  "role" : "Type Method",
  "symbol" : {
    "kind" : "Type Method",
    "modules" : [
      "StoreKit"
    ],
    "preciseIdentifier" : "s:8StoreKit03AppA0O4syncyyYaKFZ"
  },
  "title" : "sync()"
}
-->

# sync()

Synchronizes your app’s transaction information and subscription status with information from the App Store.

```
static func sync() async throws
```

## Discussion

Include some mechanism in your app, such as a Restore Purchases button, to let users restore their Apple In-App Purchases. In rare cases when a user suspects the app isn’t showing all the transactions, call [`sync()`](/documentation/StoreKit/AppStore/sync()). By calling [`sync()`](/documentation/StoreKit/AppStore/sync()), you force the app to obtain transaction information and subscription status from the App Store.

> Important:
> Calling ``doc://com.apple.storekit/documentation/StoreKit/AppStore/sync()``displays a system prompt that asks users to authenticate with their App Store credentials. Call this function only in response to an explicit user action, like tapping or clicking a button.

In regular operations, there’s no need to call [`sync()`](/documentation/StoreKit/AppStore/sync()). StoreKit automatically keeps up to date transaction information and subscription status available to your app. When users reinstall your app or download it on a new device, the app automatically has all transactions available to it upon initial launch. There’s no need for users to ask your app to restore transactions — your app can immediately get the current entitlements using [`currentEntitlements`](/documentation/StoreKit/Transaction/currentEntitlements) and transaction history using [`all`](/documentation/StoreKit/Transaction/all). For more information about transactions, see [`Transaction`](/documentation/StoreKit/Transaction).

---

Copyright &copy; 2026 Apple Inc. All rights reserved. | [Terms of Use](https://www.apple.com/legal/internet-services/terms/site.html) | [Privacy Policy](https://www.apple.com/privacy/privacy-policy)