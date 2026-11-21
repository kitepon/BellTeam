import Foundation
import LoginBilling
import WebKit
import OSLog
import SwiftUI
import Combine
import Darwin

enum EventResource: Hashable {
    case all, bots, rooms, owner
}

/// 一覧の再取得の赤字と、それを立てた経路。対象を絞った再取得の成功は、自分が立てた赤字だけを消す。
struct MemberListRefreshError {
    private(set) var message: String?
    /// 対象を絞った再取得が立てた時の資源。nilは全件取得などが立てた赤字で、部分の成功では消さない。
    private(set) var eventResources: Set<EventResource>?

    mutating func clear() { message = nil; eventResources = nil }

    mutating func fullRefreshFailed(_ text: String) { message = text; eventResources = nil }

    mutating func eventRefreshFailed(_ text: String, resources: Set<EventResource>) {
        let fromFullRefresh = message != nil && eventResources == nil
        message = text
        if !fromFullRefresh { eventResources = (eventResources ?? []).union(resources) }
    }

    mutating func eventRefreshSucceeded(resources: Set<EventResource>) {
        guard let failed = eventResources, failed.isSubset(of: resources) else { return }
        clear()
    }
}

enum MemberListReadOrigin: String {
    case bootstrap, webLogin, guideCompletion, sceneForeground, sseAll, sseResources, homePull
    case conversationStop, conversationSend, ownerQuestionAnswer
    case ownerSave, avatarSave, avatarConfirmation, memberSave, deletionConfirmation
    case unspecified
}

private struct MemberListReadCallContext {
    let origin: MemberListReadOrigin
    let callContinuousTick: UInt64
    let appState: BellAppStateSnapshot

    static func capture(_ origin: MemberListReadOrigin, diagnostics: BellDiagnostics) -> Self {
        // 連続時計と状態snapshotは順に採る。境界で変われば原子的な同時状態ではない。
        let tick = clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW)
        let state = diagnostics.requestAppStateSnapshot()
        return Self(origin: origin, callContinuousTick: tick, appState: state)
    }

    var log: String {
        "member_list_origin=\(origin.rawValue)"
            + "\nmember_list_call_continuous_ms=\(callContinuousTick / 1_000_000)"
            + "\nmember_list_app_state_at_call=\(appState.state)"
            + "\nmember_list_app_state_revision_at_call=\(appState.revision)"
            + "\nmember_list_app_state_changed_continuous_ms_at_call=\(appState.changedContinuousTick / 1_000_000)"
    }
}

@MainActor
final class AppStore: ObservableObject {
    enum Phase {
        case checking
        case setup
        case onboarding
        case signIn
        /// サーバーのセッションログイン（app-sessions.md）。modelはserverLoginが持つ。
        case serverLogin
        case ready
        case failure(String)
    }

    @Published var phase: Phase = .checking
    @Published private(set) var serverURL: URL?
    /// 本体のログイン契約の探査結果（GET /api/session）。古い本体はnilで、従来のAccess経路を使う。
    private(set) var loginProbe: SessionResponse.Login?
    private(set) var sessionID: String?
    /// 接続先がホームの契約（GET /api/home/session）を持つ時の探査結果。無い本体はnilで、従来の経路を使う。
    private(set) var homeProbe: HomeProbe?
    private var homeSession: HomeSession?
    @Published private(set) var homeLogin: HomeLoginModel?
    @Published private(set) var serverLogin: ServerLoginModel?
    /// 入っているアプリ側: 承認待ち・アプリを追加・セッション一覧。
    private(set) lazy var serverSessions = ServerSessionsModel(api: api)
    /// このサーバーがセッションで入る本体か（トークンがある、またはenforced）。
    var usesServerSessions: Bool { homeProbe == nil && (api.sessionToken != nil || loginProbe?.enforced == true) }
    /// 店の側のアカウント（ライブラリ）。運営のWorkerの接続先が設定された時だけ動く。
    let storeAccount = StoreAccount(baseURL: StoreAccount.configuredBaseURL, productId: BillingStore.configuration.productId)
    /// 本体が今はセッションを判断できない（503 SESSION_STORE_UNAVAILABLE）。トークンは残し、1・2・4…30秒で読み直す。
    @Published private(set) var serverPreparing = false
    private var preparingDelay: TimeInterval = 1
    private var preparingTask: Task<Void, Never>?
    @Published var setup: SetupResponse?
    @Published private(set) var setupAuthNeedsRefresh = false
    private var setupAuthRevision = 0
    private var setupReadSequence = 0
    private var setupAuthUpdating = false
    @Published var featureSettings: [FeatureSetting] = []
    /// nilは未取得か、サーバーが要約のAIの設定を持たない版。
    @Published var backgroundAgent: BackgroundAgentRecord?
    @Published var backgroundAgentNotice: String?
    @Published var terminals = TerminalDirectory()
    @Published var authMode = "local"
    var openLoginAutomatically = false
    var routingEnabled: Bool { featureSettings.first { $0.id == "routing" }?.status == "enabled" }
    var notificationsEnabled: Bool { featureSettings.first { $0.id == "notifications" }?.status == "enabled" }
    @Published var bots: [Bot] = []
    /// a480: why the last pin/unpin failed; the lists show it in an alert.
    @Published var pinError: String?
    @Published private(set) var pendingBotDeletionIDs: Set<String> = []
    @Published var rooms: [Room] = []
    @Published var owner: Owner?
    @Published var eventRevision = 0
    let conversationChanges = PassthroughSubject<ChatTarget, Never>()
    let scheduleChanges = PassthroughSubject<Set<ChatTarget>, Never>()
    @Published private(set) var aiControl: AIControl?
    @Published private(set) var aiControlLoading = false
    @Published private(set) var aiControlUpdating = false
    @Published private(set) var aiControlError: String?
    @Published var connectionError: String?
    private var refreshFailure = MemberListRefreshError()
    private var eventsError: String?
    private var notificationError: String?
    @Published var selectedTab = 0 { didSet { if selectedTab != 0 { chatReturnTab = nil } } }
    @Published var chatPath: [ChatTarget] = [] {
        didSet {
            // 相関図から開いた会話で戻ると相関図のタブへ帰る（work-graph behavior-spec.md「Tap or click on a member」）。
            if chatPath.isEmpty { _ = returnFromConversation() }
        }
    }
    private var chatReturnTab: Int?
    /// A chart to open from a member's 「AIと操作」 (iPad/Mac); `LatticeHomeView` takes it and clears it.
    @Published var latticeOpenRequest: String?
    /// The card to open inside `latticeOpenRequest`'s chart (「工程表の工程を開く」 from a 決裁).
    @Published var latticeOpenCard: String?
    /// 決裁箱 (the Approval Box extension): one read path for the entry's count and the screen.
    let approvals = ApprovalsModel()
    /// iPhone: the 決裁箱 screen is pushed from 会話's list. iPad/Mac containers watch `approvalsRequest`.
    @Published var approvalsScreenOpen = false
    @Published private(set) var approvalsRequest = 0
    private var drafts: [ChatTarget: ConversationDraft] = [:]
    // 編集値は再認証をまたいで保持する。文字入力でアプリ全体へ更新通知を出さない。
    var botEditorDrafts: [String: BotEditorDraft] = [:]
    var conversationPages: [ChatTarget: ConversationPage] = [:]
    private(set) var conversationGeneration = 0
    var profileImageDrafts: [String: AvatarSelectionDrafts] = [:]
    @Published var notificationSecret: SecretRequest?
    private var pendingNotification: BellNotificationRoute?

