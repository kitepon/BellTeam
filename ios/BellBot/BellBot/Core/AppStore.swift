import Foundation
import WebKit
import OSLog
import SwiftUI

@MainActor
final class AppStore: ObservableObject {
    enum Phase {
        case checking
        case setup
        case onboarding
        case signIn
        case ready
        case failure(String)
    }

    @Published var phase: Phase = .checking
    @Published private(set) var serverURL: URL?
    @Published var setup: SetupResponse?
    @Published var featureSettings: [FeatureSetting] = []
    @Published var authMode = "local"
    var openLoginAutomatically = false
    var routingEnabled: Bool { featureSettings.first { $0.id == "routing" }?.status == "enabled" }
    var notificationsEnabled: Bool { featureSettings.first { $0.id == "notifications" }?.status == "enabled" }
    @Published var bots: [Bot] = []
    @Published var rooms: [Room] = []
    @Published var owner: Owner?
    @Published var eventRevision = 0
    @Published var connectionError: String?
    @Published var selectedTab = 0
    @Published var chatPath: [ChatTarget] = []
    private var drafts: [ChatTarget: ConversationDraft] = [:]
    // 編集値は再認証をまたいで保持する。文字入力でアプリ全体へ更新通知を出さない。
    var botEditorDrafts: [String: BotSettings] = [:]
    @Published var notificationSecret: SecretRequest?
    private var pendingNotification: BellNotificationRoute?

