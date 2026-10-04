import XCTest
@testable import BellBot

final class RoomDeletionTests: XCTestCase {
    @MainActor
    func testDeletionClearsOnlyTheDeletedRoomsNavigationAndDraft() {
        let previousOpen = BellNotifications.shared.onOpen
        defer { BellNotifications.shared.onOpen = previousOpen }
        let store = AppStore()
        store.preparePreview()
        store.chatPath = [.room("planning")]
        let deletedDraft = store.draft(for: .room("planning"))
        deletedDraft.text = "削除対象"
        store.draft(for: .room("ideas")).text = "残す部屋"
        store.draft(for: .bot("bot-one")).text = "残すBot"

        store.applyDeletedRoom("planning")

        XCTAssertEqual(store.rooms.map(\.id), ["ideas"])
        XCTAssertTrue(store.chatPath.isEmpty)
        XCTAssertEqual(deletedDraft.text, "")
        XCTAssertFalse(deletedDraft === store.draft(for: .room("planning")))
        XCTAssertEqual(store.draft(for: .room("ideas")).text, "残す部屋")
        XCTAssertEqual(store.draft(for: .bot("bot-one")).text, "残すBot")
        XCTAssertEqual(store.bots.map(\.id), ["bot-one", "bot-two", "bot-three"])
    }

    @MainActor
    func testFailedDeletionKeepsTheRoomConversationAndDraft() async {
        let previousOpen = BellNotifications.shared.onOpen
        defer { BellNotifications.shared.onOpen = previousOpen }
        let store = AppStore()
        store.preparePreview()
        store.chatPath = [.room("planning")]
        store.draft(for: .room("planning")).text = "残す本文"
        do {
            try await store.deleteRoom("planning")
            XCTFail("未接続の削除を成功にしてはいけません。")
        } catch BellAPIError.notConfigured {}
        catch { XCTFail("期待しないエラー: \(error)") }

        XCTAssertEqual(store.rooms.map(\.id), ["planning", "ideas"])
        XCTAssertEqual(store.chatPath, [.room("planning")])
        XCTAssertEqual(store.draft(for: .room("planning")).text, "残す本文")
    }
}
