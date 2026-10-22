import Foundation
import WebKit
import OSLog
import SwiftUI
import Combine

private enum EventResource: Hashable {
    case all, bots, rooms, owner, queue
}

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
    @Published private(set) var pendingBotDeletionIDs: Set<String> = []
    @Published var rooms: [Room] = []
    @Published var owner: Owner?
    @Published var eventRevision = 0
    let conversationChanges = PassthroughSubject<ChatTarget, Never>()
    let scheduleChanges = PassthroughSubject<Set<ChatTarget>, Never>()
    @Published var workingBotIDs: Set<String> = []
    @Published private(set) var aiControl: AIControl?
    @Published private(set) var aiControlLoading = false
    @Published private(set) var aiControlUpdating = false
    @Published private(set) var aiControlError: String?
    @Published var connectionError: String?
    private var refreshError: String?
    private var eventsError: String?
    private var notificationError: String?
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
    private var eventRefreshResources: Set<EventResource> = []
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
        if serverURL != url {
            botEditorDrafts.removeAll()
            pendingBotDeletionIDs.removeAll()
            resetAIControl()
        }
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
        pendingBotDeletionIDs.removeAll()
        rooms = []
        workingBotIDs = []
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
            api.diagnostics.report(error, path: "/api/session", method: "GET", observation: .startup)
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
            api.diagnostics.report(error, path: "/api/session", method: "GET", observation: .startup)
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
        if featureSettings != response.settings { featureSettings = response.settings }
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

    private func resetAIControl() {
        aiControlEpoch += 1
        aiControlReadSequence += 1
        aiControl = nil
        aiControlLoading = false
        aiControlUpdating = false
        aiControlRefreshPending = false
        aiControlError = nil
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
        async let queueResult: QueueResponse = api.get("/api/queue")
        let (bots, rooms, owner, queue) = try await (botResult, roomResult, ownerResult, queueResult)
        async let resolvedBots = withResolvedBotAvatars(bots.bots)
        async let resolvedRooms = withResolvedRoomAvatars(rooms.rooms)
        async let resolvedOwner = withResolvedOwnerAvatar(owner.owner)
        let (botList, roomList, ownerValue) = try await (resolvedBots, resolvedRooms, resolvedOwner)
        try Task.checkCancellation()
        applyFetchedBots(botList)
        if self.rooms != roomList { self.rooms = roomList }
        if self.owner != ownerValue { self.owner = ownerValue }
        applyFetchedQueue(queue.items)
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

    private func applyFetchedQueue(_ items: [QueueItem]) {
        let runningBotIDs = Set(items.filter { $0.status == "running" }.compactMap(\.botId))
        if workingBotIDs != runningBotIDs { workingBotIDs = runningBotIDs }
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
        eventRefreshResources.formUnion(resources)
        guard eventRefreshTask == nil else { return }
        eventRefreshTask = Task { [weak self] in
            guard let self else { return }
            defer { if !Task.isCancelled { eventRefreshTask = nil } }
            while !eventRefreshResources.isEmpty && !Task.isCancelled {
                let resources = eventRefreshResources
                eventRefreshResources.removeAll()
                if resources.contains(.all) { await refreshFromView(refreshSubscription: false) }
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

    // DELETEの202は受付だけ。成功した一覧読取で消失を確認してから画面を片付ける。
    func requestBotDeletion(_ id: String) async throws {
        try await api.delete("/api/bots/\(id)")
        if bots.contains(where: { $0.id == id }) { pendingBotDeletionIDs.insert(id) }
    }

    func confirmBotDeletion(_ id: String) async throws -> Bool {
        try await refresh()
        refreshError = nil
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

    func refreshFromView(refreshSubscription: Bool = true) async {
        do {
            try await refresh()
            refreshError = nil
            updateConnectionError()
            if refreshSubscription { await billing.refreshFromServer() }
        }
        catch is CancellationError { return }
        catch let error as URLError where error.code == .cancelled { return }
        catch let error where BellAPIError.isAuthenticationError(error) { requireLogin(for: error) }
        catch {
            refreshError = error.localizedDescription
            updateConnectionError()
            api.diagnostics.report(error, path: "/api/bots", method: "GET", observation: .read(error, retainedData: !bots.isEmpty || !rooms.isEmpty))
        }
    }

    private func getForEvent<T: Decodable>(_ needed: Bool, path: String) async throws -> T? {
        guard needed else { return nil }
        return try await api.get(path)
    }

    private func refreshResourcesFromEvent(_ resources: Set<EventResource>) async {
        do {
            async let bots: BotsResponse? = getForEvent(resources.contains(.bots), path: "/api/bots?avatar=omit")
            async let rooms: RoomsResponse? = getForEvent(resources.contains(.rooms), path: "/api/rooms?avatar=omit")
            async let owner: OwnerResponse? = getForEvent(resources.contains(.owner), path: "/api/owner?avatar=omit")
            async let queue: QueueResponse? = getForEvent(resources.contains(.queue), path: "/api/queue")
            let (botResponse, roomResponse, ownerResponse, queueResponse) = try await (bots, rooms, owner, queue)
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
            if let queueResponse { applyFetchedQueue(queueResponse.items) }
        } catch is CancellationError { return }
        catch let error as URLError where error.code == .cancelled { return }
        catch let error where BellAPIError.isAuthenticationError(error) { requireLogin(for: error) }
        catch {
            refreshError = error.localizedDescription
            updateConnectionError()
            api.diagnostics.report(error, path: "/api/bots", method: "GET",
                                   observation: .read(error, retainedData: !bots.isEmpty || !rooms.isEmpty))
        }
    }

    private func updateConnectionError() {
        let next = eventsError ?? refreshError ?? notificationError
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
                await refreshFromView()
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
                            self.eventRevision += 1
                            self.requestRefreshFromEvent()
                        case "settings": try await self.refreshSettings()
                        case "setup": try await self.refreshSetup()
                        case "ai-control": await self.refreshAIControl()
                        case "bots": self.requestRefreshFromEvent()
                        case "messages":
                            switch event.scope {
                            case .all:
                                self.eventRevision += 1
                                self.requestRefreshFromEvent()
                            case .targeted(let topics, let botIDs, let roomIDs):
                                if self.refreshError != nil {
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
                    eventsError = error.localizedDescription
                    updateConnectionError()
                    api.diagnostics.report(error, path: "/api/events", method: "GET", observation: .read(error, retainedData: !bots.isEmpty || !rooms.isEmpty))
                    return
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
        if topics.contains(.settings) { try await refreshSettings() }
        if topics.contains(.setup) { try await refreshSetup() }
        if topics.contains(.aiControl) { await refreshAIControl() }
        var resources: Set<EventResource> = []
        if !topics.isDisjoint(with: [.timeline, .requests, .questions]) {
            if !botIDs.isEmpty { resources.insert(.bots) }
            if !roomIDs.isEmpty { resources.insert(.rooms) }
        }
        if topics.contains(.bots) { resources.insert(.bots) }
        if topics.contains(.rooms) { resources.insert(.rooms) }
        if topics.contains(.owner) { resources.insert(.owner) }
        if topics.contains(.queue) { resources.insert(.queue) }
        if !resources.isEmpty { requestRefreshFromEvent(resources: resources) }
    }

    func stopEvents() {
        eventsTask?.cancel()
        eventsTask = nil
        eventRefreshTask?.cancel()
        eventRefreshTask = nil
        eventRefreshResources.removeAll()
    }

    func requireLogin() {
        foregroundTask?.cancel()
        foregroundTask = nil
        stopEvents()
        resetAIControl()
        refreshError = nil
        eventsError = nil
        notificationError = nil
        updateConnectionError()
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
        pendingBotDeletionIDs.removeAll()
        resetAIControl()
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
                notificationError = nil
                updateConnectionError()
            } catch let error where BellAPIError.isAuthenticationError(error) { pendingNotification = route; requireLogin(for: error) }
            catch {
                notificationError = error.localizedDescription
                updateConnectionError()
            }
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
