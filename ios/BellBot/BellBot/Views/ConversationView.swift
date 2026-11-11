import PhotosUI
import UniformTypeIdentifiers
import SwiftUI
import UIKit

// 読直しメソッドの分岐だけを表す。HTTP GETの実試行・成功は示さない。
enum ConversationLoadCallResult: String {
    case skippedSceneInactive = "skipped_scene_inactive"
    case skippedAwaitingSend = "skipped_awaiting_send"
    case joinedReaderReturned = "joined_reader_returned"
    case startedReaderReturned = "started_reader_returned"
}

struct SendFailureReconcileObservation {
    enum Decision: String {
        case skippedAppInactive = "skipped_app_inactive"
        case skippedKnownResult = "skipped_known_result"
        case calledLoad = "called_load"
    }

    let decision: Decision
    let loadResult: ConversationLoadCallResult?

    var log: String {
        "send_reconcile_decision=\(decision.rawValue)"
            + "\nsend_reconcile_load_calls=\(loadResult == nil ? 0 : 1)"
            + "\nsend_reconcile_load_result=\(loadResult?.rawValue ?? "not_called")"
    }

    @MainActor
    static func observe(error: Error, appActive: Bool,
                        load: () async -> ConversationLoadCallResult) async -> Self {
        guard appActive else { return Self(decision: .skippedAppInactive, loadResult: nil) }
        guard BellAPIError.operationResultUnconfirmed(error) else {
            return Self(decision: .skippedKnownResult, loadResult: nil)
        }
        return Self(decision: .calledLoad, loadResult: await load())
    }
}

struct ConversationView: View {
    let target: ChatTarget

    var body: some View {
        ConversationContent(target: target).id(target)
    }
}

private struct ConversationContent: View {
    let target: ChatTarget

    @EnvironmentObject private var store: AppStore
    @Environment(\.scenePhase) private var scenePhase
    @State private var timeline = ConversationTimelineState()
    @State private var awaitingSendResponse = false
    @State private var queue: [QueueItem] = []
    @State private var hasMore = false
    @State private var loading = true
    @State private var loadingOlder = false
    @State private var reader = ReadCoordinator()
    @State private var olderTask: Task<Void, Never>?
    @State private var sending = false
    @State private var stoppingBotID: String?
    @State private var stopNotice: StopNotice?
    private var draft: String {
        get { store.draft(for: target).text }
        nonmutating set { store.draft(for: target).setTextExternally(newValue) }
    }
    @State private var choosingFile = false
    @State private var selectedPhotos: [PhotosPickerItem] = []
    @State private var visibleAttachments: [PendingImage] = []
    private var attachments: [PendingImage] {
        get { visibleAttachments }
        nonmutating set {
            store.draft(for: target).attachments = newValue
            visibleAttachments = newValue
        }
    }
    @State private var selectedTargets: Set<String> = []
    @State private var errorText: String?
    @State private var initialLoadFailed = false
    #if !targetEnvironment(macCatalyst)
    @State private var showingDetail = false
    #endif
    @State private var exportDocument: ConversationDocument?
    @State private var showingExport = false
    @State private var exporting = false
    @State private var isAtBottom = true
    @State private var hasUnreadMessages = false
    @State private var scrollToBottomRevision = 0
    @State private var cards = ConversationCardStates()
    @State private var presentedSheet: ConversationSheet?
    @State private var presentedGallery: ConversationGallery?
    @AppStorage(ConversationOpening.storageKey) private var opening = ConversationOpening.rise

    private var messages: [TimelineMessage] { timeline.visibleMessages }

    private var bot: Bot? { store.bots.first { $0.id == target.id } }
    private var room: Room? { store.rooms.first { $0.id == target.id } }
    private var title: String { target.isRoom ? (room?.name ?? "ルーム") : (bot?.displayName ?? "メンバー") }
    private var avatar: String { target.isRoom ? (room?.avatar ?? "") : (bot?.avatar ?? "") }
    private var accent: Color { target.isRoom ? BellTheme.violet : BellTheme.accent(bot?.color ?? "violet") }
    private var appIsActive: Bool { UIApplication.shared.applicationState == .active }

