# 出典

- URL: https://developer.apple.com/documentation/storekit/transaction.md
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
  "identifier" : "/documentation/StoreKit/Transaction",
  "metadataVersion" : "0.1.0",
  "role" : "Structure",
  "symbol" : {
    "kind" : "Structure",
    "modules" : [
      "StoreKit"
    ],
    "preciseIdentifier" : "s:8StoreKit11TransactionV"
  },
  "title" : "Transaction"
}
-->

# Transaction

Information that represents the customer’s purchase of a product in your app.

```
struct Transaction
```

## Overview

A *transaction* represents a successful Apple In-App Purchase. The App Store generates a transaction each time a customer purchases an Apple In-App Purchase product or renews a subscription. For each transaction that represents a current purchase, your app unlocks the purchased content or service and finishes the transaction.

Use the `Transaction` type to perform these transaction-related tasks:

- Get the customer’s transaction history, latest transactions, and current entitlements to unlock content and services.
- Access transaction properties.
- Finish a transaction after your app delivers the purchased content or service.
- Access the raw JSON Web Signature (JWS) string and supporting values to verify the transaction information.
- Listen for new transactions while the app is running.
- Begin a refund request from within your app.

### Access transaction history and current entitlements

Your app doesn’t create transaction objects. Instead, StoreKit automatically makes up-to-date transactions available to your app, including when someone launches the app for the first time.