    let api: BellAPI
    let webDataStore: WKWebsiteDataStore
    let billing: BillingStore
    private var eventsTask: Task<Void, Never>?
    private var eventRefreshTask: Task<Void, Never>?
    private var eventRefreshRequested = false
    private var foregroundTask: Task<Void, Never>?
    private var scenePhase: ScenePhase = .inactive
    private var checkingLogin = false

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
        self.webDataStore = webDataStore
        billing = suppliedBilling ?? BillingStore(api: api)
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
        }
        api.diagnostics.configure(serverURL: url)
        BellNotifications.shared.onOpen = { [weak self] route in
            self?.pendingNotification = route
            Task { await self?.openPendingNotification() }
        }
    }

    func setServerAddress(_ address: String) async throws {
        guard let url = ServerOrigin.url(address) else { throw BellAPIError.server("HTTPS、またはlocalhost・LANのHTTP接続先URLを入力してください。") }
        if serverURL != url { botEditorDrafts.removeAll() }
        serverURL = url
        api.baseURL = url
        api.diagnostics.configure(serverURL: url)
        UserDefaults.standard.set(url.absoluteString, forKey: "bellbot.serverURL")
        phase = .checking
        await bootstrap()
    }

    func changeServer() async {
        await signOut()
        UserDefaults.standard.removeObject(forKey: "bellbot.serverURL")
        serverURL = nil
        api.baseURL = nil
        api.diagnostics.configure(serverURL: nil)
        bots = []
        rooms = []
        owner = nil
        setup = nil
        featureSettings = []
        authMode = "local"
        phase = .setup
    }

    func bootstrap() async {
        guard serverURL != nil else { phase = .setup; return }
        await syncCookies()
        do {
            let session: SessionResponse = try await api.get("/api/session")
            authMode = session.authMode
            guard session.authenticated else { throw BellAPIError.unauthorized }
            try await loadInitialState()
        } catch let error where BellAPIError.isAuthenticationError(error) {
            requireLogin(for: error)
        } catch {
            phase = .failure(error.localizedDescription)
        }
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
            try await loadInitialState()
        } catch let error where BellAPIError.isAuthenticationError(error) {
            return
        } catch {
            phase = .failure(error.localizedDescription)
        }
    }

    private func loadInitialState() async throws {
        try await refreshSettings()
        setup = try await api.get("/api/setup")
        guard setup?.phase == "ready" else { phase = .onboarding; return }
        try await enterConversations(openGuide: setup?.complete == false)
    }

    func refreshSettings() async throws {
        let response: FeatureSettingsResponse = try await api.get("/api/settings")
        featureSettings = response.settings
    }

    func refreshSetup() async throws { setup = try await api.get("/api/setup") }

    func chooseHarness(_ harness: String) async throws {
        setup = try await api.post("/api/setup/harness", body: HarnessSelection(harness: harness))
    }

    func submitAuthInput(text: String? = nil, key: String? = nil) async throws {
        setup = try await api.submitAuthenticationInput(AuthInput(text: text, key: key))
    }

    func startGuide() async throws {
        setup = try await api.post("/api/setup/start", body: SetupEmptyBody())
        guard setup?.phase == "ready" else { throw BellAPIError.server("公式認証を完了してから、もう一度確認してください。") }
        try await enterConversations(openGuide: true)
    }

    private func enterConversations(openGuide: Bool) async throws {
        try await refresh()
        phase = .ready
        if openGuide, let guide = setup?.guideBotId { selectedTab = 0; chatPath = [.bot(guide)] }
        startEvents()
        await billing.connect()
        await openPendingNotification()
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

    func activateNotifications() async {
        await BellNotifications.shared.activate(api: api, signedTransaction: billing.notificationSignedTransaction)
    }

    func refresh() async throws {
        async let botResult: BotsResponse = api.get("/api/bots?avatar=omit")
        async let roomResult: RoomsResponse = api.get("/api/rooms?avatar=omit")
        async let ownerResult: OwnerResponse = api.get("/api/owner?avatar=omit")
        var (bots, rooms, owner) = try await (botResult, roomResult, ownerResult)
        let oldBots = Dictionary(uniqueKeysWithValues: self.bots.map { ($0.id, $0) })
        let oldRooms = Dictionary(uniqueKeysWithValues: self.rooms.map { ($0.id, $0) })
        for index in bots.bots.indices {
            let bot = bots.bots[index]
            bots.bots[index].avatar = try await avatar(bot.avatar, version: bot.avatarVersion,
                previous: oldBots[bot.id]?.avatar, previousVersion: oldBots[bot.id]?.avatarVersion,
                path: "/api/bots/\(bot.id)/avatar", botID: bot.id)
        }
        for index in rooms.rooms.indices {
            let room = rooms.rooms[index]
            rooms.rooms[index].avatar = try await avatar(room.avatar, version: room.avatarVersion,
                previous: oldRooms[room.id]?.avatar, previousVersion: oldRooms[room.id]?.avatarVersion,
                path: "/api/rooms/\(room.id)/avatar")
        }
        owner.owner.avatar = try await avatar(owner.owner.avatar, version: owner.owner.avatarVersion,
            previous: self.owner?.avatar, previousVersion: self.owner?.avatarVersion, path: "/api/owner/avatar")
        try Task.checkCancellation()
        self.bots = bots.bots
        self.rooms = rooms.rooms
        self.owner = owner.owner
        if let server = serverURL?.absoluteString {
            do {
                try BotAvatarCache.shared.storeVersioned(bots.bots.map { (id: $0.id, dataURL: $0.avatar, version: $0.avatarVersion) }, server: server)
            } catch {
                Logger(subsystem: "app.bellteam.bellbot", category: "notifications")
                    .error("通知アバターの保存に失敗: \(error.localizedDescription, privacy: .private)")
                api.diagnostics.reportPush(error, stage: "avatar_cache")
            }
        }
    }

    private func avatar(_ inline: String, version: String?, previous: String?, previousVersion: String?, path: String, botID: String? = nil) async throws -> String {
        // 版を持たない既存の応答は、これまでの画像本体をそのまま使う。
        guard let version else { return inline }
        if version.isEmpty { return "" }
        if !inline.isEmpty { return inline }
        if version == previousVersion, let previous { return previous }
        if let botID, let server = serverURL?.absoluteString,
           let cached = try BotAvatarCache.shared.dataURL(botID: botID, server: server, version: version) { return cached }
        return try await api.avatar(path + "?v=" + version)
    }

    func requestRefreshFromEvent() {
        eventRefreshRequested = true
        guard eventRefreshTask == nil else { return }
        eventRefreshTask = Task { [weak self] in
            guard let self else { return }
            defer { if !Task.isCancelled { eventRefreshTask = nil } }
            while eventRefreshRequested && !Task.isCancelled {
                eventRefreshRequested = false
                await refreshFromView()
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

    func deleteRoom(_ id: String) async throws {
        try await api.delete("/api/rooms/\(id)")
        applyDeletedRoom(id)
    }

    func applyDeletedRoom(_ id: String) {
        rooms.removeAll { $0.id == id }
        chatPath.removeAll { $0 == .room(id) }
        removeDraft(for: .room(id))
    }

    func refreshFromView() async {
        do { try await refresh(); await billing.refreshFromServer() }
        catch is CancellationError { return }
        catch let error as URLError where error.code == .cancelled { return }
        catch let error where BellAPIError.isAuthenticationError(error) { requireLogin(for: error) }
        catch { connectionError = error.localizedDescription }
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
                await refreshFromView()
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
                    try await api.events { [weak self] type in
                        guard let self else { return }
                        if type == "settings" { try await self.refreshSettings() }
                        if type == "setup" { try await self.refreshSetup() }
                        self.connectionError = nil
                        self.eventRevision += 1
                        self.requestRefreshFromEvent()
                    }
                    if Task.isCancelled { return }
                    connectionError = "更新の接続が切れました。再接続しています。"
                } catch let error where BellAPIError.isAuthenticationError(error) {
                    if !Task.isCancelled { requireLogin(for: error) }
                    return
                } catch BellAPIError.httpStatus(let status, _) where status == 429 || status >= 500 {
                    if Task.isCancelled { return }
                    connectionError = "更新へ接続できません。再接続しています。"
                } catch let error as URLError {
                    if Task.isCancelled { return }
                    // 切断1回は想定内。連続して失敗が続く時だけ、その連続を1件として報告する。
                    failures += 1
                    if failures == Self.eventsFailureReportThreshold { api.diagnostics.report(error, path: "/api/events", method: "GET", elapsedMilliseconds: BellDiagnostics.elapsedMilliseconds(since: requestStarted)) }
                    connectionError = "更新へ接続できません。再接続しています。"
                } catch {
                    if Task.isCancelled { return }
                    connectionError = error.localizedDescription
                    return
                }
                if Date().timeIntervalSince(connectedAt) > 30 { reconnectDelay = 1_000_000_000; failures = 0 }
                do { try await Task.sleep(nanoseconds: reconnectDelay) }
                catch { return }
                reconnectDelay = min(reconnectDelay * 2, 30_000_000_000)
            }
        }
    }

    func stopEvents() {
        eventsTask?.cancel()
        eventsTask = nil
        eventRefreshTask?.cancel()
        eventRefreshTask = nil
        eventRefreshRequested = false
    }

    func requireLogin() {
        foregroundTask?.cancel()
        foregroundTask = nil
        stopEvents()
        connectionError = nil
        phase = authMode == "cloudflare" ? .signIn : .failure("接続先が認証を拒否しました。サーバーの設定を確認してください。")
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
        chatPath = []
        for draft in drafts.values { draft.clear() }
        drafts.removeAll()
        botEditorDrafts.removeAll()
        notificationSecret = nil
        pendingNotification = nil
        for cookie in api.cookieStorage.cookies ?? [] { api.cookieStorage.deleteCookie(cookie) }
        let store = webDataStore.httpCookieStore
        for cookie in await store.allCookies() { await store.deleteCookie(cookie) }
        if authMode == "cloudflare" { phase = .signIn } else { phase = .setup }
    }

    private func openPendingNotification() async {
        guard case .ready = phase, let route = pendingNotification else { return }
        pendingNotification = nil
        guard route.belongs(to: serverURL) else { return }
        selectedTab = 0
        chatPath = [route.target]
        eventRevision += 1
        if let id = route.requestID {
            do {
                let response: SecretRequestResponse = try await api.get("/api/secret-requests/\(id)")
                if response.request.status == "pending" { notificationSecret = response.request }
            } catch let error where BellAPIError.isAuthenticationError(error) { pendingNotification = route; requireLogin(for: error) }
            catch { connectionError = error.localizedDescription }
        }
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