    let api: BellAPI
    let webDataStore: WKWebsiteDataStore
    let billing: BillingStore
    let updates: UpdateStore
    @Published var updatePresented = false
    private(set) var pendingUpdateNotification: BellUpdateRoute?
    private var eventsTask: Task<Void, Never>?
    private var eventRefreshTask: Task<Void, Never>?
    private var eventRefreshResources: Set<EventResource> = []
    /// 一覧以外の読み直し。イベントの受信を止めないよう、受信とは別の1本にまとめる。
    enum SideRefresh: Hashable { case updates, settings, setup, aiControl }
    private var sideRefreshTask: Task<Void, Never>?
    private var sideRefreshPending: Set<SideRefresh> = []
    private var foregroundTask: Task<Void, Never>?
    private var scenePhase: ScenePhase = .inactive
    private var checkingLogin = false
    private var aiControlEpoch = 0
    private var aiControlReadSequence = 0
    private var aiControlRefreshPending = false
    private struct AvatarCacheEntry: Equatable {
        let id: String
        let dataURL: String
        let version: String?
    }
    private struct AvatarRequest: Sendable {
        let inline: String
        let version: String?
        let previous: String?
        let previousVersion: String?
        let path: String
        let botID: String?
    }
    private var savedAvatarCacheServer: String?
    private var savedAvatarCacheEntries: [AvatarCacheEntry] = []

    func draft(for target: ChatTarget) -> ConversationDraft {
        if let draft = drafts[target] { return draft }
        let draft = ConversationDraft()
        drafts[target] = draft
        return draft
    }

    private func removeDraft(for target: ChatTarget) {
        drafts.removeValue(forKey: target)?.clear()
    }

    init(api suppliedAPI: BellAPI? = nil, billing suppliedBilling: BillingStore? = nil, webDataStore: WKWebsiteDataStore = .default()) {
        let saved = UserDefaults.standard.string(forKey: "bellbot.serverURL")
        let url = suppliedAPI == nil ? saved.flatMap { ServerOrigin.url($0) } : suppliedAPI?.baseURL
        serverURL = url
        api = suppliedAPI ?? BellAPI(baseURL: url)
        if suppliedAPI == nil, let url, let shared = try? ShareCredentials.load(), shared.serverURL == url.absoluteString {
            api.sessionToken = shared.sessionToken
        }
        self.webDataStore = webDataStore
        billing = suppliedBilling ?? BillingStore(api: api)
        updates = UpdateStore(api: api)
        billing.onSetupRequired = { [weak self] in
            guard let self else { return }
            try await self.refreshSetup()
            guard self.setup?.phase == "ready", let guide = self.setup?.guideBotId else {
                self.phase = .onboarding
                return
            }
            self.selectedTab = 0
            self.chatPath = [.bot(guide)]
        }
        billing.onEntitlementChange = { [weak self] in
            guard let self else { return }
            await BellNotifications.shared.updateSignedTransaction(self.billing.notificationSignedTransaction)
            self.publishShareCredentials()
        }
        api.diagnostics.configure(serverURL: url)
        BellNotifications.shared.onTokenChange = { [weak self] in Task { await self?.reproveHome() } }
        BellNotifications.shared.onOpen = { [weak self] route in
            self?.pendingNotification = route
            Task { await self?.openPendingNotification() }
        }
        BellNotifications.shared.onOpenUpdate = { [weak self] route in
            self?.pendingUpdateNotification = route
            Task { await self?.openPendingUpdateNotification() }
        }
    }

    /// 消した後に届いた古い応答を保存しないよう、取得を始めた時の世代と比べる。
    func remember(_ page: ConversationPage, for target: ChatTarget, generation: Int) {
        guard generation == conversationGeneration else { return }
        conversationPages[target] = page
    }

    func clearConversationPages() {
        conversationGeneration += 1
        conversationPages.removeAll()
    }

    func setServerAddress(_ address: String) async throws {
        guard let url = ServerOrigin.url(address) else { throw BellAPIError.server("HTTPS、またはlocalhost・LANのHTTP接続先URLを入力してください。") }
        if serverURL != url {
            botEditorDrafts.removeAll()
            clearConversationPages()
            profileImageDrafts.removeAll()
            pendingBotDeletionIDs.removeAll()
            resetAIControl()
            updates.reset()
        }
        // トークンはその接続先のものだけ。別の接続先へは持ち越さない。
        if serverURL != url { api.sessionToken = nil; sessionID = nil; loginProbe = nil; serverLogin = nil; homeProbe = nil; homeSession = nil; homeLogin = nil }
        serverURL = url
        api.baseURL = url
        api.diagnostics.configure(serverURL: url)
        UserDefaults.standard.set(url.absoluteString, forKey: "bellbot.serverURL")
        publishShareCredentials()
        phase = .checking
        await bootstrap()
    }

    func changeServer() async {
        await signOut()
        preparingTask?.cancel(); serverPreparing = false
        loginProbe = nil; serverLogin = nil; homeProbe = nil; homeSession = nil; homeLogin = nil
        UserDefaults.standard.removeObject(forKey: "bellbot.serverURL")
        serverURL = nil
        api.baseURL = nil
        api.diagnostics.configure(serverURL: nil)
        bots = []
        pendingBotDeletionIDs.removeAll()
        rooms = []
        owner = nil
        setup = nil
        setupAuthNeedsRefresh = false
        setupAuthRevision += 1
        setupReadSequence += 1
        setupAuthUpdating = false
        featureSettings = []
        backgroundAgent = nil
        backgroundAgentNotice = nil
        terminals = TerminalDirectory()
        authMode = "local"
        phase = .setup
    }

    func bootstrap() async {
        guard serverURL != nil else { phase = .setup; return }
        await syncCookies()
        do {
            homeProbe = try await probeHome()
            let session: SessionResponse = try await api.get("/api/session")
            authMode = session.authMode
            loginProbe = session.login
            sessionID = session.sessionId
            serverPreparing = false
            preparingDelay = 1
            guard session.authenticated else {
                // ログイン契約のある本体: 確定した未認証だけがトークンを捨て、サーバーに入る画面へ進む。
                if session.login?.capability == true || homeProbe != nil { showServerLogin(); return }
                throw BellAPIError.unauthorized
            }
            // 持ち主が決まっていないホームサーバーは、セットアップコードで最初の結びつけをする。
            if let probe = homeProbe, !probe.bound, api.sessionToken == nil { showServerLogin(); return }
            try await loadInitialState(origin: .bootstrap)
        } catch let error where BellAPIError.isAuthenticationError(error) {
            requireLogin(for: error)
        } catch BellAPIError.httpStatus(503, let code, _) where code == "SESSION_STORE_UNAVAILABLE" {
            retryBootstrapSoon()
        } catch {
            // 接続できた（ホームのセッションがある）のに本体の画面を読めない時は、そのことを言う。
            let reached = homeSession.map { "ホームサーバーにはつながっています（\($0.state)）が、BellTeamの画面を読み込めませんでした。" }
            phase = .failure([reached, error.localizedDescription].compactMap { $0 }.joined(separator: "\n"))
            api.diagnostics.report(error, path: "/api/session", method: "GET", observation: .startup)
        }
    }

