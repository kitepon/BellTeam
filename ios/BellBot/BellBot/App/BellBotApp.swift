import SwiftUI

@main
struct BellBotApp: App {
    @UIApplicationDelegateAdaptor(BellNotificationAppDelegate.self) private var appDelegate
    @StateObject private var store = AppStore()

    var body: some Scene {
        #if targetEnvironment(macCatalyst)
        WindowGroup {
            mainContent
                .frame(minWidth: 1100, idealWidth: 1280, minHeight: 640, idealHeight: 820)
        }
        .windowResizability(.contentMinSize)

        WindowGroup("メンバーを編集", id: "member-editor", for: String.self) { $botID in
            if let botID, let bot = store.bots.first(where: { $0.id == botID }) {
                MemberEditorWindow(bot: bot)
                    .environmentObject(store)
            } else {
                ContentUnavailableView("メンバーが見つかりません", systemImage: "person.crop.circle.badge.questionmark")
            }
        }
        .windowResizability(.contentMinSize)
        #else
        WindowGroup { mainContent }
        #endif
    }

    private var mainContent: some View {
        RootView()
            .environmentObject(store)
            .tint(BellTheme.violet)
            .task {
                #if DEBUG
                if ProcessInfo.processInfo.arguments.contains(where: { $0.hasPrefix("-bellbot-preview") }) {
                    store.preparePreview()
                } else {
                    await store.bootstrap()
                }
                #else
                await store.bootstrap()
                #endif
            }
    }
}

#if targetEnvironment(macCatalyst)
private struct MemberEditorWindow: View {
    let bot: Bot
    @Environment(\.dismissWindow) private var dismissWindow
    @State private var sizeError: String?

    var body: some View {
        BotEditor(initial: bot) { dismissWindow(id: "member-editor", value: bot.id) }
            .frame(minWidth: 600, minHeight: 500)
            .background(MemberEditorWindowGeometry(errorMessage: $sizeError))
            .overlay(alignment: .top) {
                if let sizeError {
                    Text("編集ウィンドウのサイズを変更できませんでした: \(sizeError)")
                        .font(.footnote).foregroundStyle(.red)
                        .padding(8).background(.regularMaterial)
                }
            }
    }
}

private struct MemberEditorWindowGeometry: UIViewRepresentable {
    @Binding var errorMessage: String?

    func makeUIView(context: Context) -> WindowObserver {
        let view = WindowObserver()
        view.onAttach = { scene in
            var frame = scene.effectiveGeometry.systemFrame
            frame.size = CGSize(width: 1120, height: 900)
            scene.requestGeometryUpdate(UIWindowScene.GeometryPreferences.Mac(systemFrame: frame)) { error in
                Task { @MainActor in errorMessage = error.localizedDescription }
            }
        }
        return view
    }

    func updateUIView(_ uiView: WindowObserver, context: Context) {}

    final class WindowObserver: UIView {
        var onAttach: ((UIWindowScene) -> Void)?

        override func didMoveToWindow() {
            super.didMoveToWindow()
            if let scene = window?.windowScene {
                onAttach?(scene)
                onAttach = nil
            }
        }
    }
}
#endif

private struct RootView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.scenePhase) private var scenePhase

    @ViewBuilder private var readyView: some View {
        #if targetEnvironment(macCatalyst)
        DesktopWorkspaceView()
        #else
        if UIDevice.current.userInterfaceIdiom == .pad {
            DesktopWorkspaceView()
        } else {
            BellTabs()
        }
        #endif
    }

    var body: some View {
        Group {
            switch store.phase {
            case .checking:
                ZStack {
                    BellBackground()
                    ProgressView("BellTeamを開いています")
                        .font(.subheadline)
                }
            case .setup:
                ServerSetupView()
            case .onboarding:
                OnboardingView()
            case .signIn:
                LoginView()
            case .ready:
                #if DEBUG
                if ProcessInfo.processInfo.arguments.contains("-bellbot-preview-avatar-crop") {
                    PreviewAvatarCropView()
                } else if ProcessInfo.processInfo.arguments.contains("-bellbot-preview-server-setup") {
                    ServerSetupView()
                } else if ProcessInfo.processInfo.arguments.contains("-bellbot-preview-chat") {
                    NavigationStack { ConversationView(target: .bot("bot-one")) }
                } else if ProcessInfo.processInfo.arguments.contains("-bellbot-preview-markdown") {
                    NavigationStack { ConversationView(target: .bot("bot-two")) }
                } else {
                    readyView
                }
                #else
                readyView
                #endif
            case .failure(let message):
                ZStack {
                    BellBackground()
                    ContentUnavailableView {
                        Label("接続できませんでした", systemImage: "wifi.exclamationmark")
                    } description: {
                        Text(message)
                    } actions: {
                        Button("もう一度試す") { Task { await store.bootstrap() } }
                            .buttonStyle(.borderedProminent)
                    }
                }
            }
        }
        #if DEBUG
        .safeAreaInset(edge: .top) {
            if ProcessInfo.processInfo.arguments.contains("-bellbot-preview-notification") {
                PreviewNotificationControls()
            }
        }
        #endif
        .onChange(of: scenePhase) { _, next in
            #if DEBUG
            if ProcessInfo.processInfo.arguments.contains(where: { $0.hasPrefix("-bellbot-preview") }) { return }
            #endif
            store.sceneChanged(to: next)
        }
    }
}

private struct BellTabs: View {
    @EnvironmentObject private var store: AppStore

    var body: some View {
        TabView(selection: $store.selectedTab) {
            HomeView()
                .tabItem { Label("会話", systemImage: "bubble.left.and.bubble.right.fill") }
                .tag(0)
            SchedulesView()
                .tabItem { Label("予定", systemImage: "calendar") }
                .tag(1)
            SettingsView()
                .tabItem { Label("設定", systemImage: "person.crop.circle") }
                .tag(2)
        }
        .sheet(item: $store.notificationSecret) { request in
            SecretInputSheet(request: request) { _ in store.eventRevision += 1 }
                .environmentObject(store)
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            if let error = store.connectionError {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .lineLimit(2)
                    .frame(maxWidth: .infinity)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .background(.regularMaterial)
            }
        }
    }
}
