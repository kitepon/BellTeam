import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

struct AvatarImagePicker<Label: View>: View {
    let onSelect: (UIImage) -> Void
    let onFailure: () -> Void
    let prepare: (() async -> Bool)?
    let label: () -> Label

    init(onSelect: @escaping (UIImage) -> Void, onFailure: @escaping () -> Void,
         prepare: (() async -> Bool)? = nil, @ViewBuilder label: @escaping () -> Label) {
        self.onSelect = onSelect
        self.onFailure = onFailure
        self.prepare = prepare
        self.label = label
    }

    @State private var presenting = false
    #if !targetEnvironment(macCatalyst)
    @State private var selectedPhoto: PhotosPickerItem?
    #endif

    var body: some View {
        #if targetEnvironment(macCatalyst)
        Button(action: requestSelection, label: label)
            .fileImporter(isPresented: $presenting, allowedContentTypes: [.image]) { result in
                do {
                    onSelect(try AvatarImage.load(from: result.get()))
                } catch { onFailure() }
            }
        #else
        Group {
            if prepare != nil {
                Button(action: requestSelection, label: label)
                    .photosPicker(isPresented: $presenting, selection: $selectedPhoto, matching: .images)
            } else {
                PhotosPicker(selection: $selectedPhoto, matching: .images, label: label)
            }
        }
        .onChange(of: selectedPhoto) { _, item in
            Task { await loadPhoto(item) }
        }
        #endif
    }

    private func requestSelection() {
        if let prepare {
            Task { if await prepare() { presenting = true } }
        } else {
            presenting = true
        }
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