    var body: some View {
        let botsByID: [String: Bot] = target.isRoom
            ? Dictionary(store.bots.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
            : [:]
        let messagesByID = Dictionary(messages.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let selectedBot = bot
        let rowContext = (target.isRoom ? (room?.memberIds ?? []).compactMap { botsByID[$0] } : [selectedBot].compactMap { $0 })
            .map(ConversationRowContext.init)
        return ZStack {
            if loading && messages.isEmpty {
                ProgressView().padding(.top, 90)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            } else if messages.isEmpty && queue.isEmpty {
                Group { if initialLoadFailed { failedConversation } else { emptyConversation } }
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            } else {
                ConversationList(messages: messages, queue: queue, rowContext: rowContext,
                                 hasMore: hasMore, loading: loading, loadingOlder: loadingOlder,
                                 bottomInset: 18 + (attachments.isEmpty ? 0 : attachmentStripHeight),
                                 opening: opening, scrollToBottomRevision: scrollToBottomRevision,
                                 onLoadOlder: { olderTask = Task { await loadOlder() } },
                                 onRefresh: { await load() },
                                 onAtBottomChange: { atBottom in
                                     isAtBottom = atBottom
                                     if atBottom { hasUnreadMessages = false }
                                 }) { row in
                    Group {
                        switch row {
                        case .message(let id):
                            if let message = messagesByID[id] {
                                timelineRow(message, selectedBot: selectedBot, botsByID: botsByID)
                            }
                        case .queue:
                            queueStrip
                        }
                    }
                    .environmentObject(store)
                }
            }
        }
        .overlay(alignment: .top) {
            if loadingOlder { ProgressView().padding(.top, 12) }
        }
        // 過去を読んでいる間は、新着が無くても最新へ戻れるようにする。本文に重ねず、入力欄の上の帯に置く。
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if hasUnreadMessages || (!isAtBottom && !loading) {
                Button {
                    hasUnreadMessages = false
                    scrollToBottomRevision += 1
                } label: {
                    Label(hasUnreadMessages ? "新着メッセージ" : "最新へ", systemImage: "arrow.down")
                }
                .font(BellTheme.messageHelperFont.weight(.semibold))
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .padding(.vertical, 6)
                .frame(maxWidth: .infinity)
                .background(.regularMaterial)
                .overlay(alignment: .top) { Divider() }
                .accessibilityIdentifier("scroll-to-latest")
            }
        }
        .onChange(of: store.eventRevision) { _, _ in
            if appIsActive { Task { await load() } }
        }
        .onReceive(store.conversationChanges) { changedTarget in
            if changedTarget == target && appIsActive { Task { await load() } }
        }
        .sheet(item: $presentedSheet) { sheet in
            switch sheet {
            case .peer(let message):
                PeerMessageSheet(message: message, api: store.api)
            case .secret(let request, let state):
                SecretInputSheet(request: request) { state.result = $0 }
                    .environmentObject(store)
            }
        }
        .fullScreenCover(item: $presentedGallery) { gallery in
            MessageImageGallery(paths: gallery.paths, api: store.api)
        }
        // 背景をZStackの子にすると、iPad横画面では入力欄もキーボードの安全領域へ広がる。
        .background { BellBackground() }
        .safeAreaInset(edge: .bottom, spacing: 0) { composer }
        // The header line: the nav bar is too narrow for the reason, so it sits right under it and may wrap.
        .safeAreaInset(edge: .top, spacing: 0) {
            if !target.isRoom, let line = bot?.seatLaunch?.line {
                SeatLaunchLine(text: line, size: BellTheme.listDetailFontSize + 1, lines: 3)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16).padding(.vertical, 6)
                    .background(.regularMaterial)
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.visible, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .principal) {
                HStack(spacing: 10) {
                    AvatarView(name: title, avatar: avatar, color: accent, size: 34, isRoom: target.isRoom)
                    VStack(alignment: .leading, spacing: 1) {
                        HStack(spacing: 6) {
                            Text(title)
                                .font(.system(size: BellTheme.listNameFontSize + 2, weight: .bold, design: .rounded))
                                .foregroundStyle(BellTheme.ink)
                                .lineLimit(1)
                            if bot?.fastMode == true { BotFastModeBadge() }
                        }
                        Text(target.isRoom ? "\(room?.memberIds.count ?? 0)人のルーム" : (bot?.online == true ? "オンライン" : "オフライン"))
                            .font(.system(size: BellTheme.listDetailFontSize))
                            .foregroundStyle(BellTheme.muted)
                    }
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button { Task { await exportConversation() } } label: { Image(systemName: "square.and.arrow.up") }
                    .accessibilityLabel("会話を書き出す")
                    .accessibilityIdentifier("conversation-export")
                    .disabled(exporting)
            }
            #if !targetEnvironment(macCatalyst)
            ToolbarItem(placement: .topBarTrailing) {
                Button { showingDetail = true } label: { Image(systemName: "ellipsis.circle") }
                    .accessibilityLabel("詳細")
            }
            #endif
        }
        #if !targetEnvironment(macCatalyst)
        .sheet(isPresented: $showingDetail) {
            ConversationDetailView(target: target)
                .environmentObject(store)
                .presentationDetents([.medium, .large])
        }
        #endif
        .fileExporter(isPresented: $showingExport, document: exportDocument, contentType: .json,
                      defaultFilename: "BellTeam-\(target.id)") { result in
            if case .failure(let error) = result { errorText = error.localizedDescription }
        }
        .task(id: scenePhase) { if scenePhase == .active { await load() } }
        .onChange(of: scenePhase) { _, next in
            if next != .active {
                reader.task?.cancel()
                reader.task = nil
                reader.again = false
                reader.generation += 1
                olderTask?.cancel()
                loading = false
                loadingOlder = false
            }
        }
        .onAppear {
            visibleAttachments = store.draft(for: target).attachments
            selectedTargets = store.draft(for: target).selectedTargets
            BellNotifications.shared.visibleConversation = target
        }
        .onChange(of: selectedTargets) { _, next in store.draft(for: target).selectedTargets = next }
        .onDisappear {
            reader.task?.cancel()
            reader.task = nil
            reader.again = false
            reader.generation += 1
            olderTask?.cancel()
            if BellNotifications.shared.visibleConversation == target { BellNotifications.shared.visibleConversation = nil }
        }
        #if targetEnvironment(macCatalyst)
        .fileImporter(isPresented: $choosingFile, allowedContentTypes: [.image], allowsMultipleSelection: true) { result in
            do { try attachImageFiles(result.get()) }
            catch { errorText = "画像を読み込めませんでした。" }
        }
        #endif
        .dropDestination(for: URL.self) { urls, _ in
            do { try attachImageFiles(urls); return !urls.isEmpty }
            catch { errorText = "画像を読み込めませんでした。"; return false }
        }
        .onChange(of: selectedPhotos) { _, items in
            guard !items.isEmpty else { return }
            Task { await loadPhotos(items) }
        }
    }

    private func timelineRow(_ message: TimelineMessage, selectedBot: Bot?, botsByID: [String: Bot]) -> some View {
        let senderBot = (message.sender?.id).flatMap { botsByID[$0] }
        let label = replyLabel(for: message, botsByID: botsByID)
        return Group {
            if let request = message.secretRequest {
                let state = cards.secretState(for: message.id)
                SecretRequestCard(request: request, state: state) { presentedSheet = .secret(request, state) }
            } else if let question = message.ownerQuestion {
                OwnerQuestionCard(question: question, state: cards.questionState(for: message.id))
            } else {
                MessageRow(message: message, isRoom: target.isRoom, bot: selectedBot,
                           senderBot: senderBot, replyLabel: label, api: store.api,
                           onOpenPeer: { presentedSheet = .peer(message) },
                           onOpenImages: { presentedGallery = ConversationGallery(paths: $0) })
                    .equatable()
            }
        }
    }

    private func replyLabel(for message: TimelineMessage, botsByID: [String: Bot]) -> String? {
        guard target.isRoom, let routing = message.routing else { return nil }
        switch routing.status {
        case "pending": return "返信者を判定中"
        case "failed": return "返信者の判定に失敗"
        case "ready":
            let names = routing.responders.map { botsByID[$0]?.displayName ?? $0 }
            return "返信: \(names.isEmpty ? "なし" : names.joined(separator: "、"))"
        default: return nil
        }
    }

    private func exportConversation() async {
        exporting = true
        defer { exporting = false }
        do {
            let kind = target.isRoom ? "rooms" : "bots"
            exportDocument = ConversationDocument(data: try await store.api.exportConversation("/api/\(kind)/\(target.id)/export"))
            showingExport = true
        } catch {
            errorText = error.localizedDescription
            store.api.diagnostics.report(error, path: target.path + "/messages", method: "GET", observation: .read(error, retainedData: !messages.isEmpty))
        }
    }

    private var emptyConversation: some View {
        VStack(spacing: 13) {
            AvatarView(name: title, avatar: avatar, color: accent, size: 72, isRoom: target.isRoom)
            Text("\(title)と話しましょう")
                .font(.headline)
                .foregroundStyle(BellTheme.ink)
            Text("最初のメッセージを送ってみてね。")
                .font(.subheadline)
                .foregroundStyle(BellTheme.muted)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 100)
    }

    private var failedConversation: some View {
        ContentUnavailableView {
            Label("会話を読み込めませんでした", systemImage: "wifi.exclamationmark")
        } description: {
            Text("再読み込みしてください。")
        } actions: {
            Button("再読み込み") { Task { await loadInitial() } }
        }
        .padding(.top, 60)
    }

    private var queueStrip: some View {
        let displayItems = QueueItem.displayItems(queue)
        return VStack(alignment: .leading, spacing: 9) {
            ForEach(displayItems) { item in
                HStack(spacing: 9) {
                    ProgressView().controlSize(.mini)
                    Text("\(item.botName ?? title) · \(item.status == "queued" ? "送信待ち" : "処理中")")
                        .font(BellTheme.messageHelperFont.weight(.medium))
                    Spacer()
                    if target.isRoom, isStopRow(item, in: displayItems), let id = item.botId {
                        Button(stoppingBotID == id ? "停止中…" : "止める") {
                            Task { await stopBot(id, name: item.botName ?? title) }
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .disabled(stoppingBotID != nil)
                        .accessibilityLabel("\(item.botName ?? title)の今の動作を止める")
                        .accessibilityIdentifier("stop-bot-\(id)")
                    }
                }
            }
        }
        .foregroundStyle(BellTheme.violet)
        .padding(14)
        .frame(maxWidth: .infinity)
        .background(BellTheme.violetLight.opacity(0.65), in: RoundedRectangle(cornerRadius: 16))
    }

    private func isStopRow(_ item: QueueItem, in displayItems: [QueueItem]) -> Bool {
        guard let id = item.botId, ["running", "queued"].contains(item.status) else { return false }
        guard target.isRoom, room?.memberIds.contains(id) == true else { return false }
        return displayItems.first {
            $0.botId == id && ["running", "queued"].contains($0.status)
        }?.id == item.id
    }

    private var currentBotCanStop: Bool {
        guard case .bot(let id) = target else { return false }
        return queue.contains { $0.botId == id && ["running", "queued"].contains($0.status) }
    }

    private func stopNoticeView(_ notice: StopNotice) -> some View {
        Text(notice.message)
            .font(BellTheme.messageHelperFont)
            .foregroundStyle(notice.isError ? Color.red : BellTheme.violet)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .background(BellTheme.violetLight.opacity(0.65), in: RoundedRectangle(cornerRadius: 16))
    }

    private func stopBot(_ id: String, name: String) async {
        guard stoppingBotID == nil else { return }
        stoppingBotID = id
        stopNotice = nil
        defer { stoppingBotID = nil }
        do {
            let outcome = try await store.api.stopBot(id)
            stopNotice = outcome == .sent ? .sent : .confirmed(name)
            await load()
            await store.refreshFromView(origin: .conversationStop)
        } catch let error where BellAPIError.isAuthenticationError(error) {
            store.requireLogin(for: error)
        } catch {
            stopNotice = error is CancellationError || BellAPIError.operationResultUnconfirmed(error)
                ? .unconfirmed : .failed(error.localizedDescription)
            store.api.diagnostics.report(error, path: "/api/bots/\(id)/stop", method: "POST", observation: .write)
            await load()
        }
    }

    private enum StopNotice {
        case sent
        case confirmed(String)
        case unconfirmed
        case failed(String)

        var message: String {
            switch self {
            case .sent: "停止操作を送りました。会話は続けられます。"
            case .confirmed(let name): "\(name)は今、処理を実行していません。同じ会話で新しい依頼を続けられます。"
            case .unconfirmed: "停止操作の結果を確認できませんでした。状況を確認してから操作してください。"
            case .failed(let reason): reason
            }
        }

        var isError: Bool {
            switch self {
            case .sent, .confirmed: false
            case .unconfirmed, .failed: true
            }
        }
    }

    private var composer: some View {
        VStack(spacing: 8) {
            if let room { targetPicker(room) }
            if case .bot(let id) = target { ChatGoalBar(botId: id) }
            ConversationInput(draft: store.draft(for: target), sending: sending, hasAttachments: !attachments.isEmpty,
                              onSend: { Task { await send() } },
                              canStop: currentBotCanStop, stopping: stoppingBotID != nil,
                              onStop: { if case .bot(let id) = target { Task { await stopBot(id, name: title) } } },
                              onPasteImages: { attachments.append(contentsOf: $0) },
                              onPasteFailure: { errorText = $0 }) {
                #if targetEnvironment(macCatalyst)
                Button { choosingFile = true } label: {
                    Image(systemName: "paperclip").font(.system(size: 20))
                        .foregroundStyle(BellTheme.violet)
                        .frame(width: 40, height: 40)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("画像を添付")
                .help("画像ファイルを添付。ここへドロップ、入力欄へ貼り付けもできます")
                #else
                PhotosPicker(selection: $selectedPhotos, matching: .images) {
                    Image(systemName: "plus")
                        .font(.system(size: 20, weight: .medium))
                        .foregroundStyle(BellTheme.violet)
                        .frame(width: 40, height: 40)
                }
                .accessibilityLabel("画像を添付")
                #endif
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .background(BellTheme.canvas, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 24).strokeBorder(BellTheme.line))
        }
        .padding(.horizontal, 15)
        .padding(.top, 11)
        .padding(.bottom, 8)
        .background(.regularMaterial)
        // 失敗の案内と添付画像は入力欄の真上に重ねる。入力欄の高さを変えると、キーボード表示中は
        // 入力欄がキーボードの下へはみ出した（iPhone Simulator、iOS 26）。
        .overlay(alignment: .top) {
            VStack(spacing: 8) {
                if let stopNotice { stopNoticeView(stopNotice) }
                if let errorText {
                    Text(errorText)
                        .font(BellTheme.messageHelperFont)
                        .foregroundStyle(.red)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("send-error")
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 15)
                        .padding(.vertical, 8)
                        .background(.regularMaterial)
                }
                if !attachments.isEmpty { attachmentStrip }
            }
            .alignmentGuide(.top) { $0[.bottom] }
        }
    }

    private var attachmentStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                ForEach(Array(attachments.enumerated()), id: \.element.id) { index, attachment in
                    ZStack(alignment: .topTrailing) {
                        Image(uiImage: attachment.preview)
                            .resizable().scaledToFill()
                            .frame(width: 60, height: 60)
                            .clipShape(RoundedRectangle(cornerRadius: 12))
                        Button { attachments.removeAll { $0.id == attachment.id } } label: {
                            Image(systemName: "xmark.circle.fill")
                                .foregroundStyle(.white, BellTheme.ink.opacity(0.75))
                        }
                        .accessibilityLabel("添付画像\(index + 1)を外す")
                        .offset(x: 6, y: -6)
                    }
                }
            }
            .padding(.horizontal, 15)
            .padding(.top, 14)
            .padding(.bottom, 8)
        }
        .frame(height: attachmentStripHeight)
        .background(.regularMaterial)
        .accessibilityIdentifier("attachment-previews")
    }

    private func targetPicker(_ room: Room) -> some View {
        Menu {
            Button("返信者を自動選択", systemImage: selectedTargets.isEmpty ? "checkmark" : "circle") {
                selectedTargets.removeAll()
            }.disabled(!store.routingEnabled)
            ForEach(room.memberIds, id: \.self) { id in
                Button {
                    if selectedTargets.contains(id) { selectedTargets.remove(id) }
                    else { selectedTargets.insert(id) }
                } label: {
                    Label(store.bots.first(where: { $0.id == id })?.displayName ?? id,
                          systemImage: selectedTargets.contains(id) ? "checkmark.circle.fill" : "circle")
                }
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "paperplane")
                Text(targetLabel())
                Image(systemName: "chevron.down").font(.system(size: 10, weight: .bold))
            }
            .font(.system(size: BellTheme.conversationLabelFontSize, weight: .semibold))
            .foregroundStyle(BellTheme.violet)
            .padding(.horizontal, 11)
            .padding(.vertical, 7)
            .background(BellTheme.violetLight.opacity(0.75), in: Capsule())
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func targetLabel() -> String {
        if selectedTargets.isEmpty { return store.routingEnabled ? "返信者を自動選択" : "返信するメンバーを選択" }
        if selectedTargets.count == 1, let id = selectedTargets.first {
            return "返信: \(store.bots.first(where: { $0.id == id })?.name ?? id)"
        }
        return "返信: \(selectedTargets.count)人"
    }

    private let attachmentStripHeight: CGFloat = 82

    private var canSend: Bool { !sending && (store.draft(for: target).hasText || !attachments.isEmpty) }

    @discardableResult
    private func load() async -> ConversationLoadCallResult {
        guard scenePhase == .active else { return .skippedSceneInactive }
        guard !awaitingSendResponse else { return .skippedAwaitingSend }
        if let task = reader.task {
            reader.again = true
            await task.value
            return .joinedReaderReturned
        }
        reader.generation += 1
        let generation = reader.generation
        let task = Task {
            repeat {
                reader.again = false
                if timeline.receivedMessages.isEmpty { await loadInitial() } else { await refresh() }
            } while reader.again && !Task.isCancelled && scenePhase == .active
            if reader.generation == generation { reader.task = nil }
        }
        reader.task = task
        await task.value
        return .startedReaderReturned
    }

    private func loadInitial() async {
        loading = true
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-bellbot-preview-window-state") {
            timeline.replaceReceived(PreviewMessages.statefulItems)
            hasMore = false
            loading = false
            scrollToBottomRevision += 1
            if ProcessInfo.processInfo.arguments.contains("-bellbot-preview-window-state-updates") {
                for addition in PreviewMessages.statefulAdditions {
                    do { try await Task.sleep(for: .milliseconds(200)) }
                    catch { return }
                    timeline.appendReceived(addition)
                    if isAtBottom { scrollToBottomRevision += 1 }
                }
            }
            return
        }
        if ProcessInfo.processInfo.arguments.contains("-bellbot-preview-updating-chat") {
            let performance = ProcessInfo.processInfo.arguments.contains("-bellbot-preview-performance-chat")
            let fixture = performance ? PreviewMessages.performanceItems : PreviewMessages.updatingItems
            let visibleCount = performance ? 97 : 7
            try? await Task.sleep(for: .milliseconds(350))
            timeline.replaceReceived(fixture)
            hasMore = false
            loading = false
            scrollToBottomRevision += 1
            for tick in 0..<100 {
                do { try await Task.sleep(for: .milliseconds(200)) }
                catch { return }
                timeline.replaceReceived(Array(fixture.prefix(visibleCount + tick % 4)))
                if tick.isMultiple(of: 4) { scrollToBottomRevision += 1 }
            }
            return
        }
        if ProcessInfo.processInfo.arguments.contains(where: { $0.hasPrefix("-bellbot-preview") })
            && !ProcessInfo.processInfo.arguments.contains("-bellbot-preview-server") {
            timeline.replaceReceived(PreviewMessages.items(for: target))
            if ProcessInfo.processInfo.arguments.contains("-bellbot-preview-stop") {
                queue = target.isRoom ? [
                    QueueItem(id: "preview-room-running", botId: "bot-one", botName: "ユキ",
                              status: "running", groupId: nil, message: nil),
                    QueueItem(id: "preview-room-queued", botId: "bot-three", botName: "ナギ",
                              status: "queued", groupId: nil, message: nil),
                ] : [
                    QueueItem(id: "preview-bot-running", botId: target.id, botName: title,
                              status: "running", groupId: nil, message: nil),
                ]
            } else { queue = [] }
            hasMore = false
            loading = false
            return
        }
        #endif
        // 前に開いた会話は、取得を待たず前回の頁を出す。
        // サインアウトや接続先の変更の後に届いた応答は、成功も失敗も反映しない。
        let generation = store.conversationGeneration
        let stale = { store.conversationGeneration != generation }
        if let page = store.conversationPages[target] {
            timeline.replaceReceived(page.items)
            hasMore = page.hasMore
        }
        do {
            // 処理待ち一覧の応答を待たず、本文を届いた時点で出す。
            async let waiting: QueueResponse = store.api.get(target.path + "/queue")
            let result: ListResponse<TimelineMessage> = try await store.api.get(target.path + "/messages?limit=\(ConversationHistoryPage.firstPage)")
            try Task.checkCancellation()
            guard !stale(), !awaitingSendResponse else { loading = false; return }
            timeline.replaceReceived(result.items)
            hasMore = result.hasMore
            store.remember(ConversationPage(items: result.items, hasMore: result.hasMore, remainingBefore: result.remainingBefore ?? 0),
                           for: target, generation: generation)
            loading = false
            errorText = nil
            initialLoadFailed = false
            do {
                let queued = try await waiting
                try Task.checkCancellation()
                guard !stale() else { return }
                queue = queued.items
            } catch is CancellationError { return }
            catch let error where BellAPIError.isAuthenticationError(error) {
                if !stale() { store.requireLogin(for: error) }
            }
            catch {
                guard !stale() else { return }
                errorText = error.localizedDescription
                store.api.diagnostics.report(error, path: target.path + "/queue", method: "GET", observation: .read(error, retainedData: true))
            }
        } catch let error where BellAPIError.isAuthenticationError(error) {
            if !stale() { store.requireLogin(for: error) }
        } catch is CancellationError { return }
        catch {
            if stale() || awaitingSendResponse { loading = false; return }
            errorText = error.localizedDescription
            initialLoadFailed = true
            store.api.diagnostics.report(error, path: target.path + "/messages", method: "GET", observation: .read(error, retainedData: !messages.isEmpty))
        }
        loading = false
    }

    private func loadOlder() async {
        guard scenePhase == .active, hasMore, !loading, !loadingOlder, let oldest = messages.first?.id else { return }
        loadingOlder = true
        defer { loadingOlder = false }
        do {
            let path = target.path + "/messages?limit=\(ConversationHistoryPage.pageSize)&before=\(oldest.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? oldest)"
            let result: ListResponse<TimelineMessage> = try await store.api.get(path)
            try Task.checkCancellation()
            hasMore = result.hasMore
            _ = timeline.prependReceived(result.items)
        } catch is CancellationError { }
        catch let error where BellAPIError.isAuthenticationError(error) {
            store.requireLogin(for: error)
        } catch {
            errorText = error.localizedDescription
            store.api.diagnostics.report(error, path: target.path + "/messages", method: "GET", observation: .read(error, retainedData: !messages.isEmpty))
        }
    }

    private func refresh() async {
        guard !loading, appIsActive, !awaitingSendResponse else { return }
        do {
            async let waiting: QueueResponse = store.api.get(target.path + "/queue")
            let latestPath = target.path + "/messages?limit=\(ConversationHistoryPage.firstPage)"
            if let lastId = timeline.receivedMessages.last?.id {
                let encodedId = lastId.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? lastId
                async let latest: ListResponse<TimelineMessage> = store.api.get(latestPath)
                async let after: ListResponse<TimelineMessage> = store.api.get(target.path + "/messages?after=\(encodedId)")
                let (page, additions, queued) = try await (latest, after, waiting)
                try Task.checkCancellation()
                guard !awaitingSendResponse else { return }
                let newMessageCount = timeline.mergeRefresh(latest: page.items, after: additions.items)
                if queue != queued.items { queue = queued.items }
                if newMessageCount > 0 && !isAtBottom { hasUnreadMessages = true }
            } else {
                let page: ListResponse<TimelineMessage> = try await store.api.get(latestPath)
                let queued = try await waiting
                try Task.checkCancellation()
                guard !awaitingSendResponse else { return }
                if queue != queued.items { queue = queued.items }
                timeline.replaceReceived(page.items)
                if hasMore != page.hasMore { hasMore = page.hasMore }
                scrollToBottomRevision += 1
            }
            errorText = nil
            initialLoadFailed = false
        } catch let error where BellAPIError.isAuthenticationError(error) { store.requireLogin(for: error) }
        catch is CancellationError { }
        catch {
            if awaitingSendResponse { return }
            errorText = error.localizedDescription
            if messages.isEmpty { initialLoadFailed = true }
            store.api.diagnostics.report(error, path: target.path + "/messages", method: "GET", observation: .read(error, retainedData: !messages.isEmpty))
        }
    }

    private func restoreUnconfirmedSend(id: String, message: String, images: [PendingImage]) {
        timeline.rejectSend(id: id)
        // 送信中に書き始めた続きは消さず、元の本文の後ろへ残す。
        draft = [message, draft].filter { !$0.isEmpty }.joined(separator: "\n")
        attachments = images + attachments
    }

    // 押した本文は受付前から会話に表示する。応答のIDで正本と結び、同じ本文を二重に置かない。
    private func send() async {
        guard canSend else { return }
        if target.isRoom && selectedTargets.isEmpty && !store.routingEnabled {
            errorText = "返信者の自動選択は未設定です。入力欄の上で返信するメンバーを選んでください。"
            return
        }
        sending = true
        defer { sending = false }
        let message = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let sent = attachments
        let selected = target.isRoom && !selectedTargets.isEmpty ? Array(selectedTargets) : nil
        let pendingID = "local-pending-\(UUID().uuidString)"
        draft = ""
        attachments = []
        errorText = nil
        awaitingSendResponse = true
        timeline.beginSend(id: pendingID, body: message, imageCount: sent.count, at: Date().ISO8601Format())
        hasUnreadMessages = false
        scrollToBottomRevision += 1
        do { try await store.authorizeAIUse(target: target) }
        catch let error where BellAPIError.isAuthenticationError(error) {
            awaitingSendResponse = false
            restoreUnconfirmedSend(id: pendingID, message: message, images: sent)
            store.requireLogin(for: error)
            return
        }
        catch {
            awaitingSendResponse = false
            restoreUnconfirmedSend(id: pendingID, message: message, images: sent)
            if appIsActive { await load() }
            errorText = error.localizedDescription
            store.api.diagnostics.report(error, path: "/api/subscription", method: nil, observation: .read(error, retainedData: true))
            return
        }
        let body = SendMessageBody(
            message: message,
            images: sent.map { ImagePayload(mime: "image/jpeg", data: $0.data.base64EncodedString()) },
            targets: selected
        )
        do {
            let acknowledgement = try await store.api.sendMessage(target.path + "/messages", body: body)
            let acceptedID = try acknowledgement.messageID(for: target)
            timeline.acceptSend(id: pendingID, serverID: acceptedID)
            awaitingSendResponse = false
            if appIsActive {
                await load()
                if appIsActive { await store.refreshFromView(origin: .conversationSend) }
            }
        } catch {
            awaitingSendResponse = false
            restoreUnconfirmedSend(id: pendingID, message: message, images: sent)
            let reconcile = await SendFailureReconcileObservation.observe(error: error,
                appActive: appIsActive) { await load() }
            if BellAPIError.isAuthenticationError(error) { store.requireLogin(for: error) }
            else { errorText = BellAPIError.operationFailureMessage(error) }
            store.api.diagnostics.report(error, path: target.path + "/messages", method: "POST",
                                         observation: .write, diagnosticContext: reconcile.log)
        }
    }

    private func attachImageFiles(_ urls: [URL]) throws {
        attachments.append(contentsOf: try urls.map(PendingImage.init(fileURL:)))
    }

    private func loadPhotos(_ items: [PhotosPickerItem]) async {
        defer { selectedPhotos = [] }
        do {
            for item in items {
                guard let data = try await item.loadTransferable(type: Data.self),
                      let image = PendingImage(data: data) else { throw BellAPIError.invalidResponse }
                attachments.append(image)
            }
        } catch {
            errorText = "画像を読み込めませんでした。"
        }
    }
}