    /// 404（ホームの契約が無い旧本体）と、JSONでない応答だけが「ホームではない」。接続の失敗などは呼び出し元の失敗として返す。
    private func probeHome() async throws -> HomeProbe? {
        do {
            let probe: HomeProbe = try await api.get("/api/home/session")
            return probe.capability == HomeProbe.capabilityName ? probe : nil
        } catch BellAPIError.httpStatus(404, _, _) { return nil }
        catch is DecodingError { return nil }
    }

    func completeWebLogin() async {
        guard !checkingLogin else { return }
        checkingLogin = true
        defer { checkingLogin = false }
        let cookies = await webDataStore.httpCookieStore.allCookies()
        guard cookies.contains(where: { $0.name == "CF_Authorization" && !$0.isExpired && cookieBelongsToServer($0) }) else { return }
        await syncCookies(cookies)
        do {
            let session: SessionResponse = try await api.get("/api/session")
            guard session.authenticated else { return }
            authMode = session.authMode
            try await loadInitialState(origin: .webLogin)
        } catch let error where BellAPIError.isAuthenticationError(error) {
            return
        } catch {
            phase = .failure(error.localizedDescription)
            api.diagnostics.report(error, path: "/api/session", method: "GET", observation: .startup)
        }
    }

    private func loadInitialState(origin: MemberListReadOrigin) async throws {
        try await refreshSettings()
        setup = try await api.get("/api/setup")
        guard setup?.phase == "ready" else { phase = .onboarding; return }
        try await enterConversations(openGuide: setup?.complete == false, origin: origin)
    }

    func refreshSettings() async throws {
        let response: FeatureSettingsResponse = try await api.get("/api/settings")
        if featureSettings != response.settings { featureSettings = response.settings }
        if backgroundAgent != response.backgroundAgent { backgroundAgent = response.backgroundAgent }
        if backgroundAgentNotice != response.backgroundAgentNotice { backgroundAgentNotice = response.backgroundAgentNotice }
    }

    func refreshAIControl() async {
        if aiControlUpdating {
            aiControlRefreshPending = true
            return
        }
        await readAIControl()
    }

    func setAIControlPaused(_ paused: Bool) async {
        guard !aiControlUpdating, let aiControl, aiControl.paused != paused else { return }
        let epoch = aiControlEpoch
        aiControlReadSequence += 1
        aiControlLoading = false
        aiControlUpdating = true
        aiControlError = nil
        do {
            let response: AIControlResponse = try await api.patch("/api/ai-control", body: AIControlUpdate(paused: paused))
            guard epoch == aiControlEpoch else { return }
            self.aiControl = response.control
        } catch let error where BellAPIError.isAuthenticationError(error) {
            guard epoch == aiControlEpoch else { return }
            requireLogin(for: error)
            return
        } catch {
            guard epoch == aiControlEpoch else { return }
            api.diagnostics.report(error, path: "/api/ai-control", method: "PATCH", observation: .write)
            // PATCHを再送しない。通信断や5xx後もGETの現在値だけを表示する。
            await readAIControl()
            if self.aiControl != nil {
                switch error {
                case BellAPIError.httpStatus(503, _, _):
                    aiControlError = "変更を保存できませんでした。現在の状態を表示しています。"
                case BellAPIError.httpStatus(502, _, _):
                    if self.aiControl?.state != .stopped {
                        aiControlError = "停止操作の結果を確認できませんでした。現在の状態を表示しています。"
                    }
                default:
                    aiControlError = "通信後の現在の状態を読み直しました。"
                }
            }
        }
        guard epoch == aiControlEpoch else { return }
        if aiControlRefreshPending {
            aiControlRefreshPending = false
            await readAIControl()
        }
        aiControlUpdating = false
    }

    private func readAIControl() async {
        #if DEBUG
        if let previewAIControl { aiControl = previewAIControl; return }
        #endif
        let epoch = aiControlEpoch
        aiControlReadSequence += 1
        let sequence = aiControlReadSequence
        if !aiControlLoading { aiControlLoading = true }
        do {
            let response: AIControlResponse = try await api.get("/api/ai-control")
            guard epoch == aiControlEpoch, sequence == aiControlReadSequence else { return }
            if aiControl != response.control { aiControl = response.control }
            if aiControlError != nil { aiControlError = nil }
        } catch let error where BellAPIError.isAuthenticationError(error) {
            guard epoch == aiControlEpoch, sequence == aiControlReadSequence else { return }
            if aiControl != nil { aiControl = nil }
            requireLogin(for: error)
            return
        } catch {
            guard epoch == aiControlEpoch, sequence == aiControlReadSequence else { return }
            if aiControl != nil { aiControl = nil }
            aiControlError = "全体停止の状態を確認できませんでした。接続を確認して再読み込みしてください。"
            api.diagnostics.report(error, path: "/api/ai-control", method: "GET", observation: .read(error, retainedData: false))
        }
        if aiControlLoading { aiControlLoading = false }
    }

    #if DEBUG
    private var previewAIControl: AIControl?

