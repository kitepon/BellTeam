import PhotosUI
import ImageIO
import UniformTypeIdentifiers
import SwiftUI

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
    @State private var receivedMessages: [TimelineMessage] = []
    @State private var pendingSends: [PendingSend] = []
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
    @State private var measuredRow: String?
    @State private var scroll = ScrollTracker()
    @State private var renderedRows: (first: String, last: String)?
    @State private var rowIsPresenting = false
    @State private var measuredContentWidth: CGFloat?

    private var messages: [TimelineMessage] {
        let receivedIDs = Set(receivedMessages.map(\.id))
        return receivedMessages + pendingSends.filter { pending in
            guard let acceptedID = pending.acceptedID else { return true }
            return !receivedIDs.contains(acceptedID)
        }.map(\.message)
    }

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
        let selectedBot = bot
        return ZStack {
            BellBackground()
            ScrollViewReader { proxy in
                GeometryReader { viewport in
                    let rowWidth = measuredContentWidth ?? (viewport.size.width - 36)
                    let window = conversationWindow(width: rowWidth, botsByID: botsByID)
                    ScrollView {
                        // 画面の周囲だけを配置し、画面外は行の高さを持つ余白にする。
                        VStack(spacing: 17) {
                            if loading && messages.isEmpty {
                                ProgressView().padding(.top, 90)
                            } else if messages.isEmpty {
                                if initialLoadFailed { failedConversation }
                                else { emptyConversation }
                            }
                            if !messages.isEmpty {
                                VStack(spacing: 0) {
                                    Color.clear.frame(height: window.before)
                                    VStack(spacing: 17) {
                                        ForEach(messages[window.range]) { message in
                                            timelineRow(message, selectedBot: selectedBot, botsByID: botsByID, width: rowWidth)
                                        }
                                    }
                                    Color.clear.frame(height: window.after)
                                }
                            }
                            if !queue.isEmpty { queueStrip }
                            Color.clear.frame(height: 2).id("bottom")
                                .background {
                                    GeometryReader { bottom in
                                        Color.clear.preference(key: ScrollMetricsKey.self,
                                            value: ScrollMetrics(bottom: bottom.frame(in: .named("conversation-scroll")).maxY))
                                    }
                                }
                        }
                        .background {
                            GeometryReader { content in
                                let frame = content.frame(in: .named("conversation-scroll"))
                                Color.clear.preference(key: ScrollMetricsKey.self,
                                    value: ScrollMetrics(top: frame.minY, height: frame.height, width: content.size.width))
                            }
                        }
                        .padding(.horizontal, 18)
                        .padding(.top, 20)
                        .padding(.bottom, 18 + (attachments.isEmpty ? 0 : attachmentStripHeight))
                    }
                    .coordinateSpace(name: "conversation-scroll")
                    .onPreferenceChange(ScrollMetricsKey.self) { metrics in
                        scrollChanged(metrics, viewportSize: viewport.size, botsByID: botsByID, proxy: proxy)
                    }
                    .onPreferenceChange(ConversationPresentationKey.self) { presenting in
                        rowIsPresenting = presenting
                        if !presenting && scroll.pendingBottomScroll {
                            scroll.pendingBottomScroll = false
                            scrollToBottomRevision += 1
                        }
                    }
                    .overlay(alignment: .top) {
                        if loadingOlder { ProgressView().padding(.top, 12) }
                    }
                    .overlay(alignment: .bottom) {
                        if hasUnreadMessages {
                            Button("新着メッセージ ↓") {
                                hasUnreadMessages = false
                                renderedRows = nil
                                scrollToBottomRevision += 1
                            }
                            .font(BellTheme.messageHelperFont.weight(.semibold))
                            .buttonStyle(.borderedProminent)
                            .padding(.bottom, 12)
                        }
                    }
                    .scrollDismissesKeyboard(.interactively)
                    .accessibilityIdentifier("conversation-messages")
                    .defaultScrollAnchor(.bottom)
                    .refreshable { await load() }
                    .onChange(of: scrollToBottomRevision) { _, _ in
                        if rowIsPresenting { scroll.pendingBottomScroll = true; return }
                        scroll.followingBottom = true
                        scroll.pin = nil
                        measuredRow = nil
                        renderedRows = nil
                        withAnimation(.easeOut(duration: 0.25)) { proxy.scrollTo("bottom", anchor: .bottom) }
                    }
                    .onChange(of: store.eventRevision) { _, _ in
                        if appIsActive { Task { await load() } }
                    }
                    .onReceive(store.conversationChanges) { changedTarget in
                        if changedTarget == target && appIsActive { Task { await load() } }
                    }
                }
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) { composer }
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

    private func timelineRow(_ message: TimelineMessage, selectedBot: Bot?, botsByID: [String: Bot], width: CGFloat) -> some View {
        let senderBot = (message.sender?.id).flatMap { botsByID[$0] }
        let label = replyLabel(for: message, botsByID: botsByID)
        let keepsMarkdownHeight = message.secretRequest == nil && message.ownerQuestion == nil
            && message.displayedImageURLs.isEmpty && message.image != true
        let minimumHeight: CGFloat? = keepsMarkdownHeight
            ? measuredHeight(message, width: width, botsByID: botsByID) : nil
        return Group {
            if let request = message.secretRequest {
                SecretRequestCard(request: request, state: scroll.secretState(for: message.id))
            } else if let question = message.ownerQuestion {
                OwnerQuestionCard(question: question, state: scroll.questionState(for: message.id))
            } else {
                MessageRow(message: message, isRoom: target.isRoom, bot: selectedBot,
                           senderBot: senderBot, replyLabel: label, api: store.api)
                    .equatable()
            }
        }
        // 同じ本文と幅では、Markdown再描画中も測定済みの高さを保つ。
        .frame(minHeight: minimumHeight, alignment: .top)
        .id(message.id)
        .background(alignment: .top) { rowTopMarker(for: message.id) }
        .background {
            GeometryReader { row in
                let metric = ConversationRowMetric(message: message, layoutWidth: width,
                                                   replyLabel: label, frame: row.frame(in: .named("conversation-scroll")))
                Color.clear.preference(key: ScrollMetricsKey.self, value: ScrollMetrics(rows: [message.id: metric]))
            }
        }
    }

    private func rowTopMarker(for messageID: String) -> some View {
        Color.clear.frame(height: 0).id(ScrollTracker.rowTopID(messageID))
            .background {
                if messageID == (measuredRow ?? messages.first?.id) {
                    GeometryReader { row in
                        Color.clear.preference(key: ScrollMetricsKey.self,
                            value: ScrollMetrics(boundary: row.frame(in: .named("conversation-scroll")).minY))
                    }
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
            await store.refreshFromView()
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
            ConversationInput(draft: store.draft(for: target), sending: sending, hasAttachments: !attachments.isEmpty,
                              onSend: { Task { await send() } },
                              canStop: currentBotCanStop, stopping: stoppingBotID != nil,
                              onStop: { if case .bot(let id) = target { Task { await stopBot(id, name: title) } } },
                              onPasteImages: { attachments.append(contentsOf: $0) },
                              onPasteFailure: { errorText = $0 }) {
                #if targetEnvironment(macCatalyst)
                Button { choosingFile = true } label: {
                    Image(systemName: "paperclip").font(.system(size: 20)).frame(width: 40, height: 40)
                }
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

    private func load() async {
        guard scenePhase == .active else { return }
        guard !awaitingSendResponse else { return }
        if let task = reader.task {
            reader.again = true
            await task.value
            return
        }
        reader.generation += 1
        let generation = reader.generation
        let task = Task {
            repeat {
                reader.again = false
                if receivedMessages.isEmpty { await loadInitial() } else { await refresh() }
            } while reader.again && !Task.isCancelled && scenePhase == .active
            if reader.generation == generation { reader.task = nil }
        }
        reader.task = task
        await task.value
    }

    private func loadInitial() async {
        loading = true
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-bellbot-preview-window-state") {
            receivedMessages = PreviewMessages.statefulItems
            hasMore = false
            loading = false
            scrollToBottomRevision += 1
            if ProcessInfo.processInfo.arguments.contains("-bellbot-preview-window-state-updates") {
                for addition in PreviewMessages.statefulAdditions {
                    do { try await Task.sleep(for: .milliseconds(200)) }
                    catch { return }
                    receivedMessages.append(addition)
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
            receivedMessages = fixture
            hasMore = false
            loading = false
            scrollToBottomRevision += 1
            for tick in 0..<100 {
                do { try await Task.sleep(for: .milliseconds(200)) }
                catch { return }
                receivedMessages = Array(fixture.prefix(visibleCount + tick % 4))
                if tick.isMultiple(of: 4) { scrollToBottomRevision += 1 }
            }
            return
        }
        if ProcessInfo.processInfo.arguments.contains(where: { $0.hasPrefix("-bellbot-preview") })
            && !ProcessInfo.processInfo.arguments.contains("-bellbot-preview-server") {
            receivedMessages = PreviewMessages.items(for: target)
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
        do {
            async let page: ListResponse<TimelineMessage> = store.api.get(target.path + "/messages?limit=10")
            async let waiting: QueueResponse = store.api.get(target.path + "/queue")
            let (result, queued) = try await (page, waiting)
            try Task.checkCancellation()
            guard !awaitingSendResponse else { loading = false; return }
            receivedMessages = result.items
            reconcileAcceptedSends()
            queue = queued.items
            hasMore = result.hasMore
            errorText = nil
            initialLoadFailed = false
        } catch let error where BellAPIError.isAuthenticationError(error) {
            store.requireLogin(for: error)
        } catch is CancellationError { return }
        catch {
            if awaitingSendResponse { loading = false; return }
            errorText = error.localizedDescription
            initialLoadFailed = true
            store.api.diagnostics.report(error, path: target.path + "/messages", method: "GET", observation: .read(error, retainedData: !messages.isEmpty))
        }
        loading = false
    }

    // 上端へスクロールしたら過去を自動で取得し、取得後は先頭だった行を元の画面位置へ戻し続ける。
    private func scrollChanged(_ metrics: ScrollMetrics, viewportSize: CGSize, botsByID: [String: Bot], proxy: ScrollViewProxy) {
        guard let top = metrics.top, let height = metrics.height, let bottom = metrics.bottom,
              let width = metrics.width else { return }
        if measuredContentWidth != width { measuredContentWidth = width }
        let viewportHeight = viewportSize.height
        let resized = abs(width - scroll.contentWidth) > 0.5
        let heightChanged = abs(height - scroll.height) > 0.5
        for (id, row) in metrics.rows {
            // 列の幅が変わった直後は、以前の幅の最小高を使った計測を保存しない。
            if abs(row.frame.width - row.layoutWidth) < 0.5 { scroll.rowSizes[id] = row }
        }
        // 新しく表示したMarkdownの高さが確定した時と幅変更時は、直前に見えていた行を保つ。
        // 明示的に末尾へ移る間は、古い読書位置への補正でその移動を打ち消さない。
        if (heightChanged || resized), !isAtBottom, !scroll.followingBottom, scroll.pin == nil,
           let anchor = scroll.visibleAnchor, metrics.rows[anchor.id] != nil {
            scrollRow(anchor.id, to: anchor.y, viewportHeight: viewportHeight, proxy: proxy)
        } else if let message = messages.first(where: { message in
            guard let frame = metrics.rows[message.id]?.frame else { return false }
            return frame.maxY > 0 && frame.minY < viewportHeight
        }), let frame = metrics.rows[message.id]?.frame {
            scroll.visibleAnchor = (message.id, frame.minY)
        }
        scroll.contentWidth = width
        updateWindow(metrics, viewportHeight: viewportHeight, width: width, botsByID: botsByID)
        let scrolled = abs(height - scroll.height) <= 0.5 && abs(top - scroll.top) > 0.01
        scroll.height = height
        scroll.top = top
        isAtBottom = bottom <= viewportHeight + 48
        if isAtBottom {
            hasUnreadMessages = false
            scroll.followingBottom = false
        }
        if heightChanged {
            // 初期位置と末尾への追従は.defaultScrollAnchor(.bottom)に任せる。推定した余白とMarkdownの実高の差を、増減の両方で補正する。
            if let row = scroll.pin {
                scroll.pinPhase = .correcting
                scrollRow(row, to: scroll.pinnedY, viewportHeight: viewportHeight, proxy: proxy)
            }
            return
        }
        // 固定した行の位置は、利用者のスクロールに合わせて毎回更新する。伸びた分だけを打ち消すので、慣性スクロール中でも保たれる。
        if let boundary = metrics.boundary {
            if let row = scroll.pin {
                let outside = boundary < 0 || boundary > viewportHeight
                switch scroll.pinPhase {
                case .awaitingGrowth:
                    if outside { return }
                case .correcting:
                    if outside {
                        scrollRow(row, to: scroll.pinnedY, viewportHeight: viewportHeight, proxy: proxy)
                        return
                    }
                    scroll.pinPhase = .aligned
                case .aligned:
                    if outside { scroll.pin = nil; measuredRow = nil }
                }
            }
            scroll.pinnedY = boundary
        }
        guard scrolled else { return }
        // 上端の外へ出ると、次に上端へ着いた時の取得を許可する。取得の失敗では許可しないので、失敗が繰り返し再試行されない。
        let atTop = top >= 19.5
        if !atTop { scroll.canLoadOlder = true }
        if scenePhase == .active && atTop && scroll.canLoadOlder && scroll.pin == nil && hasMore && !loadingOlder,
           let oldest = messages.first?.id, metrics.boundary != nil {
            scroll.canLoadOlder = false
            olderTask = Task { await loadOlder(before: oldest, proxy: proxy, viewportHeight: viewportHeight) }
        }
    }

    private func conversationWindow(width: CGFloat, botsByID: [String: Bot]) -> (range: Range<Int>, before: CGFloat, after: CGFloat) {
        let lower = renderedRows.flatMap { bounds in messages.firstIndex { $0.id == bounds.first } }
            ?? max(0, messages.count - 10)
        let upper = renderedRows.flatMap { bounds in messages.firstIndex { $0.id == bounds.last } }.map { $0 + 1 }
            ?? messages.count
        let range = lower..<max(lower, upper)
        return (range, messages[..<lower].reduce(0) { $0 + rowHeight($1, width: width, botsByID: botsByID) + 17 },
                messages[range.upperBound...].reduce(0) { $0 + rowHeight($1, width: width, botsByID: botsByID) + 17 })
    }

    private func measuredHeight(_ message: TimelineMessage, width: CGFloat, botsByID: [String: Bot]) -> CGFloat? {
        guard let row = scroll.rowSizes[message.id], row.message == message,
              row.replyLabel == replyLabel(for: message, botsByID: botsByID),
              abs(row.frame.width - width) < 0.5 else { return nil }
        return row.frame.height
    }

    private func rowHeight(_ message: TimelineMessage, width: CGFloat, botsByID: [String: Bot]) -> CGFloat {
        measuredHeight(message, width: width, botsByID: botsByID) ?? 180
    }

    private func updateWindow(_ metrics: ScrollMetrics, viewportHeight: CGFloat, width: CGFloat, botsByID: [String: Bot]) {
        guard !rowIsPresenting, !messages.isEmpty, let top = metrics.top,
              let anchor = messages.first(where: { message in
                  guard let frame = metrics.rows[message.id]?.frame else { return false }
                  return frame.maxY > 0 && frame.minY < viewportHeight
              }) else { return }
        var offset = top
        var lower = messages.count - 1
        var upper = 0
        for (index, message) in messages.enumerated() {
            let rowHeight = rowHeight(message, width: width, botsByID: botsByID)
            if offset + rowHeight >= -viewportHeight * 2 && offset <= viewportHeight * 3 {
                lower = min(lower, index)
                upper = max(upper, index + 1)
            }
            offset += rowHeight + 17
        }
        if let index = messages.firstIndex(where: { $0.id == anchor.id }) {
            lower = min(lower, index)
            upper = max(upper, index + 1)
        }
        if let pin = scroll.pin, let index = messages.firstIndex(where: { $0.id == pin }) {
            lower = min(lower, index)
            upper = max(upper, index + 1)
        }
        guard upper > lower else { return }
        let current = conversationWindow(width: width, botsByID: botsByID).range
        guard lower != current.lowerBound || upper != current.upperBound else { return }
        renderedRows = (messages[lower].id, messages[upper - 1].id)
    }

    private func scrollRow(_ id: String, to y: CGFloat, viewportHeight: CGFloat, proxy: ScrollViewProxy) {
        proxy.scrollTo(ScrollTracker.rowTopID(id), anchor: UnitPoint(x: 0, y: y / viewportHeight))
    }

    private func loadOlder(before oldest: String, proxy: ScrollViewProxy, viewportHeight: CGFloat) async {
        measuredRow = oldest
        loadingOlder = true
        defer { loadingOlder = false }
        do {
            let path = target.path + "/messages?limit=20&before=\(oldest.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? oldest)"
            let result: ListResponse<TimelineMessage> = try await store.api.get(path)
            try Task.checkCancellation()
            let known = Set(receivedMessages.map(\.id))
            let older = result.items.filter { !known.contains($0.id) }
            hasMore = result.hasMore
            if !older.isEmpty {
                receivedMessages = older + receivedMessages
                // 足した行のMarkdownは後から高さが伸びる。伸びるたびに同じ位置へ戻すため、行と位置を覚えておく。
                scroll.pin = oldest
                scroll.pinPhase = .awaitingGrowth
                scrollRow(oldest, to: scroll.pinnedY, viewportHeight: viewportHeight, proxy: proxy)
            } else {
                measuredRow = nil
            }
        } catch is CancellationError { }
        catch let error where BellAPIError.isAuthenticationError(error) {
            measuredRow = nil
            store.requireLogin(for: error)
        } catch {
            measuredRow = nil
            errorText = error.localizedDescription
            store.api.diagnostics.report(error, path: target.path + "/messages", method: "GET", observation: .read(error, retainedData: !messages.isEmpty))
        }
    }

    private func refresh() async {
        guard !loading, appIsActive, !awaitingSendResponse else { return }
        do {
            async let waiting: QueueResponse = store.api.get(target.path + "/queue")
            let latestPath = target.path + "/messages?limit=20"
            if let lastId = receivedMessages.last?.id {
                let encodedId = lastId.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? lastId
                async let latest: ListResponse<TimelineMessage> = store.api.get(latestPath)
                async let after: ListResponse<TimelineMessage> = store.api.get(target.path + "/messages?after=\(encodedId)")
                let (page, additions, queued) = try await (latest, after, waiting)
                try Task.checkCancellation()
                guard !awaitingSendResponse else { return }
                let known = Set(receivedMessages.map(\.id))
                let newMessages = additions.items.filter { !known.contains($0.id) }
                let indices = Dictionary(uniqueKeysWithValues: receivedMessages.enumerated().map { ($0.element.id, $0.offset) })
                var updated = receivedMessages
                var changed = !newMessages.isEmpty
                for item in page.items {
                    if let index = indices[item.id], updated[index] != item {
                        updated[index] = item
                        changed = true
                    }
                }
                let wasAtBottom = isAtBottom
                if changed {
                    updated.append(contentsOf: newMessages)
                    receivedMessages = updated
                }
                reconcileAcceptedSends()
                if queue != queued.items { queue = queued.items }
                if !newMessages.isEmpty {
                    if wasAtBottom { scrollToBottomRevision += 1 }
                    else { hasUnreadMessages = true }
                }
            } else {
                let page: ListResponse<TimelineMessage> = try await store.api.get(latestPath)
                let queued = try await waiting
                try Task.checkCancellation()
                guard !awaitingSendResponse else { return }
                if queue != queued.items { queue = queued.items }
                if receivedMessages != page.items { receivedMessages = page.items }
                reconcileAcceptedSends()
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

    private func reconcileAcceptedSends() {
        let receivedIDs = Set(receivedMessages.map(\.id))
        pendingSends.removeAll { pending in
            pending.acceptedID.map(receivedIDs.contains) ?? false
        }
    }

    private func restoreUnconfirmedSend(id: String, message: String, images: [PendingImage]) {
        pendingSends.removeAll { $0.id == id }
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
        scroll.followingBottom = true
        scroll.pin = nil
        measuredRow = nil
        awaitingSendResponse = true
        pendingSends.append(PendingSend(id: pendingID, body: message, imageCount: sent.count,
                                        at: Date().ISO8601Format(), acceptedID: nil))
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
            if let index = pendingSends.firstIndex(where: { $0.id == pendingID }) {
                pendingSends[index].acceptedID = acceptedID
            }
            awaitingSendResponse = false
            if appIsActive {
                await load()
                if appIsActive { await store.refreshFromView() }
            }
        } catch {
            awaitingSendResponse = false
            restoreUnconfirmedSend(id: pendingID, message: message, images: sent)
            if appIsActive && BellAPIError.operationResultUnconfirmed(error) { await load() }
            if BellAPIError.isAuthenticationError(error) { store.requireLogin(for: error) }
            else { errorText = BellAPIError.operationFailureMessage(error) }
            store.api.diagnostics.report(error, path: target.path + "/messages", method: "POST", observation: .write)
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

private struct PendingSend {
    let id: String
    let body: String
    let imageCount: Int
    let at: String
    var acceptedID: String?

    var message: TimelineMessage {
        TimelineMessage(id: id, kind: "message", direction: "outgoing", sender: nil, targets: nil,
                        at: at, message: body, image: imageCount > 0,
                        imageCount: imageCount > 0 ? imageCount : nil, imageUrl: nil, imageUrls: nil,
                        delivery: acceptedID == nil ? "submitting" : "accepted", deliveries: nil,
                        routing: nil, peerName: nil, peerPosition: nil, secretRequest: nil, ownerQuestion: nil)
    }
}

private struct ConversationInput<AttachmentButton: View>: View {
    @ObservedObject var draft: ConversationDraft
    let sending: Bool
    let hasAttachments: Bool
    let onSend: () -> Void
    let canStop: Bool
    let stopping: Bool
    let onStop: () -> Void
    let onPasteImages: ([PendingImage]) -> Void
    let onPasteFailure: (String) -> Void
    @ViewBuilder let attachmentButton: () -> AttachmentButton

    private var canSend: Bool { !sending && (draft.hasText || hasAttachments) }

    var body: some View {
        // External clear and failed-send restore must reach the UIKit view.
        let _ = draft.textRevision
        HStack(alignment: .bottom, spacing: 12) {
            attachmentButton()
            ZStack(alignment: .topLeading) {
                MessageInput(text: Binding(get: { draft.text }, set: { draft.setTextFromInput($0) }), onSend: onSend,
                             onPasteImages: onPasteImages, onPasteFailure: onPasteFailure)
                if draft.isEmpty {
                    Text("メッセージを入力…")
                        .font(.system(size: BellTheme.inputFontSize))
                        .foregroundStyle(BellTheme.muted)
                        .allowsHitTesting(false)
                }
            }
            .padding(.vertical, 10)
            if canStop {
                Button(action: onStop) {
                    Image(systemName: "stop.fill")
                        .font(.system(size: 14, weight: .bold))
                        .foregroundStyle(.white)
                        .frame(width: 38, height: 38)
                        .background(.red, in: Circle())
                }
                .accessibilityLabel("今の動作を止める")
                .accessibilityIdentifier("stop-current-bot")
                .disabled(stopping)
                .padding(.bottom, 1)
            }
            Button(action: onSend) {
                Image(systemName: "arrow.up")
                    .font(.system(size: 17, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 38, height: 38)
                    .background(canSend ? BellTheme.violet : BellTheme.line, in: Circle())
            }
            .accessibilityLabel("送信")
            #if targetEnvironment(macCatalyst)
            .help("送信（Return）")
            #endif
            .disabled(!canSend)
            .padding(.bottom, 1)
        }
    }
}

/// 送信前の添付画像。送信はJPEGにそろえる。
struct PendingImage: Identifiable {
    let id: UUID
    let data: Data
    let preview: UIImage

    init?(data: Data) {
        guard let image = UIImage(data: data), let jpeg = image.jpegData(compressionQuality: 0.85) else { return nil }
        id = UUID()
        self.data = jpeg
        preview = image
    }

    init(fileURL url: URL) throws {
        guard url.isFileURL else { throw BellAPIError.server("画像ファイルを選んでください。") }
        let accessed = url.startAccessingSecurityScopedResource()
        defer { if accessed { url.stopAccessingSecurityScopedResource() } }
        guard let image = PendingImage(data: try Data(contentsOf: url)) else {
            throw BellAPIError.server("画像ではないファイルは添付できません（\(url.lastPathComponent)）。")
        }
        self = image
    }
}

// 開いた画面の元の行は、画面を閉じるまで保持する。
struct ConversationPresentationKey: PreferenceKey {
    static var defaultValue = false
    static func reduce(value: inout Bool, nextValue: () -> Bool) { value = nextValue() || value }
}

// 会話のスクロール位置の計測値。各計測点が自分の値だけを入れ、reduceで一つにまとめる。
private struct ConversationRowMetric: Equatable {
    let message: TimelineMessage
    let layoutWidth: CGFloat
    let replyLabel: String?
    let frame: CGRect
}

private struct ScrollMetrics: Equatable {
    var top: CGFloat?
    var height: CGFloat?
    var bottom: CGFloat?
    var boundary: CGFloat?
    var width: CGFloat?
    var rows: [String: ConversationRowMetric] = [:]
}

private struct ScrollMetricsKey: PreferenceKey {
    static var defaultValue = ScrollMetrics()

    static func reduce(value: inout ScrollMetrics, nextValue: () -> ScrollMetrics) {
        let next = nextValue()
        value.top = next.top ?? value.top
        value.height = next.height ?? value.height
        value.bottom = next.bottom ?? value.bottom
        value.boundary = next.boundary ?? value.boundary
        value.width = next.width ?? value.width
        value.rows.merge(next.rows) { _, next in next }
    }
}

private final class ReadCoordinator {
    var task: Task<Void, Never>?
    var again = false
    var generation = 0
}

// 行の実測と、再配置しても残す操作状態。毎フレームの計測で親を再描画しないよう参照型に置く。
private final class ScrollTracker {
    // 追加した過去行の配置中は、元の先頭行が一度画面に戻るまで固定を解除しない。
    enum PinPhase { case awaitingGrowth, correcting, aligned }
    static func rowTopID(_ id: String) -> String { "top-\(id)" }
    private var secretStates: [String: SecretRequestCardState] = [:]
    private var questionStates: [String: OwnerQuestionCardState] = [:]
    var pendingBottomScroll = false
    var followingBottom = false
    var rowSizes: [String: ConversationRowMetric] = [:]
    var visibleAnchor: (id: String, y: CGFloat)?
    var contentWidth: CGFloat = 0
    var height: CGFloat = 0
    var top: CGFloat = 0
    var pin: String?
    var pinPhase = PinPhase.awaitingGrowth
    var pinnedY: CGFloat = 0
    var canLoadOlder = true

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

struct EmptyBody: Encodable {}

/// iPhone・iPad・Macで共通の入力欄。画像と画像ファイルの貼り付けを添付として受け取る。
/// iPadの外付けキーボードとMacはReturnで送信し、Shift+ReturnとOption+Returnで改行する。
private struct MessageInput: UIViewRepresentable {
    @Binding var text: String
    let onSend: () -> Void
    let onPasteImages: ([PendingImage]) -> Void
    let onPasteFailure: (String) -> Void

    func makeUIView(context: Context) -> MessageTextView {
        let view = MessageTextView()
        view.delegate = context.coordinator
        view.font = .systemFont(ofSize: BellTheme.inputFontSize)
        view.textColor = UIColor(BellTheme.ink)
        view.tintColor = UIColor(BellTheme.violet)
        view.backgroundColor = .clear
        view.textContainerInset = .zero
        view.textContainer.lineFragmentPadding = 0
        view.accessibilityIdentifier = "message-input"
        // 編集メニューはこの設定で「ペースト」を出すかを決める。画像と画像ファイルも受け付ける。
        view.pasteConfiguration?.addTypeIdentifiers(forAccepting: UIImage.self)
        view.pasteConfiguration?.addAcceptableTypeIdentifiers([UTType.fileURL.identifier])
        #if targetEnvironment(macCatalyst)
        view.accessibilityHint = "Returnで送信、Shift+ReturnまたはOption+Returnで改行"
        #else
        if UIDevice.current.userInterfaceIdiom == .pad {
            view.accessibilityHint = "外付けキーボードのReturnで送信、Shift+ReturnまたはOption+Returnで改行"
        }
        #endif
        update(view)
        return view
    }

    func updateUIView(_ view: MessageTextView, context: Context) {
        context.coordinator.parent = self
        if view.text != text {
            view.text = text
            view.invalidateSizeMeasurement()
        }
        update(view)
    }

    private func update(_ view: MessageTextView) {
        view.onSend = onSend
        view.onPasteImages = onPasteImages
        view.onPasteFailure = onPasteFailure
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: MessageTextView, context: Context) -> CGSize? {
        let width = proposal.width ?? uiView.bounds.width
        let lineHeight = uiView.font!.lineHeight
        let height = uiView.measuredHeight(forWidth: width)
        return CGSize(width: width, height: min(max(height, lineHeight), lineHeight * 5))
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: MessageInput

        init(_ parent: MessageInput) { self.parent = parent }

        func textViewDidChange(_ textView: UITextView) {
            (textView as? MessageTextView)?.invalidateSizeMeasurement()
            parent.text = textView.text
        }
    }
}

final class MessageTextView: UITextView {
    var onSend: () -> Void = {}
    var onPasteImages: ([PendingImage]) -> Void = { _ in }
    var onPasteFailure: (String) -> Void = { _ in }
    private var measuredWidth: CGFloat?
    private var measuredHeight: CGFloat = 0
    private var sizeMeasurementIsValid = false
    private var cachedPasteboardState: PasteboardState?

    private struct PasteboardState {
        let changeCount: Int
        let fileURLs: [URL]
        let hasImages: Bool
    }

    func invalidateSizeMeasurement() {
        sizeMeasurementIsValid = false
    }

    func measuredHeight(forWidth width: CGFloat) -> CGFloat {
        if sizeMeasurementIsValid, measuredWidth == width { return measuredHeight }
        measuredHeight = sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
        measuredWidth = width
        sizeMeasurementIsValid = true
        return measuredHeight
    }

    override var keyCommands: [UIKeyCommand]? {
        #if !targetEnvironment(macCatalyst)
        guard traitCollection.userInterfaceIdiom == .pad else { return super.keyCommands }
        #endif
        return Self.returnKeyCommands
    }

    private static let returnKeyCommands: [UIKeyCommand] = {
        let newlines = [UIKeyModifierFlags.shift, .alternate].map { flags in
            let command = UIKeyCommand(input: "\r", modifierFlags: flags, action: #selector(insertNewline(_:)))
            command.wantsPriorityOverSystemBehavior = true
            return command
        }
        let send = UIKeyCommand(input: "\r", modifierFlags: [], action: #selector(sendWithReturn(_:)))
        send.wantsPriorityOverSystemBehavior = true
        return newlines + [send]
    }()

    @objc private func sendWithReturn(_ command: UIKeyCommand) { onSend() }
    @objc private func insertNewline(_ command: UIKeyCommand) { insertText("\n") }

    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        if action == #selector(paste(_:)) {
            let contents = pasteboardState
            if !contents.fileURLs.isEmpty || contents.hasImages { return true }
        }
        return super.canPerformAction(action, withSender: sender)
    }

    // コピーした画像ファイル（Finderなど）はファイル本体を、コピーした画像はその画像を添付にする。
    // ファイルのコピーはアイコン画像も一緒に載るため、ファイルを先に見る。
    override func paste(_ sender: Any?) {
        let contents = pasteboardState
        let files = contents.fileURLs
        if !files.isEmpty {
            do { onPasteImages(try files.map(PendingImage.init(fileURL:))) }
            catch { onPasteFailure(error.localizedDescription) }
            return
        }
        if contents.hasImages {
            let images = UIPasteboard.general.items.compactMap { item -> PendingImage? in
                for (type, value) in item where UTType(type)?.conforms(to: .image) == true {
                    if let data = value as? Data, let image = PendingImage(data: data) { return image }
                    if let data = (value as? UIImage)?.pngData(), let image = PendingImage(data: data) { return image }
                }
                return nil
            }
            if images.isEmpty { onPasteFailure("貼り付けた画像を読み込めませんでした。") }
            else { onPasteImages(images) }
            return
        }
        super.paste(sender)
    }

    private var pasteboardState: PasteboardState {
        let pasteboard = UIPasteboard.general
        if let cachedPasteboardState, cachedPasteboardState.changeCount == pasteboard.changeCount {
            return cachedPasteboardState
        }
        let hasImages = pasteboard.hasImages
        let state = PasteboardState(
            changeCount: pasteboard.changeCount,
            fileURLs: pasteboard.hasURLs ? (pasteboard.urls ?? []).filter(\.isFileURL) : [],
            hasImages: hasImages
        )
        cachedPasteboardState = state
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
    @State private var showingPeer = false

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
            Button { showingPeer = true } label: {
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
            .sheet(isPresented: $showingPeer) {
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
                                              outgoing: message.isOutgoing, api: api)
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
            }
            .preference(key: ConversationPresentationKey.self, value: showingPeer)
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
                                      outgoing: message.isOutgoing, api: api)
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
                                              outgoing: message.isOutgoing, api: api)
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
                    Text([BellDate.short(message.at), statusLabel].filter { !$0.isEmpty }.joined(separator: " · "))
                        .font(.system(size: BellTheme.listDetailFontSize))
                        .foregroundStyle(message.status == "failed" ? .red : BellTheme.muted)
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
        case "failed": "配達失敗"
        default: ""
        }
    }
}

/// 会話内のカード束と全画面表示は、iPhone・iPad・Macで同じ画像一覧を使う。
private struct MessageImages: View {
    let paths: [String]
    let messageID: String
    let outgoing: Bool
    let api: BellAPI
    @State private var showingGallery = false
    @Environment(\.horizontalSizeClass) private var sizeClass
    private var cardWidth: CGFloat { sizeClass == .compact ? 180 : 230 }

    var body: some View {
        Button { showingGallery = true } label: {
            VStack(alignment: outgoing ? .trailing : .leading, spacing: 10) {
                if paths.count == 1 {
                    AuthenticatedImage(path: paths[0], api: api, maxPixelSize: nil)
                        .frame(maxWidth: 230)
                        .accessibilityIdentifier("message-image-\(messageID)-0")
                } else {
                    ZStack {
                        ForEach(Array(paths.prefix(3).enumerated()).reversed(), id: \.offset) { depth, path in
                            AuthenticatedImage(path: path, api: api, maxPixelSize: 1024, fillsFrame: true)
                                .frame(width: cardWidth, height: cardWidth * 1.4)
                                .overlay { if depth > 0 { Color.white.opacity(0.28) } }
                                .clipShape(RoundedRectangle(cornerRadius: 18))
                                .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(.black.opacity(0.08)))
                                .shadow(color: .black.opacity(0.18), radius: 10, y: 8)
                                .scaleEffect(1 - Double(depth) * 0.04)
                                .rotationEffect(.degrees(Double(depth) * (outgoing ? -4 : 4)))
                                .offset(x: CGFloat(depth) * cardWidth * (outgoing ? -0.10 : 0.10),
                                        y: CGFloat(depth) * cardWidth * 0.11)
                                .accessibilityHidden(depth > 0)
                        }
                    }
                    .frame(width: cardWidth, height: cardWidth * 1.4)
                    .padding(outgoing ? .leading : .trailing, cardWidth * 0.20)
                    .padding(.top, 8)
                    .padding(.bottom, cardWidth * 0.22)
                    Label("画像\(paths.count)枚", systemImage: "rectangle.on.rectangle")
                        .font(.footnote)
                        .foregroundStyle(BellTheme.muted)
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(paths.count > 1 ? "画像\(paths.count)枚を開く" : "画像を開く")
        .accessibilityIdentifier("message-images-\(messageID)")
        .fullScreenCover(isPresented: $showingGallery) {
            MessageImageGallery(paths: paths, api: api)
        }
        .preference(key: ConversationPresentationKey.self, value: showingGallery)
    }
}

private struct MessageImageGallery: View {
    let paths: [String]
    let api: BellAPI
    @Environment(\.dismiss) private var dismiss
    @State private var selection = 0

    var body: some View {
        VStack(spacing: 16) {
            HStack {
                Button { dismiss() } label: {
                    Image(systemName: "xmark").font(.system(size: 18, weight: .medium))
                        .frame(width: 44, height: 44)
                        .background(.white.opacity(0.08), in: Circle())
                        .overlay(Circle().strokeBorder(.white.opacity(0.10)))
                }
                .accessibilityLabel("閉じる")
                .accessibilityIdentifier("image-gallery-close")
                .keyboardShortcut(.cancelAction)
                Spacer()
                Text("\(selection + 1) / \(paths.count)")
                    .monospacedDigit()
                    .accessibilityIdentifier("image-gallery-position")
                Spacer()
                Color.clear.frame(width: 44, height: 44)
            }
            TabView(selection: $selection) {
                ForEach(Array(paths.enumerated()), id: \.offset) { index, path in
                    AuthenticatedImage(path: path, api: api, maxPixelSize: nil)
                        .padding(.horizontal, 16)
                        .accessibilityIdentifier("image-gallery-image-\(index)")
                        .tag(index)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            .accessibilityIdentifier("image-gallery-pages")
            if paths.count > 1 {
                HStack(spacing: 16) {
                    Button { selection = (selection + paths.count - 1) % paths.count } label: {
                        Image(systemName: "chevron.left").frame(width: 36, height: 64)
                    }
                    .accessibilityLabel("前の画像")
                    .keyboardShortcut(.leftArrow, modifiers: [])
                    GeometryReader { viewport in
                        ScrollViewReader { proxy in
                            ScrollView(.horizontal) {
                                HStack(spacing: 10) {
                                    ForEach(Array(paths.enumerated()), id: \.offset) { index, path in
                                        Button { selection = index } label: {
                                            AuthenticatedImage(path: path, api: api, maxPixelSize: 192, fillsFrame: true)
                                                .frame(width: 64, height: 64)
                                                .clipShape(RoundedRectangle(cornerRadius: 8))
                                                .opacity(index == selection ? 1 : 0.5)
                                                .overlay(RoundedRectangle(cornerRadius: 8)
                                                    .strokeBorder(index == selection ? .white : .clear, lineWidth: 2))
                                        }
                                        .accessibilityLabel("画像\(index + 1)")
                                        .accessibilityAddTraits(index == selection ? .isSelected : [])
                                        .accessibilityIdentifier("image-gallery-thumbnail-\(index)")
                                        .id(index)
                                    }
                                }
                                .padding(2)
                                .frame(minWidth: viewport.size.width)
                            }
                            .scrollIndicators(.hidden)
                            .onChange(of: selection) { _, index in
                                withAnimation { proxy.scrollTo(index, anchor: .center) }
                            }
                        }
                    }
                    .frame(height: 68)
                    Button { selection = (selection + 1) % paths.count } label: {
                        Image(systemName: "chevron.right").frame(width: 36, height: 64)
                    }
                    .accessibilityLabel("次の画像")
                    .keyboardShortcut(.rightArrow, modifiers: [])
                }
            }
        }
        .padding(16)
        .foregroundStyle(.white)
        .buttonStyle(.plain)
        .background(Color.black.ignoresSafeArea())
        .preferredColorScheme(.dark)
    }
}

private struct AuthenticatedImage: View {
    let path: String
    let api: BellAPI
    var maxPixelSize: Int? = 1024
    var fillsFrame = false
    @State private var image: UIImage?
    @State private var failed = false

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .aspectRatio(contentMode: fillsFrame ? .fill : .fit)
                    .clipShape(RoundedRectangle(cornerRadius: 13))
                    .accessibilityLabel("画像")
            } else if failed {
                Label("画像を読み込めません", systemImage: "photo.badge.exclamationmark")
                    .font(.footnote)
            } else {
                ProgressView().frame(width: 120, height: 90)
            }
        }
        .task(id: "\(conversationImageOrigin(api.baseURL))|\(path)") {
            do {
                image = try await ConversationImageCache.shared.image(
                    path: path,
                    origin: conversationImageOrigin(api.baseURL),
                    maxPixelSize: maxPixelSize,
                    api: api
                )
            }
            catch {
                failed = true
                api.diagnostics.report(error, path: path, method: "GET", observation: .read(error, retainedData: image != nil))
            }
        }
    }
}

private func conversationImageOrigin(_ url: URL?) -> String {
    guard let url, var components = URLComponents(url: url, resolvingAgainstBaseURL: false),
          let scheme = components.scheme?.lowercased(), let host = components.host?.lowercased() else {
        return "unconfigured"
    }
    if (scheme == "https" && components.port == 443) || (scheme == "http" && components.port == 80) {
        components.port = nil
    }
    return "\(scheme)://\(host)\(components.port.map { ":\($0)" } ?? "")"
}

/// 認証付き画像の取得をpath単位で共有し、表示サイズごとに縮小復号した結果を保持する。
private actor ConversationImageCache {
    static let shared = ConversationImageCache()

    private let encodedImages = NSCache<NSString, NSData>()
    private let decodedImages = NSCache<NSString, UIImage>()
    private var requests: [RequestKey: Task<Data, Error>] = [:]

    private init() {
        encodedImages.totalCostLimit = 64 * 1024 * 1024
        decodedImages.totalCostLimit = 64 * 1024 * 1024
    }

    func image(path: String, origin: String, maxPixelSize: Int?, api: BellAPI) async throws -> UIImage {
        let requestKey = RequestKey(origin: origin, path: path)
        let imageKey = "\(origin)|\(path)#\(maxPixelSize.map(String.init) ?? "original")" as NSString
        let dataKey = "\(origin)|\(path)" as NSString
        if let cached = decodedImages.object(forKey: imageKey) { return cached }

        let data: Data
        if let cached = encodedImages.object(forKey: dataKey) {
            data = cached as Data
        } else if let request = requests[requestKey] {
            data = try await request.value
        } else {
            let request = Task { try await api.image(path) }
            requests[requestKey] = request
            do {
                data = try await request.value
                encodedImages.setObject(data as NSData, forKey: dataKey, cost: data.count)
                requests[requestKey] = nil
            } catch {
                requests[requestKey] = nil
                throw error
            }
        }

        let image = try await Task.detached(priority: .userInitiated) {
            try Self.decode(data: data, maxPixelSize: maxPixelSize)
        }.value
        decodedImages.setObject(image, forKey: imageKey, cost: image.cgImage.map { $0.bytesPerRow * $0.height } ?? 0)
        return image
    }

    private struct RequestKey: Hashable {
        let origin: String
        let path: String
    }

    private static func decode(data: Data, maxPixelSize: Int?) throws -> UIImage {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { throw BellAPIError.invalidResponse }
        let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
        guard let width = properties?[kCGImagePropertyPixelWidth] as? Int,
              let height = properties?[kCGImagePropertyPixelHeight] as? Int else { throw BellAPIError.invalidResponse }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixelSize ?? max(width, height),
            kCGImageSourceCreateThumbnailWithTransform: true
        ]
        let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
        guard let cgImage else { throw BellAPIError.invalidResponse }
        return UIImage(cgImage: cgImage)
    }
}

struct ConversationDetailView: View {
    let target: ChatTarget
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var errorText: String?
    @State private var editingProfile = false
    @State private var showingScreen = false

    private var bot: Bot? { store.bots.first { $0.id == target.id } }
    private var room: Room? { store.rooms.first { $0.id == target.id } }

    var body: some View {
        NavigationStack {
            ZStack {
                BellBackground()
                ScrollView {
                    VStack(spacing: 18) {
                        AvatarView(name: room?.name ?? bot?.name ?? "BellTeam", avatar: room?.avatar ?? bot?.avatar ?? "",
                                   color: BellTheme.accent(bot?.color ?? "violet"), size: 88, isRoom: target.isRoom)
                        Text(room?.name ?? bot?.displayName ?? "")
                            .font(.system(size: 27, weight: .bold, design: .rounded))
                            .foregroundStyle(BellTheme.ink)
                        if let room {
                            SelectableText(room.purpose, color: BellTheme.muted)
                            ForEach(room.memberIds, id: \.self) { id in
                                Text(store.bots.first(where: { $0.id == id })?.displayName ?? id)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(15)
                                    .bellCard()
                            }
                            Button("ルームを編集") { editingProfile = true }
                                .buttonStyle(.borderedProminent)
                        } else if let bot {
                            SelectableText(bot.profileText.isEmpty ? bot.position : bot.profileText, color: BellTheme.muted)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(18)
                                .bellCard()
                            LabeledContent("ハーネス", value: bot.harness)
                            LabeledContent("モデル", value: bot.model.isEmpty ? "既定" : bot.model)
                            Button("Botの画面を見る") { showingScreen = true }
                                .buttonStyle(.bordered)
                            Button("メンバーを編集") { editingProfile = true }
                                .buttonStyle(.borderedProminent)
                            Button("会話セッションを再起動") {
                                Task {
                                    do {
                                        try await store.authorizeAIUse(target: target)
                                        let _: APIAcknowledgement = try await store.api.post(target.path + "/restart", body: EmptyBody())
                                        dismiss()
                                    } catch { errorText = error.localizedDescription }
                                }
                            }
                            .buttonStyle(.bordered)
                        }
                        if let errorText { Text(errorText).foregroundStyle(.red).font(.footnote) }
                    }
                    .padding(25)
                }
            }
            .navigationTitle("詳細")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("閉じる") { dismiss() } } }
            .sheet(isPresented: $editingProfile) {
                if let room { RoomEditor(initial: room).environmentObject(store) }
                else if let bot { BotEditor(initial: bot).environmentObject(store) }
            }
            .sheet(isPresented: $showingScreen) {
                if let bot { BotScreenView(bot: bot).environmentObject(store) }
            }
            .onChange(of: room?.id) { _, id in
                if target.isRoom && id == nil { dismiss() }
            }
            .onChange(of: bot?.id) { _, id in
                if !target.isRoom && id == nil { dismiss() }
            }
        }
    }
}

private struct ScreenResponse: Decodable {
    let online: Bool
    let screen: String
}

private struct BotScreenText: View, Equatable {
    let value: String

    var body: some View {
        SelectableText(value, font: .monospacedSystemFont(ofSize: 12, weight: .regular))
            .frame(maxWidth: .infinity, alignment: .topLeading)
            .padding(16)
    }
}

struct BotScreenView: View {
    let bot: Bot
    var embedded = false
    @EnvironmentObject private var store: AppStore
    @State private var screen = ""
    @State private var online = false
    @State private var errorText: String?

    var body: some View {
        Group {
            if embedded {
                screenContent
            } else {
                NavigationStack {
                    screenContent
                        .navigationTitle("\(bot.displayName)の画面")
                        .navigationBarTitleDisplayMode(.inline)
                }
            }
        }
        .task { await refreshScreen() }
    }

    private var screenContent: some View {
        ZStack {
            BellBackground()
            ScrollView([.horizontal, .vertical]) {
                BotScreenText(value: screen.isEmpty ? (online ? "画面は空です" : "次のメッセージで起動します") : screen)
                    .equatable()
            }
            .background(.white.opacity(0.8), in: RoundedRectangle(cornerRadius: 18))
            .padding(16)
        }
        .safeAreaInset(edge: .bottom) {
            HStack(spacing: 7) {
                Circle().fill(online ? BellTheme.mint : BellTheme.muted).frame(width: 7, height: 7)
                Text(errorText ?? (online ? "2秒ごとに更新" : "停止中"))
            }
            .font(.footnote)
            .foregroundStyle(errorText == nil ? BellTheme.muted : .red)
            .frame(maxWidth: .infinity)
            .padding(10)
            .background(.regularMaterial)
        }
    }

    private func refreshScreen() async {
        while !Task.isCancelled {
            do {
                let result: ScreenResponse = try await store.api.get("/api/bots/\(bot.id)/screen")
                if online != result.online { online = result.online }
                if screen != result.screen { screen = result.screen }
                if errorText != nil { errorText = nil }
            } catch let error where BellAPIError.isAuthenticationError(error) {
                store.requireLogin(for: error)
                break
            } catch {
                errorText = error.localizedDescription
                store.api.diagnostics.report(error, path: "/api/bots/\(bot.id)/screen", method: "GET", observation: .read(error, retainedData: !screen.isEmpty))
                break
            }
            try? await Task.sleep(for: .seconds(2))
        }
    }
}