enum ConversationSheet: Identifiable {
    case peer(TimelineMessage)
    case secret(SecretRequest, SecretRequestCardState)

    var id: String {
        switch self {
        case .peer(let message): "peer-\(message.id)"
        case .secret(let request, _): "secret-\(request.id)"
        }
    }
}

private final class ReadCoordinator {
    var task: Task<Void, Never>?
    var again = false
    var generation = 0
}

enum ConversationHistoryPage {
    /// 開いた時と更新時に取る最新の行数。
    static let firstPage = 30
    /// 見えている行より上の読込済みが25行以下になったら、次の25行を足す。
    static let lowStockRows = 25
    static let pageSize = 25
}

/// 行を配置から外しても会話が持ち続けるカードの状態。
private final class ConversationCardStates {
    private var secretStates: [String: SecretRequestCardState] = [:]
    private var questionStates: [String: OwnerQuestionCardState] = [:]

    func secretState(for id: String) -> SecretRequestCardState {
        if let state = secretStates[id] { return state }
        let state = SecretRequestCardState()
        secretStates[id] = state
        return state
    }

    func questionState(for id: String) -> OwnerQuestionCardState {
        if let state = questionStates[id] { return state }
        let state = OwnerQuestionCardState()
        questionStates[id] = state
        return state
    }
}

