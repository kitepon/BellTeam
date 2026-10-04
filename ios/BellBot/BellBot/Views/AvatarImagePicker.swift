import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

struct AvatarImagePicker<Label: View>: View {
    let onSelect: (UIImage) -> Void
    let onFailure: () -> Void
    @ViewBuilder let label: () -> Label

    #if targetEnvironment(macCatalyst)
    @State private var importing = false
    #else
    @State private var selectedPhoto: PhotosPickerItem?
    #endif

    var body: some View {
        #if targetEnvironment(macCatalyst)
        Button { importing = true } label: { label() }
            .fileImporter(isPresented: $importing, allowedContentTypes: [.image]) { result in
                do {
                    onSelect(try AvatarImage.load(from: result.get()))
                } catch { onFailure() }
            }
        #else
        PhotosPicker(selection: $selectedPhoto, matching: .images, label: label)
            .onChange(of: selectedPhoto) { _, item in
                Task { await loadPhoto(item) }
            }
        #endif
    }

    #if !targetEnvironment(macCatalyst)
    private func loadPhoto(_ item: PhotosPickerItem?) async {
        guard let item else { return }
        defer { selectedPhoto = nil }
        do {
            guard let data = try await item.loadTransferable(type: Data.self) else {
                throw BellAPIError.invalidResponse
            }
            onSelect(try AvatarImage.decode(data))
        } catch { onFailure() }
    }
    #endif
}