    /// `-bellbot-preview-settings`: realistic settings data for screenshots, no server.
    func prepareSettingsPreview() throws {
        serverURL = URL(string: "https://bellteam.example.com")
        authMode = "cloudflare"
        owner = Owner(name: "クオ", profile: "BellTeamの設計者。AIチームと一緒にプロダクトを作っています。", avatar: "",
                      xUrl: "https://x.com/kitepon", githubUrl: "https://github.com/kitepon", links: [])
        featureSettings = try JSONDecoder().decode([FeatureSetting].self, from: Data(#"""
        [{"id":"notifications","title":"通知","enabled":true,"status":"enabled","fields":[],"error":null},
         {"id":"calendar","title":"カレンダー","enabled":false,"status":"disabled","fields":[],"error":null}]
        """#.utf8))
        backgroundAgent = try JSONDecoder().decode(BackgroundAgentRecord.self, from: Data(
            #"{"revision":"r1","selection":{"harness":"codex","model":"gpt-5","reasoningEffort":"low"}}"#.utf8))
        previewAIControl = try JSONDecoder().decode(AIControl.self, from: Data(
            #"{"paused":false,"state":"enabled","updatedAt":null,"unconfirmedBotIds":[],"commandsConfirmed":true,"error":null}"#.utf8))
        aiControl = previewAIControl
        selectedTab = 2
    }
    #endif

    private func resetAIControl() {
        aiControlEpoch += 1
        aiControlReadSequence += 1
        aiControl = nil
        aiControlLoading = false
        aiControlUpdating = false
        aiControlRefreshPending = false
        aiControlError = nil
    }

    func refreshSetup(explicit: Bool = false) async throws {
        if setupAuthUpdating || (setupAuthNeedsRefresh && !explicit) { return }
        let revision = setupAuthRevision
        setupReadSequence += 1
        let sequence = setupReadSequence
        let next: SetupResponse
        do { next = try await api.get("/api/setup") }
        catch {
            if sequence != setupReadSequence || revision != setupAuthRevision
                || (setupAuthNeedsRefresh && !explicit) { return }
            throw error
        }
        guard !setupAuthUpdating, revision == setupAuthRevision, sequence == setupReadSequence,
              (!setupAuthNeedsRefresh || explicit) else { return }
        setup = next
        if explicit { setupAuthNeedsRefresh = false }
    }

    func chooseHarness(_ harness: String) async throws {
        setupAuthRevision += 1
        setupAuthUpdating = true
        defer { setupAuthUpdating = false; setupAuthRevision += 1 }
        setup = try await api.post("/api/setup/harness", body: HarnessSelection(harness: harness))
    }

    /// a451: install the chosen AI (the same press updates it). The snapshot answers busy, then the login once it is there.
    func installSetupHarness() async throws {
        setupAuthRevision += 1
        setupAuthUpdating = true
        defer { setupAuthUpdating = false; setupAuthRevision += 1 }
        setup = try await api.post("/api/setup/install", body: SetupEmptyBody())
    }

    func submitAuthResponse(_ response: AuthenticationReply.Response, for ui: AuthenticationUI) async throws {
        guard !setupAuthNeedsRefresh, setup?.auth?.authUi == ui, let reply = ui.reply(response) else {
            throw BellAPIError.server("認証画面が更新されました。状態を確認してから操作してください。")
        }
        setupAuthRevision += 1
        setupAuthUpdating = true
        defer { setupAuthUpdating = false; setupAuthRevision += 1 }
        do { setup = try await api.submitAuthenticationInput(reply) }
        catch { setupAuthNeedsRefresh = true; throw error }
    }

    func startGuide() async throws {
        setupAuthRevision += 1
        setupAuthUpdating = true
        defer { setupAuthUpdating = false; setupAuthRevision += 1 }
        setup = try await api.post("/api/setup/start", body: SetupEmptyBody())
        guard setup?.phase == "ready" else { throw BellAPIError.server("公式認証を完了してから、もう一度確認してください。") }
        try await enterConversations(openGuide: true, origin: .guideCompletion)
    }

    private func enterConversations(openGuide: Bool, origin: MemberListReadOrigin) async throws {
        try await refresh(origin: origin)
        phase = .ready
        if openGuide, let guide = setup?.guideBotId { selectedTab = 0; chatPath = [.bot(guide)] }
        startEvents()
        await billing.connect()
        await openPendingNotification()
        await openPendingUpdateNotification()
        if notificationsEnabled {
            await activateNotifications()
        }
    }

    func authorizeAIUse(target: ChatTarget) async throws {
        let botID: String? = if case .bot(let id) = target { id } else { nil }
        if botID == setup?.guideBotId, botID != nil { try await refreshSetup() }
        let initialGuide = AppleSubscriptionAccess.isInitialGuide(botID: botID, guideBotID: setup?.guideBotId, setupComplete: setup?.complete ?? true)
        try await billing.requirePaidAccess(initialGuide: initialGuide)
    }

    func restartConversation(target: ChatTarget) async throws {
        try await authorizeAIUse(target: target)
        // The server answers only after the new seat is up (a remote seat takes tens of seconds), so this one request waits longer than the 60 s default.
        // 200 {restarted, session} and an older body's 202 {restarting} are both success.
        let _: APIAcknowledgement = try await api.post(target.path + "/restart", body: EmptyBody(), timeout: 180)
    }

    func activateNotifications() async {
        await BellNotifications.shared.activate(api: api, signedTransaction: billing.notificationSignedTransaction)
    }

    func refresh(origin: MemberListReadOrigin = .unspecified) async throws {
        let call = MemberListReadCallContext.capture(origin, diagnostics: api.diagnostics)
        async let botResult: BotsResponse = api.get("/api/bots?avatar=omit", callerContext: call.log)
        async let roomResult: RoomsResponse = api.get("/api/rooms?avatar=omit")
        async let ownerResult: OwnerResponse = api.get("/api/owner?avatar=omit")
        let (bots, rooms, owner) = try await (botResult, roomResult, ownerResult)
        async let resolvedBots = withResolvedBotAvatars(bots.bots)
        async let resolvedRooms = withResolvedRoomAvatars(rooms.rooms)
        async let resolvedOwner = withResolvedOwnerAvatar(owner.owner)
        let (botList, roomList, ownerValue) = try await (resolvedBots, resolvedRooms, resolvedOwner)
        try Task.checkCancellation()
        applyFetchedBots(botList)
        if self.rooms != roomList { self.rooms = roomList }
        if self.owner != ownerValue { self.owner = ownerValue }
        await storeBotAvatarsIfChanged(botList)
    }

    private func withResolvedBotAvatars(_ fetched: [Bot]) async throws -> [Bot] {
        var bots = fetched
        let oldBots = Dictionary(uniqueKeysWithValues: self.bots.map { ($0.id, $0) })
        let requests = bots.map { bot in
            AvatarRequest(inline: bot.avatar, version: bot.avatarVersion,
                previous: oldBots[bot.id]?.avatar, previousVersion: oldBots[bot.id]?.avatarVersion,
                path: "/api/bots/\(bot.id)/avatar", botID: bot.id)
        }
        let avatars = try await resolveAvatars(requests)
        for index in bots.indices { bots[index].avatar = avatars[index] }
        return bots
    }

    private func withResolvedRoomAvatars(_ fetched: [Room]) async throws -> [Room] {
        var rooms = fetched
        let oldRooms = Dictionary(uniqueKeysWithValues: self.rooms.map { ($0.id, $0) })
        let requests = rooms.map { room in
            AvatarRequest(inline: room.avatar, version: room.avatarVersion,
                previous: oldRooms[room.id]?.avatar, previousVersion: oldRooms[room.id]?.avatarVersion,
                path: "/api/rooms/\(room.id)/avatar", botID: nil)
        }
        let avatars = try await resolveAvatars(requests)
        for index in rooms.indices { rooms[index].avatar = avatars[index] }
        return rooms
    }

    private func withResolvedOwnerAvatar(_ fetched: Owner) async throws -> Owner {
        var owner = fetched
        let request = AvatarRequest(inline: owner.avatar, version: owner.avatarVersion,
            previous: self.owner?.avatar, previousVersion: self.owner?.avatarVersion,
            path: "/api/owner/avatar", botID: nil)
        owner.avatar = try await avatar(request)
        return owner
    }

    private func storeBotAvatarsIfChanged(_ bots: [Bot]) async {
        if let server = serverURL?.absoluteString {
            let entries = bots.map { AvatarCacheEntry(id: $0.id, dataURL: $0.avatar, version: $0.avatarVersion) }
                .sorted { $0.id < $1.id }
            if server != savedAvatarCacheServer || entries != savedAvatarCacheEntries {
                do {
                    try await BotAvatarCacheAccess.shared.storeVersioned(
                        entries.map { (id: $0.id, dataURL: $0.dataURL, version: $0.version) }, server: server)
                    savedAvatarCacheServer = server
                    savedAvatarCacheEntries = entries
                } catch {
                    Logger(subsystem: "app.bellteam.bellbot", category: "notifications")
                        .error("通知アバターの保存に失敗: \(error.localizedDescription, privacy: .private)")
                    api.diagnostics.reportPush(error, stage: "avatar_cache", observation: .avatarCache)
                }
            }
        }
    }

    private func resolveAvatars(_ requests: [AvatarRequest]) async throws -> [String] {
        try await withThrowingTaskGroup(of: (Int, String).self) { group in
            var resolved = Array(repeating: "", count: requests.count)
            for (index, request) in requests.enumerated() {
                if let immediate = immediateAvatar(request) {
                    resolved[index] = immediate
                } else {
                    group.addTask { [self] in (index, try await avatar(request)) }
                }
            }
            for try await (index, value) in group { resolved[index] = value }
            return resolved
        }
    }

    private func immediateAvatar(_ request: AvatarRequest) -> String? {
        // 版を持たない既存の応答は、これまでの画像本体をそのまま使う。
        guard let version = request.version else { return request.inline }
        if version.isEmpty { return "" }
        if !request.inline.isEmpty { return request.inline }
        if version == request.previousVersion, let previous = request.previous { return previous }
        return nil
    }

    private func avatar(_ request: AvatarRequest) async throws -> String {
        if let immediate = immediateAvatar(request) { return immediate }
        guard let version = request.version else { return request.inline }
        if let botID = request.botID, let server = serverURL?.absoluteString,
           let cached = try await BotAvatarCacheAccess.shared.dataURL(botID: botID, server: server, version: version) { return cached }
        return try await api.avatar(request.path + "?v=" + version)
    }

    func requestRefreshFromEvent() {
        requestRefreshFromEvent(resources: [.all])
    }

    private func requestRefreshFromEvent(resources: Set<EventResource>) {
        // 裏に回った後に届いた知らせでは読まない（OSに止められて時間切れになる）。前面へ戻った時の再取得が全部読み直す。
        guard scenePhase != .background else { return }
        eventRefreshResources.formUnion(resources)
        guard eventRefreshTask == nil else { return }
        eventRefreshTask = Task { [weak self] in
            guard let self else { return }
            defer { if !Task.isCancelled { eventRefreshTask = nil } }
            while !eventRefreshResources.isEmpty && !Task.isCancelled {
                let resources = eventRefreshResources
                eventRefreshResources.removeAll()
                if resources.contains(.all) { await refreshFromView(origin: .sseAll, refreshSubscription: false) }
                else { await refreshResourcesFromEvent(resources) }
            }
        }
    }

    func applySavedRoom(_ saved: Room) {
        let previous = rooms.first { $0.id == saved.id }
        let room = Room(id: saved.id, name: saved.name, purpose: saved.purpose,
                        representativeId: saved.representativeId, memberIds: saved.memberIds,
                        avatar: saved.avatar, recent: previous?.recent)
        rooms = (rooms.filter { $0.id != saved.id } + [room]).sorted { $0.id < $1.id }
    }

    /// a480: pin or unpin a member (PATCH {pinned}, idempotent), then re-read the list so every screen takes the server's order.
    func setPinned(_ bot: Bot, _ pinned: Bool) async {
        let path = "/api/bots/\(bot.id)"
        do {
            let _: APIAcknowledgement = try await api.patch(path, body: ["pinned": pinned])
            await refreshFromView(origin: .memberSave, refreshSubscription: false)
        } catch let error where BellAPIError.isAuthenticationError(error) {
            requireLogin(for: error)
        } catch {
            pinError = "\(bot.displayName)のピン留めを変えられませんでした。\(BellAPIError.operationFailureMessage(error))"
            api.diagnostics.report(error, path: path, method: "PATCH", observation: .write)
        }
    }

    // DELETEの202は受付だけ。成功した一覧読取で消失を確認してから画面を片付ける。
    func requestBotDeletion(_ id: String) async throws {
        try await api.delete("/api/bots/\(id)")
        if bots.contains(where: { $0.id == id }) { pendingBotDeletionIDs.insert(id) }
    }

    func confirmBotDeletion(_ id: String) async throws -> Bool {
        try await refresh(origin: .deletionConfirmation)
        refreshFailure.clear()
        updateConnectionError()
        return !bots.contains(where: { $0.id == id })
    }

    func applyFetchedBots(_ fetched: [Bot]) {
        let currentIDs = Set(fetched.map(\.id))
        let removedIDs = Set(bots.map(\.id)).subtracting(currentIDs)
        if bots != fetched { bots = fetched }
        pendingBotDeletionIDs.formIntersection(currentIDs)
        chatPath.removeAll { target in
            if case .bot(let id) = target { return removedIDs.contains(id) }
            return false
        }
        for id in removedIDs {
            removeDraft(for: .bot(id))
            botEditorDrafts.removeValue(forKey: id)
            profileImageDrafts.removeValue(forKey: id)
        }
    }

    func deleteRoom(_ id: String) async throws {
        try await api.delete("/api/rooms/\(id)")
        applyDeletedRoom(id)
    }

    func applyDeletedRoom(_ id: String) {
        rooms.removeAll { $0.id == id }
        chatPath.removeAll { $0 == .room(id) }
        removeDraft(for: .room(id))
    }

    func refreshFromView(origin: MemberListReadOrigin = .unspecified,
                         refreshSubscription: Bool = true) async {
        do {
            try await refresh(origin: origin)
            refreshFailure.clear()
            updateConnectionError()
            if refreshSubscription { await billing.refreshFromServer() }
        }
        catch is CancellationError { return }
        catch let error as URLError where error.code == .cancelled { return }
        // 裏に回って止められている間に切れた読み取りは失敗表示にしない。前面へ戻った時の再取得が読み直す。
        catch where BellDiagnostics.isSuspendedTimeout(error) { return }
        catch let error where BellAPIError.isAuthenticationError(error) { requireLogin(for: error) }
        catch {
            refreshFailure.fullRefreshFailed(error.localizedDescription)
            updateConnectionError()
            api.diagnostics.report(error, path: "/api/bots", method: "GET", observation: .read(error, retainedData: !bots.isEmpty || !rooms.isEmpty))
        }
    }

    private func getForEvent<T: Decodable>(_ needed: Bool, path: String,
                                           callerContext: String? = nil) async throws -> T? {
        guard needed else { return nil }
        return try await api.get(path, callerContext: callerContext)
    }

    private func refreshResourcesFromEvent(_ resources: Set<EventResource>) async {
        do {
            let call = MemberListReadCallContext.capture(.sseResources, diagnostics: api.diagnostics)
            async let bots: BotsResponse? = getForEvent(resources.contains(.bots), path: "/api/bots?avatar=omit",
                                                         callerContext: call.log)
            async let rooms: RoomsResponse? = getForEvent(resources.contains(.rooms), path: "/api/rooms?avatar=omit")
            async let owner: OwnerResponse? = getForEvent(resources.contains(.owner), path: "/api/owner?avatar=omit")
            let (botResponse, roomResponse, ownerResponse) = try await (bots, rooms, owner)
            var botList: [Bot]?
            var roomList: [Room]?
            var ownerValue: Owner?
            if let botResponse { botList = try await withResolvedBotAvatars(botResponse.bots) }
            if let roomResponse { roomList = try await withResolvedRoomAvatars(roomResponse.rooms) }
            if let ownerResponse { ownerValue = try await withResolvedOwnerAvatar(ownerResponse.owner) }
            try Task.checkCancellation()
            if let botList {
                applyFetchedBots(botList)
                await storeBotAvatarsIfChanged(botList)
            }
            if let roomList, self.rooms != roomList { self.rooms = roomList }
            if let ownerValue, self.owner != ownerValue { self.owner = ownerValue }
            refreshFailure.eventRefreshSucceeded(resources: resources)
            updateConnectionError()
        } catch is CancellationError { return }
        catch let error as URLError where error.code == .cancelled { return }
        catch where BellDiagnostics.isSuspendedTimeout(error) { return }
        catch let error where BellAPIError.isAuthenticationError(error) { requireLogin(for: error) }
        catch {
            refreshFailure.eventRefreshFailed(error.localizedDescription, resources: resources)
            updateConnectionError()
            api.diagnostics.report(error, path: "/api/bots", method: "GET",
                                   observation: .read(error, retainedData: !bots.isEmpty || !rooms.isEmpty))
        }
    }

    private func updateConnectionError() {
        let next = eventsError ?? refreshFailure.message ?? notificationError
        if connectionError != next { connectionError = next }
    }

    func sceneChanged(to next: ScenePhase) {
        scenePhase = next
        api.diagnostics.updateAppState(String(describing: next))
        #if DEBUG
        Logger(subsystem: "app.bellteam.bellbot", category: "network")
            .debug("画面状態=\(String(describing: next), privacy: .public)")
        #endif
        if next == .active, case .ready = phase {
            foregroundTask?.cancel()
            foregroundTask = Task { [weak self] in
                guard let self else { return }
                await api.resetConnections()
                if Task.isCancelled { return }
                await refreshFromView(origin: .sceneForeground)
                if Task.isCancelled { return }
                await reproveHome()
                if Task.isCancelled { return }
                await refreshAIControl()
                if Task.isCancelled { return }
                await billing.refreshAppleAccess()
                if Task.isCancelled { return }
                if scenePhase == .active, case .ready = phase {
                    startEvents()
                    if notificationsEnabled { await activateNotifications() }
                }
            }
        } else if next == .background {
            foregroundTask?.cancel()
            foregroundTask = nil
            stopEvents()
        }
    }

    private static let eventsFailureReportThreshold = 5

    func startEvents() {
        stopEvents()
        eventsTask = Task { [weak self] in
            guard let self else { return }
            var reconnectDelay: UInt64 = 1_000_000_000
            var failures = 0
            while !Task.isCancelled {
                let connectedAt = Date()
                let requestStarted = DispatchTime.now().uptimeNanoseconds
                do {
                    try await api.events { [weak self] event in
                        guard let self else { return }
                        self.eventsError = nil
                        self.updateConnectionError()
                        switch event.type {
                        case "ready":
                            if self.usesServerSessions { await self.serverSessions.refresh() }
                            self.eventRevision += 1
                            self.requestRefreshFromEvent()
                            self.requestSideRefresh([.updates])
                        case "login.requested", "session.created", "session.ended": await self.serverSessions.refresh()
                        case "updates": self.requestSideRefresh([.updates])
                        case "settings": self.requestSideRefresh([.settings])
                        case "setup": self.requestSideRefresh([.setup])
                        case "ai-control": self.requestSideRefresh([.aiControl])
                        case "bots": self.requestRefreshFromEvent()
                        case "messages":
                            switch event.scope {
                            case .all:
                                self.eventRevision += 1
                                self.requestRefreshFromEvent()
                            case .targeted(let topics, let botIDs, let roomIDs):
                                if self.refreshFailure.message != nil {
                                    self.eventRevision += 1
                                    self.requestRefreshFromEvent()
                                } else {
                                    try await self.applyTargetedEvent(topics: topics, botIDs: botIDs, roomIDs: roomIDs)
                                }
                            }
                        default:
                            self.eventRevision += 1
                            self.requestRefreshFromEvent()
                        }
                    }
                    if Task.isCancelled { return }
                    eventsError = "更新の接続が切れました。再接続しています。"
                    updateConnectionError()
                } catch let error where BellAPIError.isAuthenticationError(error) {
                    if !Task.isCancelled { requireLogin(for: error) }
                    return
                } catch BellAPIError.httpStatus(let status, _, let trace) where status == 429 || status >= 500 {
                    if Task.isCancelled { return }
                    eventsError = "更新へ接続できません。再接続しています。"
                    updateConnectionError()
                    api.diagnostics.report(BellAPIError.httpStatus(status, nil, trace), path: "/api/events", method: "GET", observation: .reconnecting)
                } catch let error as URLError {
                    if Task.isCancelled { return }
                    // 切断1回は想定内。連続して失敗が続く時だけ、その連続を1件として報告する。
                    failures += 1
                    eventsError = "更新へ接続できません。再接続しています。"
                    updateConnectionError()
                    if failures == Self.eventsFailureReportThreshold { api.diagnostics.report(error, path: "/api/events", method: "GET", observation: .reconnecting, elapsedMilliseconds: BellDiagnostics.elapsedMilliseconds(since: requestStarted)) }
                } catch {
                    if Task.isCancelled { return }
                    // 404・読めない応答でも止めない。理由を出したまま同じ間隔で再接続し、報告は失敗の連続ごとに1件。
                    // 止めるのは取消（サインアウト・接続先変更を含む）と認証拒否だけ（Windows #677と同じ）。
                    failures += 1
                    eventsError = "更新を受け取れませんでした（\(BellAPIError.operationFailureMessage(error))）。再接続しています。"
                    updateConnectionError()
                    if failures == 1 { api.diagnostics.report(error, path: "/api/events", method: "GET", observation: .read(error, retainedData: !bots.isEmpty || !rooms.isEmpty)) }
                }
                if Date().timeIntervalSince(connectedAt) > 30 { reconnectDelay = 1_000_000_000; failures = 0 }
                do { try await Task.sleep(nanoseconds: reconnectDelay) }
                catch { return }
                reconnectDelay = min(reconnectDelay * 2, 30_000_000_000)
            }
        }
    }

    private func applyTargetedEvent(topics: Set<BellEventTopic>, botIDs: Set<String>, roomIDs: Set<String>) async throws {
        if !topics.isDisjoint(with: [.timeline, .queue, .requests, .questions]) {
            for id in botIDs { conversationChanges.send(.bot(id)) }
            for id in roomIDs { conversationChanges.send(.room(id)) }
        }
        if topics.contains(.schedules) {
            scheduleChanges.send(Set(botIDs.map(ChatTarget.bot) + roomIDs.map(ChatTarget.room)))
        }
        let side: [(BellEventTopic, SideRefresh)] = [(.settings, .settings), (.setup, .setup), (.aiControl, .aiControl), (.updates, .updates)]
        requestSideRefresh(Set(side.filter { topics.contains($0.0) }.map(\.1)))
        var resources: Set<EventResource> = []
        if !topics.isDisjoint(with: [.timeline, .requests, .questions]) {
            if !botIDs.isEmpty { resources.insert(.bots) }
            if !roomIDs.isEmpty { resources.insert(.rooms) }
        }
        if topics.contains(.bots) { resources.insert(.bots) }
        if topics.contains(.rooms) { resources.insert(.rooms) }
        if topics.contains(.owner) { resources.insert(.owner) }
        // 現在の仕事の変化はqueueとして届き、一覧の行と仕事中の印はbotsのcurrentWorkから描く。
        if topics.contains(.queue), !botIDs.isEmpty { resources.insert(.bots) }
        if !resources.isEmpty { requestRefreshFromEvent(resources: resources) }
    }

    func stopEvents() {
        eventsTask?.cancel()
        eventsTask = nil
        eventRefreshTask?.cancel()
        eventRefreshTask = nil
        eventRefreshResources.removeAll()
        sideRefreshTask?.cancel()
        sideRefreshTask = nil
        sideRefreshPending.removeAll()
    }

    /// 通知が続けて届いても、読み直しは実行中の1本と次の1回だけにまとめる。
    func requestSideRefresh(_ kinds: Set<SideRefresh>) {
        guard scenePhase != .background else { return }
        sideRefreshPending.formUnion(kinds)
        guard sideRefreshTask == nil, !sideRefreshPending.isEmpty else { return }
        sideRefreshTask = Task { [weak self] in
            guard let self else { return }
            defer { if !Task.isCancelled { sideRefreshTask = nil } }
            while !sideRefreshPending.isEmpty && !Task.isCancelled {
                let kinds = sideRefreshPending
                sideRefreshPending.removeAll()
                if kinds.contains(.updates) { await updates.refresh() }
                if kinds.contains(.aiControl) { await refreshAIControl() }
                for (kind, path) in [(SideRefresh.settings, "/api/settings"), (.setup, "/api/setup")] where kinds.contains(kind) {
                    do { if kind == .settings { try await refreshSettings() } else { try await refreshSetup() } }
                    catch let error where BellAPIError.isAuthenticationError(error) { requireLogin(for: error); return }
                    catch { api.diagnostics.report(error, path: path, method: "GET", observation: .read(error, retainedData: true)) }
                }
            }
        }
    }

    func requireLogin() {
        foregroundTask?.cancel()
        foregroundTask = nil
        stopEvents()
        resetAIControl()
        refreshFailure.clear()
        eventsError = nil
        notificationError = nil
        updateConnectionError()
        if api.sessionToken != nil || loginProbe?.enforced == true { showServerLogin(); return }
        phase = authMode == "cloudflare" ? .signIn : .failure("接続先が認証を拒否しました。サーバーの設定を確認してください。")
    }

    /// 本体が確定した401・未認証を返した。古いトークンは捨てて、サーバーに入る画面を出す。
    private func showServerLogin() {
        api.sessionToken = nil
        sessionID = nil
        publishShareCredentials()
        if let probe = homeProbe {
            serverLogin = nil
            homeLogin = HomeLoginModel(setupCodeNeeded: !probe.bound) { [weak self] setupCode in
                try await self?.connectHome(setupCode: setupCode)
            }
        } else {
            homeLogin = nil
            serverLogin = ServerLoginModel(api: api, setupCodeNeeded: loginProbe?.bound == false) { [weak self] token, id in
                await self?.completeServerLogin(token: token, sessionId: id)
            }
        }
        phase = .serverLogin
    }

    /// ホームサーバーへ入る: Appleのパスで証明し、返ったトークンをBellAPIが付ける。失敗はモデルが理由を出す（自動では再送しない）。
    private func connectHome(setupCode: String?) async throws {
        guard let url = serverURL else { throw LoginBillingError(code: "bad_request") }
        let session = try await storeAccount.connectHome(url, setupCode: setupCode, pushToken: BellNotifications.shared.pushToken)
        guard let token = storeAccount.homeToken(for: url) else { throw LoginBillingError(code: "internal") }
        homeSession = session
        await completeServerLogin(token: token, sessionId: session.sessionId)
    }

    /// 通知トークンが変わった時と前面に戻る時: 間隔が来ていれば証明し直す。確定した401だけがログインへ戻し、それ以外は理由を診断へ残してトークンを保つ。
    func reproveHome() async {
        guard homeProbe != nil, api.sessionToken != nil else { return }
        do { if let session = try await storeAccount.reproveHome(pushToken: BellNotifications.shared.pushToken) { homeSession = session } }
        catch let error as LoginBillingError where error.status == 401 { requireLogin() }
        catch { api.diagnostics.report(error, path: "/api/home/session/prove", method: "POST", observation: .write) }
    }

    private func completeServerLogin(token: String, sessionId: String?) async {
        api.sessionToken = token
        sessionID = sessionId
        publishShareCredentials()
        serverLogin = nil
        homeLogin = nil
        phase = .checking
        await bootstrap()
    }

    private func retryBootstrapSoon() {
        serverPreparing = true
        phase = .checking
        let delay = preparingDelay
        preparingDelay = min(preparingDelay * 2, 30)
        preparingTask?.cancel()
        preparingTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard !Task.isCancelled else { return }
            await self?.bootstrap()
        }
    }

    func requireLogin(for error: Error) {
        if case BellAPIError.accessLoginRequired = error { authMode = "cloudflare" }
        openLoginAutomatically = authMode == "cloudflare"
        requireLogin()
    }

    func signOut() async {
        foregroundTask?.cancel()
        foregroundTask = nil
        stopEvents()
        billing.stop()
        await BellNotifications.shared.detach()
        chatReturnTab = nil
        chatPath = []
        for draft in drafts.values { draft.clear() }
        drafts.removeAll()
        botEditorDrafts.removeAll()
        clearConversationPages()
        profileImageDrafts.removeAll()
        pendingBotDeletionIDs.removeAll()
        terminals = TerminalDirectory()
        resetAIControl()
        updates.reset()
        updatePresented = false
        notificationSecret = nil
        pendingNotification = nil
        // 自分のセッションを終える（本体は次の要求で401）。届かなくてもトークンは消す。理由は診断へ。
        if homeProbe != nil, api.sessionToken != nil {
            // ホームのセッションはライブラリのendHomeSessionで終える（ライブラリのsignOutは終えない）。
            do { try await storeAccount.endHome() }
            catch { api.diagnostics.report(error, path: "/api/home/sessions", method: "DELETE", observation: .write) }
        } else if let sessionID, api.sessionToken != nil {
            do { try await api.delete("/api/sessions/\(sessionID)") }
            catch { api.diagnostics.report(error, path: "/api/sessions", method: "DELETE", observation: .write) }
        }
        api.sessionToken = nil
        self.sessionID = nil
        serverSessions.reset()
        for cookie in api.cookieStorage.cookies ?? [] { api.cookieStorage.deleteCookie(cookie) }
        let store = webDataStore.httpCookieStore
        for cookie in await store.allCookies() { await store.deleteCookie(cookie) }
        publishShareCredentials()
        if authMode == "cloudflare" { phase = .signIn } else { phase = .setup }
    }

    /// 1つの会話を開く経路。通知のタップと相関図のメンバーのタップが使う。
    /// returningToを渡すと、その会話から戻った時（chatPathが空になった時）にそのタブへ帰る。
    func openConversation(_ target: ChatTarget, returningTo tab: Int? = nil) {
        chatReturnTab = nil
        selectedTab = 0
        chatPath = [target]
        chatReturnTab = tab
        eventRevision += 1
    }

    /// 会話の右の「AIと操作」から工程表を開く。iPadは工程表の画面へ移る。Macは呼ぶ側が工程表の窓を開く（窓のLatticeHomeViewが受ける）。
    func openLatticeChart(_ id: String) {
        latticeOpenRequest = id
        #if !targetEnvironment(macCatalyst)
        selectedTab = 5
        #endif
    }

    /// 決裁を開く from a chart's 詳細: the 決裁箱 screen with that decision's 詳細 selected.
    func openApprovals(decision: String? = nil) {
        approvals.openRequest = decision
        if UIDevice.current.userInterfaceIdiom == .phone {
            selectedTab = 0
            approvalsScreenOpen = true
        } else {
            approvalsRequest += 1
        }
    }

    /// 工程表の工程を開く from a 決裁: the chart at that card.
    func openLatticeCard(project: String, card: String?) {
        latticeOpenCard = card
        latticeOpenRequest = project
        if UIDevice.current.userInterfaceIdiom == .phone {
            selectedTab = 4
        } else {
            #if !targetEnvironment(macCatalyst)
            selectedTab = 5
            #endif
        }
    }

    /// The charts that member made (`createdBy`), read once from the chart list for the 「AIと操作」 buttons.
    func latticeCharts(createdBy botId: String) async throws -> [LatticeChartSummary] {
        let list: LatticeChartsList = try await api.get(LatticeChartsModel.path)
        return list.charts.filter { $0.createdBy == botId }
    }

    /// 相関図から開いた会話を戻る操作で閉じた時、その帰り先のタブへ移る。帰り先が無ければfalse。
    /// iPhoneはchatPathが空になった時、縮んだiPadは一覧の列へ戻った時に呼ぶ。
    func returnFromConversation() -> Bool {
        guard let tab = chatReturnTab else { return false }
        chatReturnTab = nil
        selectedTab = tab
        return true
    }

    private func openPendingNotification() async {
        guard case .ready = phase, let route = pendingNotification else { return }
        pendingNotification = nil
        guard route.belongs(to: serverURL) else { return }
        openConversation(route.target)
        if let id = route.requestID {
            do {
                let response: SecretRequestResponse = try await api.get("/api/secret-requests/\(id)")
                if response.request.status == "pending" { notificationSecret = response.request }
                notificationError = nil
                updateConnectionError()
            } catch let error where BellAPIError.isAuthenticationError(error) { pendingNotification = route; requireLogin(for: error) }
            catch {
                notificationError = error.localizedDescription
                updateConnectionError()
            }
        }
    }

    /// タップは画面を開いてGETで確認するだけ。接続先が違う通知は、自動で切り替え・認証・実行をしない。
    func openPendingUpdateNotification() async {
        guard case .ready = phase, let route = pendingUpdateNotification else { return }
        // 別の接続先の通知は開かずに1件だけ残す。利用者がその接続先へ切り替えて認証した後に開く。
        guard route.belongs(to: serverURL) else { return }
        pendingUpdateNotification = nil
        updatePresented = true
        await updates.refresh()
    }

    private func syncCookies(_ supplied: [HTTPCookie]? = nil) async {
        let cookies: [HTTPCookie]
        if let supplied {
            cookies = supplied
        } else {
            cookies = await webDataStore.httpCookieStore.allCookies()
        }
        for cookie in cookies where cookie.name == "CF_Authorization" && !cookie.isExpired && cookieBelongsToServer(cookie) {
            api.cookieStorage.setCookie(cookie)
        }
        publishShareCredentials()
    }

    /// 共有拡張が使う接続先・クッキー・購読の期限を、共有Keychainへ書く（拡張は自分でログインしない）。
    /// 接続先が無い・ログアウト後は消す。書けなければ診断へ出す（拡張は「アプリを開いてログインし直してください」と案内する）。
    func publishShareCredentials() {
        do {
            guard let url = serverURL else { try ShareCredentials.clear(); return }
            let cookies = api.cookieStorage.cookies(for: url)?.filter { $0.name == "CF_Authorization" && !$0.isExpired } ?? []
            let snapshot = ShareCredentials.Snapshot(
                serverURL: url.absoluteString,
                cookieHeader: cookies.isEmpty ? nil : HTTPCookie.requestHeaderFields(with: cookies)["Cookie"],
                cookieExpiresAt: cookies.compactMap(\.expiresDate).min(),
                sessionToken: api.sessionToken,
                entitledUntil: billing.entitlement?.validUntil)
            // 同じ内容は書き直さない（書き直しは消してから足すので、読む側に一瞬の空白ができる）。
            if try ShareCredentials.load() == snapshot { return }
            try ShareCredentials.save(snapshot)
        } catch {
            api.diagnostics.report(error, path: "share-credentials", method: nil, observation: .write)
        }
    }

    private func cookieBelongsToServer(_ cookie: HTTPCookie) -> Bool {
        guard let host = serverURL?.host?.lowercased() else { return false }
        let domain = cookie.domain.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "."))
        return host == domain || host.hasSuffix(".\(domain)")
    }
}

private extension HTTPCookie {
    var isExpired: Bool { expiresDate.map { $0 <= Date() } ?? false }
}

private extension WKHTTPCookieStore {
    func allCookies() async -> [HTTPCookie] {
        await withCheckedContinuation { continuation in
            getAllCookies { continuation.resume(returning: $0) }
        }
    }

    func deleteCookie(_ cookie: HTTPCookie) async {
        await withCheckedContinuation { continuation in
            delete(cookie) { continuation.resume() }
        }
    }
}
