# SwiftUIの写真選択の表示制御

出典: [Apple Developer Documentation](https://developer.apple.com/documentation/swiftui/view/photospicker%28ispresented%3Aselection%3Amatching%3Apreferreditemencoding%3A%29)
取得日: 2026-10-29
確度: Apple公式API資料

原文のAPI名: `photosPicker(isPresented:selection:matching:preferredItemEncoding:)`

原文抜粋: “Presents a Photos picker that selects a PhotosPickerItem.”

```swift
func photosPicker(
    isPresented: Binding<Bool>,
    selection: Binding<PhotosPickerItem?>,
    matching filter: PHPickerFilter? = nil,
    preferredItemEncoding: PhotosPickerItem.EncodingDisambiguationPolicy = .automatic
) -> some View
```