private struct MessageRow: View, Equatable {
    let message: TimelineMessage
    let isRoom: Bool
    let bot: Bot?
    let senderBot: Bot?
    let replyLabel: String?
    let api: BellAPI
    let onOpenPeer: () -> Void
    let onOpenImages: ([String]) -> Void

    static func == (lhs: MessageRow, rhs: MessageRow) -> Bool {
        lhs.message == rhs.message && lhs.isRoom == rhs.isRoom
            && lhs.bot?.id == rhs.bot?.id && lhs.bot?.color == rhs.bot?.color
            && lhs.bot?.avatar == rhs.bot?.avatar
            && lhs.senderBot?.id == rhs.senderBot?.id && lhs.senderBot?.color == rhs.senderBot?.color
            && lhs.senderBot?.avatar == rhs.senderBot?.avatar
            && lhs.replyLabel == rhs.replyLabel && lhs.api === rhs.api
    }

    private var senderName: String? {
        if message.isPeer { return message.peerName }
        if isRoom && !message.isOutgoing { return message.sender?.title }
        return nil
    }
    private var bubbleAccent: Color { AvatarTone.accent(for: isRoom ? senderBot : bot) }
    private var hasImageStack: Bool { message.displayedImageURLs.count > 1 }
    private var hasBubbleContent: Bool {
        !hasImageStack || message.message?.isEmpty == false || replyLabel != nil
    }

