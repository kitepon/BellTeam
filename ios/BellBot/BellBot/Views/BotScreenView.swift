import SwiftUI
import UIKit

private struct ScreenResponse: Decodable {
    let online: Bool
    let screen: String
}

private struct BotTerminalView: UIViewRepresentable {
    let value: String

    func makeUIView(context: Context) -> BotTerminalTextView {
        let view = BotTerminalTextView()
        view.backgroundColor = .black
        view.textColor = .white
        view.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        view.isEditable = false
        view.isSelectable = true
        view.isScrollEnabled = true
        view.alwaysBounceVertical = true
        view.textContainerInset = UIEdgeInsets(top: 16, left: 16, bottom: 16, right: 16)
        view.textContainer.lineFragmentPadding = 0
        view.accessibilityIdentifier = "bot-screen-text"
        return view
    }

    func updateUIView(_ view: BotTerminalTextView, context: Context) {
        view.show(value)
    }
}

final class BotTerminalTextView: UITextView {
    func show(_ value: String) {
        guard text != value else { return }
        let oldOffset = contentOffset
        let followBottom = contentSize.height <= bounds.height
            || oldOffset.y + bounds.height >= contentSize.height - 28
        text = value
        layoutManager.ensureLayout(for: textContainer)
        layoutIfNeeded()
        let bottom = max(-adjustedContentInset.top,
                         contentSize.height - bounds.height + adjustedContentInset.bottom)
        setContentOffset(CGPoint(x: oldOffset.x, y: followBottom ? bottom : min(oldOffset.y, bottom)), animated: false)
    }
}

/// 画面を開いた時の全履歴と、その後に毎秒取る画面末尾をつなぐ。
/// shortcut: 最初の全履歴と最初の末尾の間に端末が流れると、つなぎ目で数行が重なるか抜ける。画面を開き直すと全履歴から取り直す。
struct ScreenScrollback {
    private var history: [Substring] = []
    private var prefix: String?

    mutating func start(_ full: String) {
        history = full.split(separator: "\n", omittingEmptySubsequences: false)
        prefix = nil
    }

    mutating func merge(tail: String) -> String {
        if prefix == nil {
            let tailLines = tail.split(separator: "\n", omittingEmptySubsequences: false).count
            prefix = history.dropLast(min(tailLines, history.count)).joined(separator: "\n")
        }
        guard let prefix, !prefix.isEmpty else { return tail }
        return prefix + "\n" + tail
    }
}

struct BotScreenView: View {
    let bot: Bot
    var embedded = false
    @EnvironmentObject private var store: AppStore
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dismiss) private var dismiss
    @State private var screen = ""
    @State private var online = false
    @State private var errorText: String?
    @State private var visibleBotID: String?

    var body: some View {
        Group {
            if embedded {
                screenContent
            } else {
                NavigationStack {
                    screenContent
                        .navigationTitle("\(bot.displayName)の画面")
                        .navigationBarTitleDisplayMode(.inline)
                        .toolbar { ToolbarItem(placement: .topBarTrailing) {
                            Button("閉じる") { dismiss() }
                                .accessibilityIdentifier("close-bot-screen")
                        } }
                }
            }
        }
        .task(id: "\(bot.id):\(scenePhase == .active)") {
            if visibleBotID != bot.id {
                visibleBotID = bot.id
                screen = ""
                online = false
                errorText = nil
            }
            guard scenePhase == .active else { return }
            await refreshScreen(botID: bot.id)
        }
    }

    private var screenContent: some View {
        ZStack {
            Color.black
            BotTerminalView(value: screen.isEmpty ? (online ? "画面は空です" : "次のメッセージで起動します") : screen)
            .background(Color.black)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .safeAreaInset(edge: .bottom) {
            HStack(spacing: 7) {
                Circle().fill(online ? BellTheme.mint : BellTheme.muted).frame(width: 7, height: 7)
                Text(errorText ?? (online ? "1秒ごとに更新" : "停止中"))
            }
            .font(.footnote)
            .foregroundStyle(errorText == nil ? .white : .red)
            .frame(maxWidth: .infinity)
            .padding(10)
            .background(Color.black)
        }
    }

    private func refreshScreen(botID: String) async {
        let path = "/api/bots/\(botID)/screen"
        // 全履歴（最大1万行）は開いた最初の1回だけ取り、以後は画面末尾だけを毎秒取ってつなぐ。
        var scrollback = ScreenScrollback()
        var loadedHistory = false
        while !Task.isCancelled {
            let started = ContinuousClock.now
            do {
                let result: ScreenResponse = try await store.api.get(loadedHistory ? path : path + "?history=1")
                try Task.checkCancellation()
                let next: String
                if loadedHistory { next = scrollback.merge(tail: result.screen) }
                else { scrollback.start(result.screen); next = result.screen; loadedHistory = true }
                if online != result.online { online = result.online }
                if screen != next { screen = next }
                if errorText != nil { errorText = nil }
            } catch is CancellationError { return }
            catch let error as URLError where error.code == .cancelled { return }
            catch let error where BellAPIError.isAuthenticationError(error) {
                store.requireLogin(for: error)
                break
            } catch {
                errorText = error.localizedDescription
                store.api.diagnostics.report(error, path: path, method: "GET", observation: .read(error, retainedData: !screen.isEmpty))
                break
            }
            // 取得は重ねず、前の取得の開始から1秒たったら次を始める。遅い応答の後は待たずに続ける。
            do { try await Task.sleep(until: started + .seconds(1), clock: .continuous) }
            catch { return }
        }
    }
}
