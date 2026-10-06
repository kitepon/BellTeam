import UIKit
import XCTest
@testable import BellBot

@MainActor
final class BackgroundMessageSendTests: XCTestCase {
    func testNativeExecutionTimeCanComplete() async throws {
        let value = try await BackgroundMessageSend().run { "OSの実行時間を取得" }
        XCTAssertEqual(value, "OSの実行時間を取得")
    }

    func testCompletedSendEndsExecutionTimeExactlyOnce() async throws {
        let boundary = ExecutionTime()
        let value = try await boundary.send.run { "応答を受信" }
        XCTAssertEqual(value, "応答を受信")
        XCTAssertEqual(boundary.ended, [boundary.identifier])
    }

    func testFailedSendPreservesErrorAndEndsExecutionTime() async {
        let boundary = ExecutionTime()
        do {
            try await boundary.send.run { throw URLError(.networkConnectionLost) }
            XCTFail("通信失敗は成功にしない")
        } catch let error as URLError {
            XCTAssertEqual(error.code, .networkConnectionLost)
        } catch { XCTFail("元の通信エラーを保持する: \(error)") }
        XCTAssertEqual(boundary.ended, [boundary.identifier])
    }

    func testExpirationCancelsPendingSendAndEndsImmediately() async {
        let boundary = ExecutionTime()
        let started = expectation(description: "応答待ちを開始")
        let send = Task {
            try await boundary.send.run {
                started.fulfill()
                try await Task.sleep(for: .seconds(60))
            }
        }
        await fulfillment(of: [started], timeout: 2)
        boundary.expire?()
        XCTAssertEqual(boundary.ended, [boundary.identifier], "OSの期限終了通知内で終了する")
        do {
            try await send.value
            XCTFail("期限終了を成功にしない")
        } catch BellAPIError.backgroundSendExpired {} catch { XCTFail("期限終了を明示する: \(error)") }
        XCTAssertEqual(boundary.ended, [boundary.identifier], "取消完了後に二重終了しない")
    }

    func testDeniedExecutionTimeDoesNotStartHTTP() async {
        let boundary = ExecutionTime(identifier: .invalid)
        var started = false
        do {
            try await boundary.send.run { started = true }
            XCTFail("OSに断られたら送信を始めない")
        } catch BellAPIError.backgroundSendUnavailable {} catch { XCTFail("実行時間を取れないことを明示する: \(error)") }
        await Task.yield()
        XCTAssertFalse(started)
        XCTAssertTrue(boundary.ended.isEmpty)
    }

    func testCallerCancellationCancelsSendAndEndsExecutionTime() async {
        let boundary = ExecutionTime()
        let started = expectation(description: "取消対象の送信を開始")
        let send = Task {
            try await boundary.send.run {
                started.fulfill()
                try await Task.sleep(for: .seconds(60))
            }
        }
        await fulfillment(of: [started], timeout: 2)
        send.cancel()
        do { try await send.value; XCTFail("取消を成功にしない") }
        catch is CancellationError {} catch { XCTFail("呼出元の取消を保持する: \(error)") }
        XCTAssertEqual(boundary.ended, [boundary.identifier])
    }

    @MainActor
    private final class ExecutionTime {
        let identifier: UIBackgroundTaskIdentifier
        var expire: (@MainActor @Sendable () -> Void)?
        var ended: [UIBackgroundTaskIdentifier] = []
        lazy var send = BackgroundMessageSend(begin: { [unowned self] handler in
            expire = handler
            return identifier
        }, end: { [unowned self] value in ended.append(value) })

        init(identifier: UIBackgroundTaskIdentifier = UIBackgroundTaskIdentifier(rawValue: 1)) {
            self.identifier = identifier
        }
    }
}
