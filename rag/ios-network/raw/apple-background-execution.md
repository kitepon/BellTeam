<!-- 出典: https://developer.apple.com/documentation/uikit/extending-your-app-s-background-execution-time.md | 取得日: 2026-10-06 | 確度: Apple公式原文 -->
<!--
{
  "documentType" : "article",
  "framework" : "UIKit",
  "identifier" : "/documentation/UIKit/extending-your-app-s-background-execution-time",
  "metadataVersion" : "0.1.0",
  "role" : "article",
  "title" : "Extending your app’s background execution time"
}
-->

# Extending your app’s background execution time

Ensure that critical tasks finish when your app moves to the background.

## Discussion

Extending your app’s background execution time ensures that you have adequate time to perform critical tasks. For tasks that require more background time, use <doc://com.apple.documentation/documentation/BackgroundTasks>.

When your app moves to the background, the system calls your app delegate’s [`applicationDidEnterBackground(_:)`](/documentation/UIKit/UIApplicationDelegate/applicationDidEnterBackground(_:)) method. That method has five seconds to perform any tasks and return. Shortly after that method returns, the system puts your app into the suspended state. For most apps, five seconds is enough to perform any crucial tasks, but if you need more time, you can ask UIKit to extend your app’s runtime.

You extend your app’s runtime by calling the [`beginBackgroundTask(withName:expirationHandler:)`](/documentation/UIKit/UIApplication/beginBackgroundTask(withName:expirationHandler:)) method. Calling this method gives you extra time to perform important tasks. (You can find out the maximum background time available using the [`backgroundTimeRemaining`](/documentation/UIKit/UIApplication/backgroundTimeRemaining) property.) When you finish your tasks, call the [`endBackgroundTask(_:)`](/documentation/UIKit/UIApplication/endBackgroundTask(_:)) method right away to let the system know that you’re done. If you don’t end your tasks in a timely manner, the system terminates your app.

> Note:
> Don’t wait until your app moves to the background to call the ``doc://com.apple.uikit/documentation/UIKit/UIApplication/beginBackgroundTask(withName:expirationHandler:)`` method. Call the method before performing any long-running task.

The following code shows an example that configures a background task so that the app may save data to its server, which could take longer than five seconds. The [`beginBackgroundTask(withName:expirationHandler:)`](/documentation/UIKit/UIApplication/beginBackgroundTask(withName:expirationHandler:)) method returns an identifier that you must save and pass to the [`endBackgroundTask(_:)`](/documentation/UIKit/UIApplication/endBackgroundTask(_:)) method.

```swift
func sendDataToServer(data: NSData) {
   // Perform the task on a background queue.
   DispatchQueue.global().async {
      // Request the task assertion and save the ID.
      self.backgroundTaskID = UIApplication.shared.
                 beginBackgroundTask(withName: "Finish Network Tasks") {
         // End the task if time expires.
         UIApplication.shared.endBackgroundTask(self.backgroundTaskID!)
         self.backgroundTaskID = UIBackgroundTaskInvalid
      }
            
      // Send the data synchronously.
      self.sendAppDataToServer(data: data)
            
      // End the task assertion.
      UIApplication.shared.endBackgroundTask(self.backgroundTaskID!)
      self.backgroundTaskID = UIBackgroundTaskInvalid
   }
}
```

> Note:
> The ``doc://com.apple.uikit/documentation/UIKit/UIApplication/beginBackgroundTask(withName:expirationHandler:)`` method can’t be called from an app extension. To request extra execution time from your app extension, call the <doc://com.apple.documentation/documentation/Foundation/ProcessInfo/performExpiringActivity(withReason:using:)> method of <doc://com.apple.documentation/documentation/Foundation/ProcessInfo> instead.

---

Copyright &copy; 2026 Apple Inc. All rights reserved. | [Terms of Use](https://www.apple.com/legal/internet-services/terms/site.html) | [Privacy Policy](https://www.apple.com/privacy/privacy-policy)