出典: https://developer.apple.com/documentation/appstoreconnectapi/working-with-subscription-versions.md
取得日: 2026-10-04
確度: Apple公式一次資料の原文

<!--
{
  "documentType" : "article",
  "framework" : "AppStoreConnectAPI",
  "identifier" : "/documentation/AppStoreConnectAPI/working-with-subscription-versions",
  "metadataVersion" : "0.1.0",
  "role" : "article",
  "title" : "Working with subscription versions"
}
-->

# Working with subscription versions

Manage draft versions of an auto-renewable subscription’s localized metadata and review images before submitting for App Review.

## Discussion

A subscription version is a draft container that groups the localized metadata and review images that go through App Review together. Create a version, attach localizations and images to it, then submit the version through the review submissions workflow. The parent subscription resource holds properties that stay stable across versions — its product ID, subscription duration, group, and pricing — while each version captures the reviewable metadata for a single review cycle.

> Note:
> The pre-4.4.1 workflow that posts localizations and images directly to the subscription (`POST /v1/subscriptionLocalizations`, `POST /v1/subscriptionImages`) is deprecated as of 4.4.1 but remains available for existing integrations. For guidance on moving to the version-based workflow, see <doc://com.apple.appstoreconnectapi/documentation/AppStoreConnectAPI/migrating-in-app-purchase-metadata-to-v2>.

### Understand the version lifecycle

A version moves through these states, exposed on `SubscriptionVersion/Attributes/state`:

- `PREPARE_FOR_SUBMISSION`: The version is open for editing. You can add, change, or remove localizations and images.
- `READY_FOR_REVIEW`: The version belongs to a review submission and is waiting for you to mark that submission `submitted`.
- `WAITING_FOR_REVIEW`: You submitted the review submission, and the version is queued.
- `IN_REVIEW`: App Review is actively reviewing the version.
- `ACCEPTED` or `APPROVED`: The version passed review.
- `REJECTED` or `DEVELOPER_REJECTED`: App Review rejected the version, or you withdrew it.
- `REPLACED_WITH_NEW_VERSION`: A newer version supersedes this one.

Versions are read-only after creation. To change a version’s contents, create a new version.

### Create a version

Create a draft version with `POST /v1/subscriptionVersions` ([`Create a subscription version`](/documentation/AppStoreConnectAPI/POST-v1-subscriptionVersions)). Relate it to the subscription whose metadata you’re updating:

```json
{
  "data": {
    "type": "subscriptionVersions",
    "relationships": {
      "subscription": {
        "data": {
          "type": "subscriptions",
          "id": "6446671421"
        }
      }
    }
  }
}
```

The response returns the new version’s `id` and a `state` of `PREPARE_FOR_SUBMISSION`. Note the `id` — every subsequent step references it.

### Attach a localization to the version

Add a localized display name and description with `POST /v2/subscriptionLocalizations` ([`Create a subscription localization`](/documentation/AppStoreConnectAPI/POST-v2-subscriptionLocalizations)). The payload relates the localization to the version, not the parent subscription:

```json
{
  "data": {
    "type": "subscriptionLocalizations",
    "attributes": {
      "locale": "en-US",
      "name": "All Access — Monthly",
      "description": "Unlimited lessons across every instrument."
    },
    "relationships": {
      "version": {
        "data": {
          "type": "subscriptionVersions",
          "id": "${subscriptionVersionId}"
        }
      }
    }
  }
}
```

Repeat for each locale you support. To list the localizations attached to a version, use `GET /v1/subscriptionVersions/{id}/localizations` ([`List localizations for a subscription version`](/documentation/AppStoreConnectAPI/GET-v1-subscriptionVersions-_id_-localizations)).

### Attach a review image to the version

A subscription version can carry review images that show the promotion image customers see on the App Store product page. Reserve, upload, and commit each image in three steps.

Reserve an image with `POST /v2/subscriptionImages` ([`Create a subscription image`](/documentation/AppStoreConnectAPI/POST-v2-subscriptionImages)):

```json
{
  "data": {
    "type": "subscriptionImages",
    "attributes": {
      "fileName": "all-access-promo.png",
      "fileSize": 245670
    },
    "relationships": {
      "version": {
        "data": {
          "type": "subscriptionVersions",
          "id": "${subscriptionVersionId}"
        }
      }
    }
  }
}
```

The response returns an `id` for the image and a set of `uploadOperations` describing how to `PUT` the file bytes.

Upload the image bytes to the URL from `uploadOperations`. Then commit the upload with `PATCH /v2/subscriptionImages/{id}` ([`Modify a subscription image`](/documentation/AppStoreConnectAPI/PATCH-v2-subscriptionImages-_id_)):

```json
{
  "data": {
    "type": "subscriptionImages",
    "id": "${subscriptionImageId}",
    "attributes": {
      "uploaded": true
    }
  }
}
```

Read image metadata with `GET /v2/subscriptionImages/{id}` ([`Read subscription image information`](/documentation/AppStoreConnectAPI/GET-v2-subscriptionImages-_id_)). Remove an image with `DELETE /v2/subscriptionImages/{id}` ([`Delete a subscription image`](/documentation/AppStoreConnectAPI/DELETE-v2-subscriptionImages-_id_)).

For more on the reserve-upload-commit pattern, see [Uploading Assets to App Store Connect](/documentation/AppStoreConnectAPI/uploading-assets-to-app-store-connect).

### List all versions for a subscription

To see every version on a parent subscription, use `GET /v1/subscriptions/{id}/versions` ([`List versions for a subscription`](/documentation/AppStoreConnectAPI/GET-v1-subscriptions-_id_-versions)). The response includes each version’s state, so you can find the current draft, the most recently approved version, and any versions currently in review.

### Submit the version

Submit a completed version through the review submissions workflow. Create a review submission for the app, add the version as an item, and mark the submission as `submitted`. For step-by-step instructions, see [Submitting subscriptions and subscription groups for App Review](/documentation/AppStoreConnectAPI/submitting-subscriptions-and-subscription-groups-for-app-review).

When you mark the submission `submitted`, the version moves from `READY_FOR_REVIEW` to `WAITING_FOR_REVIEW`. Poll `GET /v1/subscriptionVersions/{id}` ([`Read subscription version information`](/documentation/AppStoreConnectAPI/GET-v1-subscriptionVersions-_id_)) to watch it continue to `IN_REVIEW` and then `APPROVED` or `REJECTED`.

---

Copyright &copy; 2026 Apple Inc. All rights reserved. | [Terms of Use](https://www.apple.com/legal/internet-services/terms/site.html) | [Privacy Policy](https://www.apple.com/privacy/privacy-policy)