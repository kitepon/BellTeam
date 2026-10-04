出典: https://developer.apple.com/documentation/appstoreconnectapi/submitting-subscriptions-and-subscription-groups-for-app-review.md
取得日: 2026-10-04
確度: Apple公式一次資料の原文

<!--
{
  "documentType" : "article",
  "framework" : "AppStoreConnectAPI",
  "identifier" : "/documentation/AppStoreConnectAPI/submitting-subscriptions-and-subscription-groups-for-app-review",
  "metadataVersion" : "0.1.0",
  "role" : "article",
  "title" : "Submitting subscriptions and subscription groups for App Review"
}
-->

# Submitting subscriptions and subscription groups for App Review

Attach localizations and screenshots to a subscription version, then submit subscriptions and subscription groups for App Review.

## Discussion

After you create and configure an auto-renewable subscription, submit it to App Review for approval before it can be available to people. Localizations and images for a subscription attach to a *subscription version* — a draft container for the metadata that goes through App Review together — so you submit the version, not the subscription itself.

### Prepare a subscription version

Localizations and images for a subscription live on a subscription version. Create the version before you attach any metadata. The pre-4.4.1 workflows that post localizations and images directly to the subscription are deprecated as of 4.4.1 but remain available for existing integrations.

Create a draft version with `POST /v1/subscriptionVersions` ([`Create a subscription version`](/documentation/AppStoreConnectAPI/POST-v1-subscriptionVersions)):

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

Attach localizations to the version with `POST /v2/subscriptionLocalizations` ([`Create a subscription localization`](/documentation/AppStoreConnectAPI/POST-v2-subscriptionLocalizations)) and attach images with `POST /v2/subscriptionImages` ([`Create a subscription image`](/documentation/AppStoreConnectAPI/POST-v2-subscriptionImages)). Both payloads relate the resource to the *version* — not the parent subscription.

### Upload a subscription App Review screenshot

Upload a screenshot that shows what the subscription looks like to people. This workflow uses the `/v1/subscriptionAppStoreReviewScreenshots` endpoint and is similar to the existing image workflows for App Clip images and app screenshots.

Submit a single image using these steps:

1. Make an image reservation with `POST /v1/subscriptionAppStoreReviewScreenshots` ([`Create a review screenshot for an auto-renewable subscription`](/documentation/AppStoreConnectAPI/POST-v1-subscriptionAppStoreReviewScreenshots)).
2. Upload the image using the `PUT` URL provided in the response to the previous `POST`.
3. After your image uploads, use `PATCH /v1/subscriptionAppStoreReviewScreenshots/{id}` ([`Commit a review screenshot for an auto-renewable subscription`](/documentation/AppStoreConnectAPI/PATCH-v1-subscriptionAppStoreReviewScreenshots-_id_)) to commit the image.
4. Finally, use `GET /v1/subscriptionAppStoreReviewScreenshots/{id}` ([`Read subscription review screenshot information`](/documentation/AppStoreConnectAPI/GET-v1-subscriptionAppStoreReviewScreenshots-_id_)) to confirm that the image is in place.

For more information, see [Uploading Assets to App Store Connect](/documentation/AppStoreConnectAPI/uploading-assets-to-app-store-connect).

### Submit a subscription version

Submit a subscription version using the review submissions workflow. This is the current, non-deprecated submission path.

> Important:
> Submit your first subscription together with an app binary submission through [appstoreconnect.apple.com](https://appstoreconnect.apple.com). For subsequent subscriptions, submit using the API endpoints below without an associated app binary submission.

Create a review submission for the app with `POST /v1/reviewSubmissions` ([`Create a Review Submission`](/documentation/AppStoreConnectAPI/POST-v1-reviewSubmissions)):

```json
{
  "data": {
    "type": "reviewSubmissions",
    "attributes": {
      "platform": "IOS"
    },
    "relationships": {
      "app": {
        "data": {
          "type": "apps",
          "id": "6446148572"
        }
      }
    }
  }
}
```

Add the subscription version as an item on that review submission with `POST /v1/reviewSubmissionItems` ([`Create a Review Submission Item`](/documentation/AppStoreConnectAPI/POST-v1-reviewSubmissionItems)):

```json
{
  "data": {
    "type": "reviewSubmissionItems",
    "relationships": {
      "reviewSubmission": {
        "data": {
          "type": "reviewSubmissions",
          "id": "${reviewSubmissionId}"
        }
      },
      "subscriptionVersion": {
        "data": {
          "type": "subscriptionVersions",
          "id": "${subscriptionVersionId}"
        }
      }
    }
  }
}
```

Submit the review submission by patching its `submitted` attribute to `true` with `PATCH /v1/reviewSubmissions/{id}` ([`Modify a Review Submission`](/documentation/AppStoreConnectAPI/PATCH-v1-reviewSubmissions-_id_)):

```json
{
  "data": {
    "type": "reviewSubmissions",
    "id": "${reviewSubmissionId}",
    "attributes": {
      "submitted": true
    }
  }
}
```

The version’s state transitions from `PREPARE_FOR_SUBMISSION` to `READY_FOR_REVIEW` when you add it to a review submission, then to `WAITING_FOR_REVIEW` after you mark the submission `submitted`, then `IN_REVIEW`, and finally to `APPROVED` or `REJECTED`. Poll `GET /v1/subscriptionVersions/{id}` ([`Read subscription version information`](/documentation/AppStoreConnectAPI/GET-v1-subscriptionVersions-_id_)) to check the current state.

The `POST /v1/subscriptionSubmissions` ([`Create a review submission for a subscription`](/documentation/AppStoreConnectAPI/POST-v1-subscriptionSubmissions)) endpoint is deprecated as of 4.4.1. Existing integrations that submit a subscription directly by its `id` continue to work, but new integrations use the review submissions workflow described above.

### Submit a subscription group version

Localized metadata for a subscription group submits to App Review when a subscription within the group submits. Submit a subscription group version independently when you change group-level localization without changing any subscription in the group.

Create a subscription group version with `POST /v1/subscriptionGroupVersions` ([`Create a subscription group version`](/documentation/AppStoreConnectAPI/POST-v1-subscriptionGroupVersions)), attach localizations with `POST /v2/subscriptionGroupLocalizations` ([`Create a subscription group localization`](/documentation/AppStoreConnectAPI/POST-v2-subscriptionGroupLocalizations)), then submit the version using the same review submissions workflow as above — with the subscription group version as the review submission item:

```json
{
  "data": {
    "type": "reviewSubmissionItems",
    "relationships": {
      "reviewSubmission": {
        "data": {
          "type": "reviewSubmissions",
          "id": "${reviewSubmissionId}"
        }
      },
      "subscriptionGroupVersion": {
        "data": {
          "type": "subscriptionGroupVersions",
          "id": "${subscriptionGroupVersionId}"
        }
      }
    }
  }
}
```

The `POST /v1/subscriptionGroupSubmissions` ([`Create a review submission for a subscription group`](/documentation/AppStoreConnectAPI/POST-v1-subscriptionGroupSubmissions)) endpoint is deprecated as of 4.4.1. Existing integrations that submit a subscription group directly by its `id` continue to work, but new integrations use the review submissions workflow described above.

---

Copyright &copy; 2026 Apple Inc. All rights reserved. | [Terms of Use](https://www.apple.com/legal/internet-services/terms/site.html) | [Privacy Policy](https://www.apple.com/privacy/privacy-policy)