    var body: some View {
        if message.isPeer {
            Button(action: onOpenPeer) {
                HStack(spacing: 8) {
                    Image(systemName: "arrow.left.arrow.right")
                    Text("\(message.peerName ?? "メンバー")との連絡")
                    Image(systemName: "chevron.right").font(.system(size: 10, weight: .bold))
                }
                .font(.system(size: BellTheme.conversationLabelFontSize))
                .foregroundStyle(BellTheme.muted)
                .padding(.horizontal, 15)
                .padding(.vertical, 9)
                .background(.white.opacity(0.75), in: Capsule())
            }
            .buttonStyle(.plain)
            .frame(maxWidth: .infinity)
        } else {
            HStack(alignment: .bottom, spacing: 8) {
                if message.isOutgoing { Spacer(minLength: 45) }
                if isRoom && !message.isOutgoing {
                    AvatarView(name: senderName ?? "?", avatar: senderBot?.avatar ?? "",
                               color: BellTheme.accent(senderBot?.color ?? "violet"), size: 30)
                }
                VStack(alignment: message.isOutgoing ? .trailing : .leading, spacing: 5) {
                    if hasImageStack {
                        if let senderName, !senderName.isEmpty {
                            Text(senderName).font(.system(size: BellTheme.conversationLabelFontSize, weight: .bold))
                                .foregroundStyle(bubbleAccent)
                        }
                        MessageImages(paths: message.displayedImageURLs, messageID: message.id,
                                      outgoing: message.isOutgoing, api: api, onOpen: onOpenImages)
                            .padding(.bottom, 8)
                    }
                    if hasBubbleContent {
                        VStack(alignment: .leading, spacing: 8) {
                            if !hasImageStack, let senderName, !senderName.isEmpty {
                                Text(senderName)
                                    .font(.system(size: BellTheme.conversationLabelFontSize, weight: .bold))
                                    .foregroundStyle(message.isOutgoing ? BellTheme.muted : bubbleAccent)
                            }
                            if !hasImageStack && !message.displayedImageURLs.isEmpty {
                                MessageImages(paths: message.displayedImageURLs, messageID: message.id,
                                              outgoing: message.isOutgoing, api: api, onOpen: onOpenImages)
                            } else if message.displayedImageURLs.isEmpty && message.image == true {
                                Label((message.imageCount ?? 1) > 1 ? "画像\(message.imageCount!)枚" : "画像", systemImage: "photo")
                                    .font(.subheadline)
                            }
                            if let text = message.message, !text.isEmpty {
                                MessageText(source: text, accessibilityIdentifier: "message-text-\(message.id)")
                                    .equatable()
                            }
                            if let replyLabel {
                                Text(replyLabel)
                                    .font(.system(size: 11))
                                    .foregroundStyle(BellTheme.muted)
                            }
                        }
                        .foregroundStyle(BellTheme.ink)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 12)
                        .background(message.isOutgoing ? .white : bubbleAccent.opacity(0.18),
                                    in: RoundedRectangle(cornerRadius: 21, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 21).strokeBorder(
                            message.isOutgoing ? BellTheme.line : bubbleAccent.opacity(0.35)))
                    }
                    HStack(spacing: 6) {
                        if message.isFork { ForkSeatBadge() }
                        Text([BellDate.short(message.at), statusLabel].filter { !$0.isEmpty }.joined(separator: " · "))
                            .font(.system(size: BellTheme.listDetailFontSize))
                            .foregroundStyle(message.status == "failed" && !message.completionUnknown ? .red : BellTheme.muted)
                    }
                    .padding(.horizontal, 5)
                }
                if !message.isOutgoing { Spacer(minLength: 45) }
            }
        }
    }

    private var statusLabel: String {
        guard message.isOutgoing else { return "" }
        return switch message.status {
        case "submitting": "受付確認中"
        case "accepted": "受付済み・反映待ち"
        case "queued": "送信待ち"
        case "running": "処理中"
        case "stopped": "中断"
        case "delivered": "配達済み"
        case "failed": message.completionUnknown ? (isRoom ? "完了未確認の宛先あり" : "受付済み・完了未確認") : "配達失敗"
        default: ""
        }
    }
}

