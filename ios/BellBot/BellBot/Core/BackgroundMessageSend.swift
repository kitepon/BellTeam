import UIKit

/// 送信の応答を受け取る間だけ、OSへ背景での実行時間を要求する。
@MainActor
final class BackgroundMessageSend {
    private let begin: (@escaping @MainActor @Sendable () -> Void) -> UIBackgroundTaskIdentifier
    private let end: (UIBackgroundTaskIdentifier) -> Void
    private var identifier = UIBackgroundTaskIdentifier.invalid
    private var expired = false

    convenience init() {
        self.init(begin: { expire in
            UIApplication.shared.beginBackgroundTask(withName: "BellTeamのメッセージ送信") {
                // UIKitの期限終了通知はメインスレッドで届く。
                MainActor.assumeIsolated { expire() }
            }
        }, end: { UIApplication.shared.endBackgroundTask($0) })
    }

    init(begin: @escaping (@escaping @MainActor @Sendable () -> Void) -> UIBackgroundTaskIdentifier,
         end: @escaping (UIBackgroundTaskIdentifier) -> Void) {
        self.begin = begin
        self.end = end
    }

    func run<Value>(_ operation: @escaping @MainActor () async throws -> Value) async throws -> Value {
        let task = Task {
            try Task.checkCancellation()
            return try await operation()
        }
        identifier = begin { [weak self] in
            guard let self else { return }
            expired = true
            task.cancel()
            finish()
        }
        guard identifier != .invalid else {
            task.cancel()
            throw BellAPIError.backgroundSendUnavailable
        }
        defer { finish() }
        do {
            return try await withTaskCancellationHandler {
                try await task.value
            } onCancel: {
                task.cancel()
            }
        } catch {
            if expired { throw BellAPIError.backgroundSendExpired }
            throw error
        }
    }

    private func finish() {
        guard identifier != .invalid else { return }
        let completed = identifier
        identifier = .invalid
        end(completed)
    }
}
