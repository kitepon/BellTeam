import PhotosUI
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
    @State private var messages: [TimelineMessage] = []
    @State private var queue: [QueueItem] = []
    @State private var hasMore = false
    @State private var loading = true
    @State private var loadingOlder = false
    @State private var sending = false
    private var draft: String {
        get { store.draft(for: target).text }
        nonmutating set { store.draft(for: target).text = newValue }
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

    private var bot: Bot? { store.bots.first { $0.id == target.id } }
    private var room: Room? { store.rooms.first { $0.id == target.id } }
    private var title: String { target.isRoom ? (room?.name ?? "ルーム") : (bot?.displayName ?? "メンバー") }
    private var avatar: String { target.isRoom ? (room?.avatar ?? "") : (bot?.avatar ?? "") }
    private var accent: Color { target.isRoom ? BellTheme.violet : BellTheme.accent(bot?.color ?? "violet") }
    private var appIsActive: Bool { UIApplication.shared.applicationState == .active }

    var body: some View {
        ZStack {
            BellBackground()
            ScrollViewReader { proxy in
                GeometryReader { viewport in
                    ScrollView {
                        // 更新と自動スクロールが重なっても、読み込んだ行の配置を一度で確定する。
                        VStack(spacing: 17) {
                            if loading && messages.isEmpty {
                                ProgressView().padding(.top, 90)
                            } else if messages.isEmpty {
                                emptyConversation
                            }
                            ForEach(messages) { message in
                                Group {
                                    if let request = message.secretRequest {
                                        SecretRequestCard(request: request)
                                    } else if let question = message.ownerQuestion {
                                        OwnerQuestionCard(question: question)
                                    } else {
                                        MessageRow(message: message, isRoom: target.isRoom, bot: bot,
                                                   bots: store.bots, api: store.api)
                                    }
                                }
                                .id(message.id)
                                .background(alignment: .top) {
                                    // 各行の上端に0高の目印を置く。過去を足した後、足す前の先頭行をこの目印で元の画面位置へ戻す。
                                    Color.clear.frame(height: 0).id(ScrollTracker.rowTopID(message.id))
                                        .background {
                                            // 先頭行の位置は常に測っておく。取得の応答が速くても、足す前の位置が必ず手元にある。
                                            if message.id == (measuredRow ?? messages.first?.id) {
                                                GeometryReader { row in
                                                    Color.clear.preference(key: ScrollMetricsKey.self,
                                                        value: ScrollMetrics(boundary: row.frame(in: .named("conversation-scroll")).minY))
                                                }
                                            }
                                        }
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
                                    value: ScrollMetrics(top: frame.minY, height: frame.height))
                            }
                        }
                        .padding(.horizontal, 18)
                        .padding(.top, 20)
                        .padding(.bottom, 18 + (attachments.isEmpty ? 0 : attachmentStripHeight))
                    }
                    .coordinateSpace(name: "conversation-scroll")
                    .onPreferenceChange(ScrollMetricsKey.self) { metrics in
                        scrollChanged(metrics, viewportHeight: viewport.size.height, proxy: proxy)
                    }
                    .overlay(alignment: .top) {
                        if loadingOlder { ProgressView().padding(.top, 12) }
                    }
                    .overlay(alignment: .bottom) {
                        if hasUnreadMessages {
                            Button("新着メッセージ ↓") {
                                hasUnreadMessages = false
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
                    .refreshable { await refresh() }
                    .onChange(of: scrollToBottomRevision) { _, _ in
                        withAnimation(.easeOut(duration: 0.25)) { proxy.scrollTo("bottom", anchor: .bottom) }
                    }
                    .onChange(of: store.eventRevision) { _, _ in
                        if appIsActive { Task { await refresh() } }
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
                        Text(title)
                            .font(.system(size: BellTheme.listNameFontSize + 2, weight: .bold, design: .rounded))
                            .foregroundStyle(BellTheme.ink)
                            .lineLimit(1)
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
        .task { await loadInitial() }
        .onChange(of: scenePhase) { _, next in
            if next == .active { Task { await refresh() } }
        }
        .onAppear {
            visibleAttachments = store.draft(for: target).attachments
            selectedTargets = store.draft(for: target).selectedTargets
            BellNotifications.shared.visibleConversation = target
        }
        .onChange(of: selectedTargets) { _, next in store.draft(for: target).selectedTargets = next }
        .onDisappear {
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

    private var queueStrip: some View {
        VStack(alignment: .leading, spacing: 9) {
            ForEach(queue) { item in
                HStack(spacing: 9) {
                    ProgressView().controlSize(.mini)
                    Text("\(item.botName ?? title) · \(item.status == "queued" ? "送信待ち" : "処理中")")
                        .font(BellTheme.messageHelperFont.weight(.medium))
                    Spacer()
                }
            }
        }
        .foregroundStyle(BellTheme.violet)
        .padding(14)
        .frame(maxWidth: .infinity)
        .background(BellTheme.violetLight.opacity(0.65), in: RoundedRectangle(cornerRadius: 16))
    }

    private var composer: some View {
        VStack(spacing: 8) {
            if let errorText {
                Text(errorText)
                    .font(BellTheme.messageHelperFont)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("send-error")
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if let room { targetPicker(room) }
            ConversationInput(draft: store.draft(for: target), sending: sending, hasAttachments: !attachments.isEmpty,
                              onSend: { Task { await send() } },
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
        // 添付画像の並びは入力欄の真上に重ねる。入力欄の高さを変えると、キーボード表示中は
        // 入力欄がキーボードの下へはみ出した（iPhone Simulator、iOS 26）。
        .overlay(alignment: .top) {
            if !attachments.isEmpty { attachmentStrip.offset(y: -attachmentStripHeight) }
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

    private func loadInitial() async {
        loading = true
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-bellbot-preview-updating-chat") {
            try? await Task.sleep(for: .milliseconds(350))
            messages = PreviewMessages.updatingItems
            hasMore = false
            loading = false
            scrollToBottomRevision += 1
            for tick in 0..<100 {
                do { try await Task.sleep(for: .milliseconds(200)) }
                catch { return }
                messages = Array(PreviewMessages.updatingItems.prefix(7 + tick % 4))
                if tick.isMultiple(of: 4) { scrollToBottomRevision += 1 }
            }
            return
        }
        if ProcessInfo.processInfo.arguments.contains(where: { $0.hasPrefix("-bellbot-preview") })
            && !ProcessInfo.processInfo.arguments.contains("-bellbot-preview-server") {
            messages = PreviewMessages.items(for: target)
            queue = []
            hasMore = false
            loading = false
            return
        }
        #endif
        do {
            async let page: ListResponse<TimelineMessage> = store.api.get(target.path + "/messages?limit=10")
            async let waiting: QueueResponse = store.api.get(target.path + "/queue")
            let (result, queued) = try await (page, waiting)
            messages = result.items
            queue = queued.items
            hasMore = result.hasMore
            errorText = nil
        } catch let error where BellAPIError.isAuthenticationError(error) {
            store.requireLogin(for: error)
        } catch is CancellationError { }
        catch {
            errorText = error.localizedDescription
            store.api.diagnostics.report(error, path: target.path + "/messages", method: "GET", observation: .read(error, retainedData: !messages.isEmpty))
        }
        loading = false
    }

    // 上端へスクロールしたら過去を自動で取得し、取得後は先頭だった行を元の画面位置へ戻し続ける。
    private func scrollChanged(_ metrics: ScrollMetrics, viewportHeight: CGFloat, proxy: ScrollViewProxy) {
        guard let top = metrics.top, let height = metrics.height, let bottom = metrics.bottom else { return }
        let grew = height > scroll.height + 0.5
        let scrolled = abs(height - scroll.height) <= 0.5 && abs(top - scroll.top) > 0.01
        scroll.height = height
        scroll.top = top
        isAtBottom = bottom <= viewportHeight + 48
        if isAtBottom { hasUnreadMessages = false }
        if grew {
            // 初期位置と末尾への追従は.defaultScrollAnchor(.bottom)に任せる。足した過去の行の高さが後から伸びる間だけ、固定した行を元の位置へ戻す。
            if let row = scroll.pin, let y = scroll.pinnedY { scrollRow(row, to: y, viewportHeight: viewportHeight, proxy: proxy) }
            return
        }
        // 固定した行の位置は、利用者のスクロールに合わせて毎回更新する。伸びた分だけを打ち消すので、慣性スクロール中でも保たれる。
        if let boundary = metrics.boundary {
            if scroll.pin != nil && (boundary < 0 || boundary > viewportHeight) { scroll.pin = nil; measuredRow = nil }
            scroll.pinnedY = boundary
        }
        guard scrolled else { return }
        // 上端の外へ出ると、次に上端へ着いた時の取得を許可する。取得の失敗では許可しないので、失敗が繰り返し再試行されない。
        let atTop = top >= 19.5
        if !atTop { scroll.canLoadOlder = true }
        if atTop && scroll.canLoadOlder && scroll.pin == nil && hasMore && !loadingOlder, let oldest = messages.first?.id, let y = metrics.boundary {
            scroll.canLoadOlder = false
            Task { await loadOlder(before: oldest, at: y, proxy: proxy, viewportHeight: viewportHeight) }
        }
    }

    private func scrollRow(_ id: String, to y: CGFloat, viewportHeight: CGFloat, proxy: ScrollViewProxy) {
        proxy.scrollTo(ScrollTracker.rowTopID(id), anchor: UnitPoint(x: 0, y: y / viewportHeight))
    }

    private func loadOlder(before oldest: String, at y: CGFloat, proxy: ScrollViewProxy, viewportHeight: CGFloat) async {
        measuredRow = oldest
        loadingOlder = true
        defer { loadingOlder = false }
        do {
            let path = target.path + "/messages?limit=20&before=\(oldest.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? oldest)"
            let result: ListResponse<TimelineMessage> = try await store.api.get(path)
            let known = Set(messages.map(\.id))
            messages = result.items.filter { !known.contains($0.id) } + messages
            hasMore = result.hasMore
            // 足した行のMarkdownは後から高さが伸びる。伸びるたびに同じ位置へ戻すため、行と位置を覚えておく。
            scroll.pin = oldest
            scrollRow(oldest, to: scroll.pinnedY ?? y, viewportHeight: viewportHeight, proxy: proxy)
        } catch let error where BellAPIError.isAuthenticationError(error) {
            measuredRow = nil
            store.requireLogin(for: error)
        } catch {
            measuredRow = nil
            errorText = error.localizedDescription
            store.api.diagnostics.report(error, path: target.path + "/messages", method: "GET", observation: .read(error, retainedData: !messages.isEmpty))
        }
    }

    private func refresh() async {
        guard !loading, appIsActive else { return }
        do {
            async let waiting: QueueResponse = store.api.get(target.path + "/queue")
            let latestPath = target.path + "/messages?limit=20"
            if let lastId = messages.last?.id {
                let encodedId = lastId.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? lastId
                async let latest: ListResponse<TimelineMessage> = store.api.get(latestPath)
                async let after: ListResponse<TimelineMessage> = store.api.get(target.path + "/messages?after=\(encodedId)")
                let (page, additions, queued) = try await (latest, after, waiting)
                let known = Set(messages.map(\.id))
                let newMessages = additions.items.filter { !known.contains($0.id) }
                let updates = Dictionary(uniqueKeysWithValues: page.items.map { ($0.id, $0) })
                let wasAtBottom = isAtBottom
                messages = messages.map { updates[$0.id] ?? $0 } + newMessages
                queue = queued.items
                if !newMessages.isEmpty {
                    if wasAtBottom { scrollToBottomRevision += 1 }
                    else { hasUnreadMessages = true }
                }
            } else {
                let page: ListResponse<TimelineMessage> = try await store.api.get(latestPath)
                let queued = try await waiting
                queue = queued.items
                messages = page.items
                hasMore = page.hasMore
                scrollToBottomRevision += 1
            }
            errorText = nil
        } catch let error where BellAPIError.isAuthenticationError(error) { store.requireLogin(for: error) }
        catch is CancellationError { }
        catch {
            errorText = error.localizedDescription
            store.api.diagnostics.report(error, path: target.path + "/messages", method: "GET", observation: .read(error, retainedData: !messages.isEmpty))
        }
    }

    // 送信した本文と画像はすぐ入力欄から外す。Botの起動と受付を待つと数秒以上かかるため、
    // 返事を待ってから消すと送れていないように見える。拒否された時だけ入力欄へ戻す。
    private func send() async {
        guard canSend else { return }
        if target.isRoom && selectedTargets.isEmpty && !store.routingEnabled {
            errorText = "返信者の自動選択は未設定です。入力欄の上で返信するメンバーを選んでください。"
            return
        }
        sending = true
        defer { sending = false }
        do { try await store.authorizeAIUse(target: target) }
        catch let error where BellAPIError.isAuthenticationError(error) { store.requireLogin(for: error); return }
        catch {
            errorText = error.localizedDescription
            store.api.diagnostics.report(error, path: "/api/subscription", method: nil, observation: .read(error, retainedData: true))
            return
        }
        let message = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let sent = attachments
        draft = ""
        attachments = []
        errorText = nil
        let body = SendMessageBody(
            message: message,
            images: sent.map { ImagePayload(mime: "image/jpeg", data: $0.data.base64EncodedString()) },
            targets: target.isRoom && !selectedTargets.isEmpty ? Array(selectedTargets) : nil
        )
        do {
            try await store.api.sendMessage(target.path + "/messages", body: body)
            hasUnreadMessages = false
            scrollToBottomRevision += 1
            if appIsActive {
                await refresh()
                if appIsActive { await store.refreshFromView() }
            }
        } catch {
            // 送信中に書き始めた続きは消さず、送れなかった本文の後ろに残す。
            draft = [message, draft].filter { !$0.isEmpty }.joined(separator: "\n")
            attachments = sent + attachments
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

private struct ConversationInput<AttachmentButton: View>: View {
    @ObservedObject var draft: ConversationDraft
    let sending: Bool
    let hasAttachments: Bool
    let onSend: () -> Void
    let onPasteImages: ([PendingImage]) -> Void
    let onPasteFailure: (String) -> Void
    @ViewBuilder let attachmentButton: () -> AttachmentButton

    private var canSend: Bool { !sending && (draft.hasText || hasAttachments) }

    var body: some View {
        HStack(alignment: .bottom, spacing: 12) {
            attachmentButton()
            ZStack(alignment: .topLeading) {
                MessageInput(text: $draft.text, onSend: onSend,
                             onPasteImages: onPasteImages, onPasteFailure: onPasteFailure)
                if draft.text.isEmpty {
                    Text("メッセージを入力…")
                        .font(.system(size: BellTheme.inputFontSize))
                        .foregroundStyle(BellTheme.muted)
                        .allowsHitTesting(false)
                }
            }
            .padding(.vertical, 10)
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

// 会話のスクロール位置の計測値。各計測点が自分の値だけを入れ、reduceで一つにまとめる。
private struct ScrollMetrics: Equatable {
    var top: CGFloat?
    var height: CGFloat?
    var bottom: CGFloat?
    var boundary: CGFloat?
}

private struct ScrollMetricsKey: PreferenceKey {
    static var defaultValue = ScrollMetrics()

    static func reduce(value: inout ScrollMetrics, nextValue: () -> ScrollMetrics) {
        let next = nextValue()
        value.top = next.top ?? value.top
        value.height = next.height ?? value.height
        value.bottom = next.bottom ?? value.bottom
        value.boundary = next.boundary ?? value.boundary
    }
}

// スクロール中に毎フレーム書き換える値。画面の再描画を起こさないよう@Stateの値ではなく参照型に置く。
private final class ScrollTracker {
    static func rowTopID(_ id: String) -> String { "top-\(id)" }
    var height: CGFloat = 0
    var top: CGFloat = 0
    var pin: String?
    var pinnedY: CGFloat?
    var canLoadOlder = true
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
        if view.text != text { view.text = text }
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
        let height = uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
        return CGSize(width: width, height: min(max(height, lineHeight), lineHeight * 5))
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: MessageInput

        init(_ parent: MessageInput) { self.parent = parent }

        func textViewDidChange(_ textView: UITextView) {
            parent.text = textView.text
        }
    }
}

final class MessageTextView: UITextView {
    var onSend: () -> Void = {}
    var onPasteImages: ([PendingImage]) -> Void = { _ in }
    var onPasteFailure: (String) -> Void = { _ in }

    override var keyCommands: [UIKeyCommand]? {
        #if !targetEnvironment(macCatalyst)
        guard traitCollection.userInterfaceIdiom == .pad else { return super.keyCommands }
        #endif
        let newlineKeys: [UIKeyModifierFlags] = [.shift, .alternate]
        let newlines = newlineKeys.map { flags in
            let command = UIKeyCommand(input: "\r", modifierFlags: flags, action: #selector(insertNewline(_:)))
            command.wantsPriorityOverSystemBehavior = true
            return command
        }
        let send = UIKeyCommand(input: "\r", modifierFlags: [], action: #selector(sendWithReturn(_:)))
        send.wantsPriorityOverSystemBehavior = true
        return newlines + [send]
    }

    @objc private func sendWithReturn(_ command: UIKeyCommand) { onSend() }
    @objc private func insertNewline(_ command: UIKeyCommand) { insertText("\n") }

    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        if action == #selector(paste(_:)), !pastedFileURLs.isEmpty || UIPasteboard.general.hasImages { return true }
        return super.canPerformAction(action, withSender: sender)
    }

    // コピーした画像ファイル（Finderなど）はファイル本体を、コピーした画像はその画像を添付にする。
    // ファイルのコピーはアイコン画像も一緒に載るため、ファイルを先に見る。
    override func paste(_ sender: Any?) {
        let pasteboard = UIPasteboard.general
        let files = pastedFileURLs
        if !files.isEmpty {
            do { onPasteImages(try files.map(PendingImage.init(fileURL:))) }
            catch { onPasteFailure(error.localizedDescription) }
            return
        }
        if pasteboard.hasImages {
            let images = pasteboard.items.compactMap { item -> PendingImage? in
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

    private var pastedFileURLs: [URL] {
        guard UIPasteboard.general.hasURLs else { return [] }
        return (UIPasteboard.general.urls ?? []).filter(\.isFileURL)
    }
}

private struct MessageRow: View {
    let message: TimelineMessage
    let isRoom: Bool
    let bot: Bot?
    let bots: [Bot]
    let api: BellAPI
    @State private var showingPeer = false

    private var senderName: String? {
        if message.isPeer { return message.peerName }
        if isRoom && !message.isOutgoing { return message.sender?.title }
        return nil
    }
    private var senderBot: Bot? { bots.first { $0.id == message.sender?.id } }
    private var bubbleAccent: Color { AvatarTone.accent(for: isRoom ? senderBot : bot) }
    private var hasImageStack: Bool { message.displayedImageURLs.count > 1 }
    private var hasBubbleContent: Bool {
        !hasImageStack || message.message?.isEmpty == false || replyLabel != nil
    }
    private var replyLabel: String? {
        guard isRoom, let routing = message.routing else { return nil }
        switch routing.status {
        case "pending": return "返信者を判定中"
        case "failed": return "返信者の判定に失敗"
        case "ready":
            let names = routing.responders.map { id in bots.first { $0.id == id }?.displayName ?? id }
            return "返信: \(names.isEmpty ? "なし" : names.joined(separator: "、"))"
        default: return nil
        }
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
        case "queued": "送信待ち"
        case "running": "処理中"
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
                    AuthenticatedImage(path: paths[0], api: api)
                        .frame(maxWidth: 230)
                        .accessibilityIdentifier("message-image-\(messageID)-0")
                } else {
                    ZStack {
                        ForEach(Array(paths.prefix(3).enumerated()).reversed(), id: \.offset) { depth, path in
                            AuthenticatedImage(path: path, api: api, fillsFrame: true)
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
                    AuthenticatedImage(path: path, api: api)
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
                                            AuthenticatedImage(path: path, api: api, fillsFrame: true)
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
        .task(id: path) {
            do { image = UIImage(data: try await api.image(path)) }
            catch {
                failed = true
                api.diagnostics.report(error, path: path, method: "GET", observation: .read(error, retainedData: image != nil))
            }
        }
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
        }
    }
}

private struct ScreenResponse: Decodable {
    let online: Bool
    let screen: String
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
                SelectableText(screen.isEmpty ? (online ? "画面は空です" : "次のメッセージで起動します") : screen,
                               font: .monospacedSystemFont(ofSize: 12, weight: .regular))
                    .frame(maxWidth: .infinity, alignment: .topLeading)
                    .padding(16)
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
                online = result.online
                screen = result.screen
                errorText = nil
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
