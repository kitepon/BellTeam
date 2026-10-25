import Combine
import Foundation

@MainActor
final class ConversationDraft: ObservableObject {
    // UIKit owns character-by-character edits. Publish only when the input's
    // visible state changes; external clears/restores still publish revision.
    private var storedText = ""
    var text: String {
        get { storedText }
        set { setTextExternally(newValue) }
    }
    private var emptyState = true
    private var textState = false
    var isEmpty: Bool { emptyState }
    var hasText: Bool { textState }
    @Published private(set) var textRevision = 0
    var attachments: [PendingImage] = []
    var selectedTargets: Set<String> = []

    func setTextFromInput(_ value: String) {
        updateText(value, publishRevision: false)
    }

    func setTextExternally(_ value: String) {
        updateText(value, publishRevision: true)
    }

    func clear() {
        setTextExternally("")
        attachments = []
        selectedTargets = []
    }

    private func updateText(_ value: String, publishRevision: Bool) {
        if publishRevision, storedText == value { return }
        storedText = value
        let nextIsEmpty = value.isEmpty
        let nextHasText = value.unicodeScalars.contains {
            !CharacterSet.whitespacesAndNewlines.contains($0)
        }
        let visibleStateChanged = emptyState != nextIsEmpty || textState != nextHasText
        emptyState = nextIsEmpty
        textState = nextHasText
        if publishRevision || visibleStateChanged { textRevision += 1 }
    }
}
