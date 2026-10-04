出典: https://developer.apple.com/documentation/bundleresources/information-property-list/uiapplicationscenemanifest/uiapplicationsupportsmultiplescenes
取得日: 2026-09-27
確度: Apple公式仕様の原文

<!--
{
  "availability" : [
    "iOS: 13.0.0 -",
    "iPadOS: 13.0.0 -",
    "macCatalyst: 13.0.0 -",
    "visionOS: 1.0.0 -"
  ],
  "documentType" : "symbol",
  "framework" : "BundleResources",
  "identifier" : "/documentation/BundleResources/Information-Property-List/UIApplicationSceneManifest/UIApplicationSupportsMultipleScenes",
  "metadataVersion" : "0.1.0",
  "role" : "Property List Key",
  "symbol" : {
    "kind" : "Property List Key",
    "modules" : [
      "Bundle Resources"
    ],
    "preciseIdentifier" : "plist:Information_Property_List.UIApplicationSceneManifest.UIApplicationSupportsMultipleScenes"
  },
  "title" : "UIApplicationSupportsMultipleScenes"
}
-->

# UIApplicationSupportsMultipleScenes

A Boolean value indicating whether the app supports two or more scenes simultaneously.

## Discussion

If your app supports multiple scenes, set the value of this key to <doc://com.apple.documentation/documentation/Swift/true>. If you set the value to <doc://com.apple.documentation/documentation/Swift/false>, UIKit never creates more than one scene for your app.

Setting this key to <doc://com.apple.documentation/documentation/Swift/true> has implications for your code. An app that supports multiple scenes must coordinate operations to prevent scenes from interfering with each other. For example, if two scenes access the same shared resource, you must synchronize access to that resource using a serial dispatch queue or some other mechanism. Failure to do so may lead to corrupted data or  unexpected behavior from your app.

---

Copyright &copy; 2026 Apple Inc. All rights reserved. | [Terms of Use](https://www.apple.com/legal/internet-services/terms/site.html) | [Privacy Policy](https://www.apple.com/privacy/privacy-policy)