/// 「分身」: a row of the read-only fork inquiry (conversation fork-inquiry.md "Records and display").
private struct ForkSeatBadge: View {
    var body: some View {
        Label("分身", systemImage: "arrow.triangle.branch")
            .font(.system(size: BellTheme.listDetailFontSize, weight: .semibold))
            .foregroundStyle(BellTheme.violet)
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .background(BellTheme.violetLight.opacity(0.75), in: Capsule())
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("分身")
    }
}

/// メンバー間の連絡の全文。会話の根のシートとして開く。
private struct PeerMessageSheet: View {
    let message: TimelineMessage
    let api: BellAPI
    @State private var gallery: ConversationGallery?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 15) {
                    Text(message.peerName ?? "メンバー")
                        .font(.title2.bold())
                    Text(BellDate.long(message.at)).font(BellTheme.messageHelperFont).foregroundStyle(BellTheme.muted)
                    if let text = message.message {
                        MessageText(source: text, fontSize: BellTheme.peerMessageFontSize, lineSpacing: 0,
                                    accessibilityIdentifier: "message-text-\(message.id)")
                            .equatable()
                    }
                    if !message.displayedImageURLs.isEmpty {
                        MessageImages(paths: message.displayedImageURLs, messageID: message.id,
                                      outgoing: message.isOutgoing, api: api) { gallery = ConversationGallery(paths: $0) }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(22)
            }
            .background(BellBackground())
            .navigationTitle("メンバー間の連絡")
            .navigationBarTitleDisplayMode(.inline)
        }
        .presentationDetents([.medium, .large])
        .fullScreenCover(item: $gallery) { MessageImageGallery(paths: $0.paths, api: api) }
    }
}
