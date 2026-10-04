import Combine
import Foundation

@MainActor
final class ConversationDraft: ObservableObject {
    @Published var text = ""
    var attachments: [PendingImage] = []
    var selectedTargets: Set<String> = []

    func clear() {
        text = ""
        attachments = []
        selectedTargets = []
    }

    var hasText: Bool { !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
}
