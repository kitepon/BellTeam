# 出典

- URL: https://developer.apple.com/documentation/storekit/transaction-properties.md
- 取得日: 2026-10-02
- 確度: Apple公式文書の原文

<!--
{
  "documentType" : "article",
  "framework" : "StoreKit",
  "identifier" : "/documentation/StoreKit/transaction-properties",
  "metadataVersion" : "0.1.0",
  "role" : "collectionGroup",
  "title" : "Transaction properties"
}
-->

# Transaction properties

The properties of a transaction, including identifiers, purchase and revocation dates and details, status, and offer details.

## Topics

### Getting the environment and storefront

[`let environment: AppStore.Environment`](/documentation/StoreKit/Transaction/environment)

The server environment that generates and signs the transaction.

[`let storefront: Storefront`](/documentation/StoreKit/Transaction/storefront)

The App Store storefront associated with the transaction.

### Getting the original transaction identifier

[`let originalID: UInt64`](/documentation/StoreKit/Transaction/originalID)

The original transaction identifier of a purchase.

[`let originalPurchaseDate: Date`](/documentation/StoreKit/Transaction/originalPurchaseDate)

The date of purchase for the original transaction.

### Identifying a transaction

[`let id: UInt64`](/documentation/StoreKit/Transaction/id)

The unique identifier for the transaction.

[`let webOrderLineItemID: String?`](/documentation/StoreKit/Transaction/webOrderLineItemID)

A unique ID that identifies subscription purchase events across devices, including subscription renewals.

### Identifying the app and product

[`let appBundleID: String`](/documentation/StoreKit/Transaction/appBundleID)

The bundle identifier for the app.

[`let productID: String`](/documentation/StoreKit/Transaction/productID)

The product identifier of the Apple In-App Purchase.

[`let productType: Product.ProductType`](/documentation/StoreKit/Transaction/productType)

The type of the Apple In-App Purchase.

[`let subscriptionGroupID: String?`](/documentation/StoreKit/Transaction/subscriptionGroupID)

The identifier of the subscription group that the subscription belongs to.

### Getting purchase and expiration dates

[`let purchaseDate: Date`](/documentation/StoreKit/Transaction/purchaseDate)

The date that the App Store charged the user’s account for a purchased or restored product, or for a subscription purchase or renewal after a lapse.

[`let expirationDate: Date?`](/documentation/StoreKit/Transaction/expirationDate)

The date the subscription expires or renews.

### Getting the product price and currency

[`var price: Decimal?`](/documentation/StoreKit/Transaction/price)

The price of the Apple In-App Purchase that the system records in the transaction.

[`var currency: Locale.Currency?`](/documentation/StoreKit/Transaction/currency)

The currency of the price of the product.

### Getting purchase details

[`let isUpgraded: Bool`](/documentation/StoreKit/Transaction/isUpgraded)

A Boolean that indicates whether the user upgraded to another subscription.

[`let ownershipType: Transaction.OwnershipType`](/documentation/StoreKit/Transaction/ownershipType-swift.property)

A value that indicates whether the transaction was purchased by the user, or is made available to them through Family Sharing.

[`struct OwnershipType`](/documentation/StoreKit/Transaction/OwnershipType-swift.struct)

The types the system uses to describe whether the user purchased the product or it’s available to them through Family Sharing.

[`let purchasedQuantity: Int`](/documentation/StoreKit/Transaction/purchasedQuantity)

The number of consumable products purchased.

### Getting subscription status

[`var subscriptionStatus: Product.SubscriptionInfo.Status?`](/documentation/StoreKit/Transaction/subscriptionStatus)

An array that contains status information for a subscription group, including renewal and transaction information.

### Getting transaction reason

[`let reason: Transaction.Reason`](/documentation/StoreKit/Transaction/reason-swift.property)

The cause of the purchase transaction, whether it’s a customer’s purchase or an auto-renewable subscription renewal that the system initiates.

[`struct Reason`](/documentation/StoreKit/Transaction/Reason-swift.struct)

A cause of a purchase transaction, indicating whether it’s a customer’s purchase or an auto-renewable subscription renewal that the system initiates.

### Identifying offers

[`let offer: Transaction.Offer?`](/documentation/StoreKit/Transaction/offer-swift.property)

The offer that applies to the transaction, including its offer type, payment mode, and ID.

[`struct Offer`](/documentation/StoreKit/Transaction/Offer-swift.struct)

Discounts or promotions that apply to a transaction.

### Getting revocation status

[`let revocationDate: Date?`](/documentation/StoreKit/Transaction/revocationDate)

The date that the App Store refunded the transaction or revoked it from Family Sharing.

[`let revocationReason: Transaction.RevocationReason?`](/documentation/StoreKit/Transaction/revocationReason-swift.property)

The reason that the App Store refunded the transaction or revoked it from Family Sharing.

[`struct RevocationReason`](/documentation/StoreKit/Transaction/RevocationReason-swift.struct)

Reasons that describe why the App Store may refund a transaction or revoke it from Family Sharing.

### Correlating transactions with accounts

[`let appAccountToken: UUID?`](/documentation/StoreKit/Transaction/appAccountToken)

A UUID that associates the transaction with a user on your own service.

### Getting the transaction information in JSON format

[`var jsonRepresentation: Data`](/documentation/StoreKit/Transaction/jsonRepresentation)

The JSON representation of the transaction information.

### Deprecated

[`var currencyCode: String?`](/documentation/StoreKit/Transaction/currencyCode)

The three-letter ISO 4217 currency code for the price of the product.

[`var environmentStringRepresentation: String`](/documentation/StoreKit/Transaction/environmentStringRepresentation)

A string representation of the server environment.

[`var offerID: String?`](/documentation/StoreKit/Transaction/offerID)

A string that identifies an offer applied to the current subscription.

[`var offerPaymentModeStringRepresentation: String?`](/documentation/StoreKit/Transaction/offerPaymentModeStringRepresentation)

The string representation of the payment mode for a subscription offer.

[`var offerType: Transaction.OfferType?`](/documentation/StoreKit/Transaction/offerType-swift.property)

The subscription offer type for the current subscription period.

[`var reasonStringRepresentation: String`](/documentation/StoreKit/Transaction/reasonStringRepresentation)

The string representation of the transaction reason.

[`var storefrontCountryCode: String`](/documentation/StoreKit/Transaction/storefrontCountryCode)

The three-letter code that represents the country or region associated with the App Store storefront of the purchase.



---

Copyright &copy; 2026 Apple Inc. All rights reserved. | [Terms of Use](https://www.apple.com/legal/internet-services/terms/site.html) | [Privacy Policy](https://www.apple.com/privacy/privacy-policy)