出典: https://developer.apple.com/documentation/foundation/urlsession/flush(completionhandler:).md
取得日: 2026-10-04
確度: Apple公式一次資料の原文

<!--
{
  "availability" : [
    "iOS: 7.0.0 -",
    "iPadOS: 7.0.0 -",
    "macCatalyst: 13.1.0 -",
    "macOS: 10.9.0 -",
    "tvOS: 9.0.0 -",
    "visionOS: 1.0.0 -",
    "watchOS: 2.0.0 -"
  ],
  "documentType" : "symbol",
  "framework" : "Foundation",
  "identifier" : "/documentation/Foundation/URLSession/flush(completionHandler:)",
  "metadataVersion" : "0.1.0",
  "role" : "Instance Method",
  "symbol" : {
    "kind" : "Instance Method",
    "modules" : [
      "Foundation"
    ],
    "preciseIdentifier" : "c:objc(cs)NSURLSession(im)flushWithCompletionHandler:"
  },
  "title" : "flush(completionHandler:)"
}
-->

# flush(completionHandler:)

Flushes cookies and credentials to disk, clears transient caches, and ensures that future requests occur on a new TCP connection.

```
func flush(completionHandler: @escaping @Sendable () -> Void)
```

```
func flush() async
```

## Parameters

`completionHandler`

The completion handler to call when the flush operation is complete. This handler is executed on the delegate queue.

---

Copyright &copy; 2026 Apple Inc. All rights reserved. | [Terms of Use](https://www.apple.com/legal/internet-services/terms/site.html) | [Privacy Policy](https://www.apple.com/privacy/privacy-policy)