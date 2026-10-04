出典: https://developer.apple.com/documentation/appstoreserverapi/get-all-subscription-statuses
取得日: 2026-09-28
確度: Apple公式文書の原文

---

<!--
{
  "availability" : [

  ],
  "documentType" : "symbol",
  "framework" : "AppStoreServerAPI",
  "identifier" : "/documentation/AppStoreServerAPI/Get-All-Subscription-Statuses",
  "metadataVersion" : "0.1.0",
  "role" : "Web Service Endpoint",
  "symbol" : {
    "kind" : "Web Service Endpoint",
    "modules" : [
      "App Store Server API"
    ],
    "preciseIdentifier" : "rest:app_store_server_api:get:v1-subscriptions-{}"
  },
  "title" : "Get All Subscription Statuses"
}
-->

# Get All Subscription Statuses

Get the statuses for all of a customer’s auto-renewable subscriptions in your app.

## Discussion

This API returns the status for all of the customer’s subscriptions, organized by their subscription group identifier.

Specify multiple values for the `status` query parameter to get a response that contains subscriptions with statuses that match any of the values. For example, the following request returns subscriptions that are active ([`status`](/documentation/AppStoreServerAPI/Get-All-Subscription-Statuses/status) value of `1`) and subscriptions that are in the Billing Grace Period ([`status`](/documentation/AppStoreServerAPI/Get-All-Subscription-Statuses/status) value of `4`):

```javascript
GET https://api.storekit.apple.com/inApps/v1/subscriptions/{anyTransactionId}?status=1&status=4
```

---

Copyright &copy; 2026 Apple Inc. All rights reserved. | [Terms of Use](https://www.apple.com/legal/internet-services/terms/site.html) | [Privacy Policy](https://www.apple.com/privacy/privacy-policy)