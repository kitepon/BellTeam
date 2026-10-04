出典: https://developer.apple.com/documentation/swiftui/view/alert%28_%3Aispresented%3Apresenting%3Aactions%3Amessage%3A%29.md
取得日: 2026-09-30
確度: Apple公式一次資料

<!--
{
  "availability" : [
    "iOS: 16.0.0 -",
    "iPadOS: 16.0.0 -",
    "macCatalyst: 16.0.0 -",
    "macOS: 13.0.0 -",
    "tvOS: 16.0.0 -",
    "visionOS: 1.0.0 -",
    "watchOS: 9.0.0 -"
  ],
  "documentType" : "symbol",
  "framework" : "SwiftUI",
  "identifier" : "/documentation/SwiftUI/View/alert(_:isPresented:presenting:actions:message:)",
  "metadataVersion" : "0.1.0",
  "role" : "Instance Method",
  "symbol" : {
    "kind" : "Instance Method",
    "modules" : [
      "SwiftUI"
    ],
    "preciseIdentifier" : "s:7SwiftUI4ViewPAAE5alert_11isPresented10presenting7actions7messageQr10Foundation23LocalizedStringResourceV_AA7BindingVySbGqd_1_Sgqd__qd_1_XEqd_0_qd_1_XEtAaBRd__AaBRd_0_r1_lF::OverloadGroup"
  },
  "title" : "alert(_:isPresented:presenting:actions:message:)"
}
-->

# alert(_:isPresented:presenting:actions:message:)

Presents an alert with a message using the given data to produce the
alert’s content and a localized string resource for a title.

```
@export(implementation) nonisolated func alert<A, M, T>(_ titleResource: LocalizedStringResource, isPresented: Binding<Bool>, presenting data: T?, @ContentBuilder actions: (T) -> A, @ContentBuilder message: (T) -> M) -> some View where A : View, M : View
```

## Parameters

`titleResource`

Text resource for the localized string that describes
the title.

`isPresented`

A binding to a Boolean value that determines whether to
present the alert. When the user presses or taps one of the alert’s
actions, the system sets this value to `false` and dismisses.

`data`

An optional source of truth for the alert. The system passes
the contents to the modifier’s closures. You use this data to
populate the fields of an alert that you create that the system
displays to the user.

`actions`

A [`ContentBuilder`](/documentation/SwiftUI/ContentBuilder) returning the alert’s actions given the
currently available data.

`message`

A [`ContentBuilder`](/documentation/SwiftUI/ContentBuilder) returning the message for the alert given
the currently available data.

## Discussion

For the alert to appear, both `isPresented` must be `true` and
`data` must not be `nil`. The data should not change after the
presentation occurs. Any changes that you make after the presentation
occurs are ignored.

Use this method when you need to populate the fields of an alert with
content from a data source. The example below shows a custom data
source, `SaveDetails`, that provides data to populate the alert:

```
struct SaveDetails: Identifiable {
    let name: String
    let error: String
    let id = UUID()
}

struct SaveButton: View {
    @State private var didError = false
    @State private var details: SaveDetails?

    var body: some View {
        Button("Save") {
            details = model.save(didError: $didError)
        }
        .alert(
            "Save failed.",
            isPresented: $didError,
            presenting: details
        ) { details in
            Button(role: .destructive) {
                // Handle the deletion.
            } label: {
                Text("Delete \(details.name)")
            }
            Button("Retry") {
                // Handle the retry action.
            }
        } message: { details in
            Text(details.error)
        }
    }
}
```

This modifier creates a [`Text`](/documentation/SwiftUI/Text) view for the title on your behalf. See [`Text`](/documentation/SwiftUI/Text) for more
information about localizing strings.

All actions in an alert dismiss the alert after the action runs.
The default button is shown with greater prominence. You can
influence the default button by assigning it the
[`defaultAction`](/documentation/SwiftUI/KeyboardShortcut/defaultAction) keyboard shortcut.

The system may reorder the buttons based on their role and prominence.

If no actions are present, the system includes a standard “OK”
action. No default cancel action is provided. If you want to show a
cancel action, use a button with a role of [`cancel`](/documentation/SwiftUI/ButtonRole/cancel).

On iOS, tvOS, and watchOS, alerts only support controls with labels that
are [`Text`](/documentation/SwiftUI/Text). Passing any other type of view results in the content
being omitted.

Only unstyled text is supported for the message.

---

Copyright &copy; 2026 Apple Inc. All rights reserved. | [Terms of Use](https://www.apple.com/legal/internet-services/terms/site.html) | [Privacy Policy](https://www.apple.com/privacy/privacy-policy)