> Related sessions from WWDC22:
> Session 110404: [Implement proactive Apple In-App Purchase restore](https://developer.apple.com/videos/play/wwdc2022/110404/)

You access transactions in several ways:

- Get transaction history anytime by accessing the static [`all`](/documentation/StoreKit/Transaction/all) sequence, or get just the most recent transaction for a product with the [`latestTransaction`](/documentation/StoreKit/Product/latestTransaction) property of [`Product`](/documentation/StoreKit/Product).
- Receive notifications for new transactions while your app is running when customers complete a purchase outside of the app, including on another device, through the transaction listener, [`updates`](/documentation/StoreKit/Transaction/updates).
- Access the latest transaction for a subscription group through the subscription status API, using [`transaction`](/documentation/StoreKit/Product/SubscriptionInfo/Status-swift.struct/transaction).
- After a successful Apple In-App Purchase, StoreKit returns the transaction through [`Product.PurchaseResult.success(_:)`](/documentation/StoreKit/Product/PurchaseResult/success(_:)).

The most important use of transaction information is for determining which Apple In-App Purchases the customer has paid access to, so your app can unlock the content or service. The [`currentEntitlements`](/documentation/StoreKit/Transaction/currentEntitlements) API provides the information you need to unlock all of the customer’s paid content in your app. Use `currentEntitlements` to get a list of transactions for all the products the customer is currently entitled to, including non-consumable Apple In-App Purchases and currently active subscriptions.

### Verify transactions

The App Store cryptographically signs transaction information in JWS format. StoreKit automatically validates and returns the signed information, wrapped in a [`VerificationResult`](/documentation/StoreKit/VerificationResult). When the `VerificationResult` wraps a `Transaction` value, it provides the raw JWS string in the [`jwsRepresentation`](/documentation/StoreKit/VerificationResult/jwsRepresentation-21vgo) property. If you get a transaction through [`VerificationResult.verified(_:)`](/documentation/StoreKit/VerificationResult/verified(_:)), the information passed validation. If you get it through [`VerificationResult.unverified(_:_:)`](/documentation/StoreKit/VerificationResult/unverified(_:_:)), the information didn’t pass StoreKit’s automatic validation. Your app can immediately access the transaction information in the [Transaction properties](/documentation/StoreKit/transaction-properties).

To perform your own validation on the device, use the verification result’s [`jwsRepresentation`](/documentation/StoreKit/VerificationResult/jwsRepresentation-21vgo) string, and use the provided convenience properties [`headerData`](/documentation/StoreKit/VerificationResult/headerData-9egfp), [`payloadData`](/documentation/StoreKit/VerificationResult/payloadData-uyle), and [`signatureData`](/documentation/StoreKit/VerificationResult/signatureData-4pyv8). For added control and security, send the `jwsRepresentation` to your server to verify. Consider using the App Store Server Library to implement your verification. The library provides the functions `verifyAndDecodeTransaction` and `verifyAndDecodeRenewalInfo` in each language the library supports. For more information, see <doc://com.apple.documentation/documentation/AppStoreServerAPI/simplifying-your-implementation-by-using-the-app-store-server-library>.

> Tip:
> The ``doc://com.apple.storekit/documentation/StoreKit/VerificationResult/jwsRepresentation-21vgo`` is the same as the <doc://com.apple.documentation/documentation/AppStoreServerAPI/JWSTransaction> that the <doc://com.apple.documentation/documentation/AppStoreServerAPI> returns and to the <doc://com.apple.documentation/documentation/AppStoreServerNotifications/JWSTransaction> that you receive in <doc://com.apple.documentation/documentation/AppStoreServerNotifications/App-Store-Server-Notifications-V2>. You can validate them on your server in the same way.

If StoreKit returns a transaction as verified, the transaction is valid for the device. For information about performing your own verification for a device, see [`deviceVerification`](/documentation/StoreKit/Transaction/deviceVerification).

For more information about JWS, see the [IETF RFC 7515](https://datatracker.ietf.org/doc/html/rfc7515) specification.

### Access purchases made with the original API

All Apple In-App Purchases that customers make are equally available to your app in this `Transaction` API, and in receipts using the [Original API for Apple In-App Purchase](/documentation/StoreKit/original-api-for-in-app-purchase), as follows:

- New purchases that customers make with the original API are available immediately using the `Transaction` API.
- Purchases that customers make with the [`purchase(options:)`](/documentation/StoreKit/Product/purchase(options:)) method are available in the original API when your app refreshes the receipt. For more information, see [`SKReceiptRefreshRequest`](/documentation/StoreKit/SKReceiptRefreshRequest).

## Topics

### Transaction properties

[Transaction properties](/documentation/StoreKit/transaction-properties)

The properties of a transaction, including identifiers, purchase and revocation dates and details, status, and offer details.

[`var appTransactionID: String`](/documentation/StoreKit/Transaction/appTransactionID)

The unique identifier of the app download transaction.

### Monitoring transaction-related changes

[`static var updates: Transaction.Transactions`](/documentation/StoreKit/Transaction/updates)

The asynchronous sequence that emits a transaction when the system creates or updates transactions that occur outside the app or on other devices.

[`struct Transactions`](/documentation/StoreKit/Transaction/Transactions)

An asynchronous sequence of transactions.

### Getting transaction history

[`static func latest(for: String) async -> VerificationResult<Transaction>?`](/documentation/StoreKit/Transaction/latest(for:))

Gets the customer’s most recent transaction for an Apple In-App Purchase.

[`static var all: Transaction.Transactions`](/documentation/StoreKit/Transaction/all)

A sequence that emits all the customer’s transactions for your app.

[`static var unfinished: Transaction.Transactions`](/documentation/StoreKit/Transaction/unfinished)

A sequence that emits unfinished transactions for the customer.

  <doc://com.apple.documentation/documentation/BundleResources/Information-Property-List/SKIncludeConsumableInAppPurchaseHistory>

### Getting current entitlements

[`static var currentEntitlements: Transaction.Transactions`](/documentation/StoreKit/Transaction/currentEntitlements)

A sequence of the latest transactions that entitle a customer to Apple In-App Purchases and subscriptions.

### Getting transactions for a product

[`static func all(for: String) -> Transaction.Transactions`](/documentation/StoreKit/Transaction/all(for:))

Gets all the transactions associated with this product ID.

### Finishing the transaction

[`func finish() async`](/documentation/StoreKit/Transaction/finish())

Indicates to the App Store that the app delivered the purchased content or enabled the service to finish the transaction.

[`static var unfinished: Transaction.Transactions`](/documentation/StoreKit/Transaction/unfinished)

A sequence that emits unfinished transactions for the customer.

### Verifying transactions

[`let deviceVerification: Data`](/documentation/StoreKit/Transaction/deviceVerification)

The device verification value you use to verify whether the transaction belongs to the device.

[`let deviceVerificationNonce: UUID`](/documentation/StoreKit/Transaction/deviceVerificationNonce)

The UUID for computing the device verification value.

[`let signedDate: Date`](/documentation/StoreKit/Transaction/signedDate)

The date that the App Store signed the JWS transaction.

### Getting transaction info in JSON format

[`var jsonRepresentation: Data`](/documentation/StoreKit/Transaction/jsonRepresentation)

The JSON representation of the transaction information.

### Requesting refunds

[Testing refund requests](/documentation/StoreKit/testing-refund-requests)

Test your app’s implementation of refund requests, and your app’s and server’s handling of approved and declined refunds.

[`func beginRefundRequest(in: UIWindowScene) async throws -> Transaction.RefundRequestStatus`](/documentation/StoreKit/Transaction/beginRefundRequest(in:)-9k0pj)

Presents the refund request sheet for the transaction in a window scene.

[`func beginRefundRequest(in: NSViewController) async throws -> Transaction.RefundRequestStatus`](/documentation/StoreKit/Transaction/beginRefundRequest(in:)-63bvd)

Presents the refund request sheet for the transaction in a view controller.

[`static func beginRefundRequest(for: UInt64, in: UIWindowScene) async throws -> Transaction.RefundRequestStatus`](/documentation/StoreKit/Transaction/beginRefundRequest(for:in:)-65tph)

Presents the refund request sheet for the specified transaction in a window scene.

[`static func beginRefundRequest(for: UInt64, in: NSViewController) async throws -> Transaction.RefundRequestStatus`](/documentation/StoreKit/Transaction/beginRefundRequest(for:in:)-9mscy)

Presents the refund request sheet for the specified transaction in a view controller.

[`enum RefundRequestError`](/documentation/StoreKit/Transaction/RefundRequestError)

The error codes for refund requests.

[`enum RefundRequestStatus`](/documentation/StoreKit/Transaction/RefundRequestStatus)

The status codes for refund requests.

### Advanced Commerce transaction data

[`let advancedCommerceInfo: Transaction.AdvancedCommerceInfo?`](/documentation/StoreKit/Transaction/advancedCommerceInfo-swift.property)

Metadata for transactions that use the Advanced Commerce API.

[`struct AdvancedCommerceInfo`](/documentation/StoreKit/Transaction/AdvancedCommerceInfo-swift.struct)

Metadata for transactions that use the Advanced Commerce API.

### Getting offer types

[`struct OfferType`](/documentation/StoreKit/Transaction/OfferType-swift.struct)

The types of offers that apply to a transaction.

### Deprecated

[`static func currentEntitlement(for: String) async -> VerificationResult<Transaction>?`](/documentation/StoreKit/Transaction/currentEntitlement(for:))

Gets the latest transactions that entitle the customer to a specified product.

[`static func currentEntitlements(for: String) -> Transaction.Transactions`](/documentation/StoreKit/Transaction/currentEntitlements(for:))

Gets the transactions that entitle the user to items purchased under a product ID.

[`var offerPeriodStringRepresentation: String?`](/documentation/StoreKit/Transaction/offerPeriodStringRepresentation)

The string representation of the offer period applied to the subscription offer for this transaction.

### Structures

[`struct CommitmentInfo`](/documentation/StoreKit/Transaction/CommitmentInfo-swift.struct)

[`struct RevocationType`](/documentation/StoreKit/Transaction/RevocationType-swift.struct)

### Instance Properties

[`let billingPlanType: SubscriptionInfo.BillingPlanType?`](/documentation/StoreKit/Transaction/billingPlanType)

[`var bundleOriginalTransactionID: String?`](/documentation/StoreKit/Transaction/bundleOriginalTransactionID)

[`var bundleProductID: String?`](/documentation/StoreKit/Transaction/bundleProductID)

Identifies the bundle product the transaction is for.
If this transaction is created as a result of a subscription bundle purchase or renewal, this field will be populated with the product ID of the bundle.

[`var bundleSubscriptionGroupID: String?`](/documentation/StoreKit/Transaction/bundleSubscriptionGroupID)

Identifies the subscription bundle group the transaction is for.

[`var bundleTransactionID: String?`](/documentation/StoreKit/Transaction/bundleTransactionID)

[`let commitmentInfo: Transaction.CommitmentInfo?`](/documentation/StoreKit/Transaction/commitmentInfo-swift.property)

[`var previousOriginalTransactionID: UInt64?`](/documentation/StoreKit/Transaction/previousOriginalTransactionID)

The original transaction ID of the subscription this one replaced when a customer switched between a standalone auto-renewable subscription and a subscription bundle (in either direction).

[`var revocationPercentage: Decimal?`](/documentation/StoreKit/Transaction/revocationPercentage)

The percentage of the transaction amount that the App Store has refunded or revoked, expressed as a decimal.

[`let revocationType: Transaction.RevocationType?`](/documentation/StoreKit/Transaction/revocationType-swift.property)

The type of refund or revocation that applies to the transaction.

[`var revocationTypeStringRepresentation: String?`](/documentation/StoreKit/Transaction/revocationTypeStringRepresentation)

The string representation of the [`revocationType`](/documentation/StoreKit/Transaction/revocationType-swift.property), or `nil` if the transaction was not revoked.

## Relationships

### Conforms To

[`Sendable`](/documentation/Swift/Sendable)

[`Escapable`](/documentation/Swift/Escapable)

[`Equatable`](/documentation/Swift/Equatable)

[`Copyable`](/documentation/Swift/Copyable)

[`SendableMetatype`](/documentation/Swift/SendableMetatype)

[`CustomDebugStringConvertible`](/documentation/Swift/CustomDebugStringConvertible)

[`Identifiable`](/documentation/Swift/Identifiable)

[`Hashable`](/documentation/Swift/Hashable)

---

Copyright &copy; 2026 Apple Inc. All rights reserved. | [Terms of Use](https://www.apple.com/legal/internet-services/terms/site.html) | [Privacy Policy](https://www.apple.com/privacy/privacy-policy)