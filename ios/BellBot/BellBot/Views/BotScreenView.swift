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
        while !Task.isCancelled {
            do {
                let result: ScreenResponse = try await store.api.get(path + "?history=1")
                try Task.checkCancellation()
                if online != result.online { online = result.online }
                if screen != result.screen { screen = result.screen }
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
            do { try await Task.sleep(for: .seconds(1)) }
            catch { return }
        }
    }
}
