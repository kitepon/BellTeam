import XCTest
@testable import BellBot

/// 実サーバーへ接続し、知らせが無い間もSSEが切れないことを確かめる。BELLTEAM_LIVE_URL を指定した時だけ動く。
final class EventStreamLiveTests: XCTestCase {
    func testEventsStayOpenPastRequestTimeout() async throws {
        guard let value = ProcessInfo.processInfo.environment["BELLTEAM_LIVE_URL"], let url = URL(string: value) else {
            throw XCTSkip("BELLTEAM_LIVE_URL が未指定")
        }
        let seconds = Double(ProcessInfo.processInfo.environment["BELLTEAM_LIVE_SECONDS"] ?? "330") ?? 330
        let api = BellAPI(baseURL: url)
        let task = Task { try await api.events { _ in } }
        try await Task.sleep(for: .seconds(seconds))
        XCTAssertFalse(task.isCancelled)
        task.cancel()
        do { try await task.value; XCTFail("接続が正常終了した（切断）") }
        catch is CancellationError {}
        catch let error as URLError where error.code == .cancelled {}
    }
}
