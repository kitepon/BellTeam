import Foundation

// サーバーの履歴を正本とし、受付前の本人発言だけを画面内で重ねる。
struct ConversationTimelineState {
    private(set) var receivedMessages: [TimelineMessage] = []
    private var pendingSends: [PendingSend] = []

    var visibleMessages: [TimelineMessage] {
        guard !pendingSends.isEmpty else { return receivedMessages }
        let receivedIDs = Set(receivedMessages.map(\.id))
        return receivedMessages + pendingSends.filter { pending in
            guard let acceptedID = pending.acceptedID else { return true }
            return !receivedIDs.contains(acceptedID)
        }.map(\.message)
    }

    mutating func replaceReceived(_ items: [TimelineMessage]) {
        if receivedMessages != items { receivedMessages = items }
        reconcileAcceptedSends()
    }

    mutating func appendReceived(_ item: TimelineMessage) {
        receivedMessages.append(item)
        reconcileAcceptedSends()
    }

    mutating func prependReceived(_ items: [TimelineMessage]) -> [TimelineMessage] {
        let known = Set(receivedMessages.map(\.id))
        let older = items.filter { !known.contains($0.id) }
        if !older.isEmpty { receivedMessages = older + receivedMessages }
        reconcileAcceptedSends()
        return older
    }

    // 既知行の配送状態を最新ページから更新し、cursor以降だけを末尾へ加える。
    mutating func mergeRefresh(latest: [TimelineMessage], after: [TimelineMessage]) -> Int {
        let known = Set(receivedMessages.map(\.id))
        let additions = after.filter { !known.contains($0.id) }
        let indices = Dictionary(uniqueKeysWithValues: receivedMessages.enumerated().map { ($0.element.id, $0.offset) })
        var updated = receivedMessages
        var changed = !additions.isEmpty
        for item in latest {
            if let index = indices[item.id], updated[index] != item {
                updated[index] = item
                changed = true
            }
        }
        if changed {
            updated.append(contentsOf: additions)
            receivedMessages = updated
        }
        reconcileAcceptedSends()
        return additions.count
    }

    /// 開き直した時に届く最初の頁。持っている行と重なれば、頁の行で既知を直し、既知の最後より後の行だけ足して true を返す（持っている行は消さない）。
    /// 一つも重ならなければ（出ている間に頁の大きさより多く進んだ）何もせず false を返す。
    mutating func mergeLatestPage(_ items: [TimelineMessage]) -> Bool {
        let known = Set(receivedMessages.map(\.id))
        guard let lastKnown = items.lastIndex(where: { known.contains($0.id) }) else { return false }
        _ = mergeRefresh(latest: items, after: Array(items[(lastKnown + 1)...]))
        return true
    }

    mutating func beginSend(id: String, body: String, imageCount: Int, at: String, replyTo: ReplyReference? = nil) {
        pendingSends.append(PendingSend(id: id, body: body, imageCount: imageCount, at: at, replyTo: replyTo, acceptedID: nil))
    }

    mutating func acceptSend(id: String, serverID: String) {
        if let index = pendingSends.firstIndex(where: { $0.id == id }) {
            pendingSends[index].acceptedID = serverID
        }
        reconcileAcceptedSends()
    }

    mutating func rejectSend(id: String) {
        pendingSends.removeAll { $0.id == id }
    }

    private mutating func reconcileAcceptedSends() {
        let receivedIDs = Set(receivedMessages.map(\.id))
        pendingSends.removeAll { pending in
            pending.acceptedID.map(receivedIDs.contains) ?? false
        }
    }
}

private struct PendingSend {
    let id: String
    let body: String
    let imageCount: Int
    let at: String
    let replyTo: ReplyReference?
    var acceptedID: String?

    var message: TimelineMessage {
        TimelineMessage(id: id, kind: "message", direction: "outgoing", sender: nil, targets: nil,
                        at: at, message: body, image: imageCount > 0,
                        imageCount: imageCount > 0 ? imageCount : nil, imageUrl: nil, imageUrls: nil,
                        delivery: acceptedID == nil ? "submitting" : "accepted", deliveries: nil,
                        routing: nil, peerName: nil, peerPosition: nil, secretRequest: nil, ownerQuestion: nil,
                        replyTo: replyTo)
    }
}
