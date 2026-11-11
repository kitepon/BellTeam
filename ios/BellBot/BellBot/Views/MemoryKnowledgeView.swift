import SwiftUI

/// Screens pushed from the member editor (docs/architecture/modules/apple/memory-and-sheets.md).
enum MemberToolScreen: Hashable {
    case memory, sheets

    var title: String { self == .memory ? "記憶と知識" : "キャラクターシート" }
    var detail: String { self == .memory ? "長期記憶と知識を、覚えさせたり探したりする" : "メンバーが自分を描く時の正本の画像" }
    var symbol: String { self == .memory ? "brain.head.profile" : "person.crop.rectangle.stack.fill" }
    var tint: Color { self == .memory ? .purple : .pink }

    #if DEBUG
    /// `-bellbot-preview-member-screen memory | sheets` opens that screen on top of the member editor for screenshots.
    static var preview: MemberToolScreen? {
        let arguments = ProcessInfo.processInfo.arguments
        guard let index = arguments.firstIndex(of: "-bellbot-preview-member-screen"), arguments.indices.contains(index + 1) else { return nil }
        switch arguments[index + 1] {
        case "memory": return .memory
        case "sheets": return .sheets
        default: return nil
        }
    }
    #endif
}

/// The member editor's two rows (Web: 「記憶と知識」 and 「キャラクターシート」 buttons of the member dialog).
struct MemberToolRows: View {
    var body: some View {
        Section(header: BellSectionHeader("記憶とキャラクターシート")) {
            row(.memory, id: "member-memory-row")
            row(.sheets, id: "member-sheets-row")
        }
    }

    private func row(_ screen: MemberToolScreen, id: String) -> some View {
        NavigationLink(value: screen) {
            HStack(spacing: 12) {
                SettingsIconTile(symbol: screen.symbol, tint: screen.tint)
                VStack(alignment: .leading, spacing: 2) {
                    Text(screen.title).font(BellTheme.controlsFont)
                    Text(screen.detail).font(BellTheme.secondaryFont).foregroundStyle(.secondary).lineLimit(2)
                }
            }
            .padding(.vertical, 3)
        }
        .accessibilityIdentifier(id)
    }
}

/// The destination for a `MemberToolScreen` of one member.
struct MemberToolDestination: View {
    let screen: MemberToolScreen
    let bot: Bot
    @EnvironmentObject private var store: AppStore

    var body: some View {
        switch screen {
        case .memory: MemberMemoryScreen(bot: bot, store: store)
        case .sheets: CharacterSheetScreen(bot: bot, store: store)
        }
    }
}

private struct ToolHeader: View {
    let screen: MemberToolScreen
    var showsDetail = true

    var body: some View {
        VStack(spacing: 8) {
            SettingsIconTile(symbol: screen.symbol, tint: screen.tint, side: 56)
            if showsDetail { Text(screen.detail).font(BellTheme.detailFont).foregroundStyle(.secondary).multilineTextAlignment(.center) }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 6)
    }
}

private extension MemoryKind {
    var tint: Color {
        switch self {
        case .fact: .blue
        case .preference: .pink
        case .policy: .indigo
        case .task: .orange
        case .config: .gray
        case .incident: .red
        case .relationship: .teal
        case .episode: .purple
        case .growth: .green
        }
    }
}

/// The kind of a recalled memory in Japanese, in a small tinted capsule. A kind this app does not know keeps the server's word.
private struct KindBadge: View {
    let raw: String

    var body: some View {
        let kind = MemoryKind(rawValue: raw)
        Label(MemoryKind.label(forRaw: raw), systemImage: kind?.symbol ?? "tag.fill")
            .font(BellTheme.secondaryFont.weight(.semibold))
            .foregroundStyle(kind?.tint ?? .gray)
            .padding(.horizontal, 9).padding(.vertical, 3)
            .background((kind?.tint ?? .gray).opacity(0.14), in: Capsule())
    }
}

private struct PanelHeader: View {
    let title: String
    let symbol: String
    let tint: Color

    var body: some View {
        HStack(spacing: 8) {
            SettingsIconTile(symbol: symbol, tint: tint, side: 22)
            BellSectionHeader(title)
        }
    }
}

private struct ScopePicker: View {
    @Binding var selection: MemoryScope
    let id: String

    var body: some View {
        Picker("保存先", selection: $selection) {
            ForEach(MemoryScope.allCases) { Text($0.label).tag($0) }
        }
        .accessibilityIdentifier(id)
    }
}

private struct PanelButton: View {
    let title: String
    let symbol: String
    let busy: Bool
    let enabled: Bool
    let id: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if busy { ProgressView().controlSize(.small) } else { Image(systemName: symbol) }
                Text(title)
            }
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .disabled(busy || !enabled)
        .accessibilityIdentifier(id)
    }
}

struct MemberMemoryScreen: View {
    let bot: Bot
    @StateObject private var model: MemoryScreenModel

    init(bot: Bot, store: AppStore) {
        self.bot = bot
        _model = StateObject(wrappedValue: MemoryScreenModel(botID: bot.id, api: store.api) { [weak store] in store?.requireLogin(for: $0) })
    }

    var body: some View {
        Form {
            Section { ToolHeader(screen: .memory) }.listRowBackground(Color.clear)
            if model.unsupported {
                Section { TerminalsCalmLine(text: MemberToolError.memoryUnsupportedLine, identifier: "memory-unsupported") }
            }
            rememberPanel
            recallPanel
            knowledgePanel
            searchPanel
        }
        .scrollContentBackground(.hidden)
        .scrollDismissesKeyboard(.interactively)
        .toolbar {
            // A multi-line field has no Return that leaves it; this closes the keyboard so the buttons below show.
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("閉じる") { UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil) }
                    .accessibilityIdentifier("keyboard-close")
            }
        }
        .background(BellBackground())
        .navigationTitle("\(bot.displayName)の記憶と知識")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var rememberPanel: some View {
        Section(header: PanelHeader(title: "長期記憶を追加", symbol: "square.and.pencil", tint: .purple)) {
            Picker("種類", selection: $model.rememberKind) {
                ForEach(MemoryKind.allCases) { Label($0.label, systemImage: $0.symbol).tag($0) }
            }
            .accessibilityIdentifier("remember-kind")
            ScopePicker(selection: $model.rememberScope, id: "remember-scope")
            TextField("覚えさせたい内容", text: $model.rememberContent, axis: .vertical).lineLimit(3...8)
                .accessibilityIdentifier("remember-content")
            PanelButton(title: "記憶する", symbol: "checkmark.circle.fill", busy: model.sending.contains(.remember),
                        enabled: model.canRemember, id: "remember-submit") { Task { await model.remember() } }
            if let note = model.rememberNote {
                Label(note, systemImage: "checkmark.circle.fill").foregroundStyle(BellTheme.mint)
                    .accessibilityIdentifier("remember-note")
            }
            failureLine(.remember)
        }
    }

    private var recallPanel: some View {
        Section(header: PanelHeader(title: "長期記憶を検索", symbol: "magnifyingglass", tint: .indigo)) {
            ScopePicker(selection: $model.recallScope, id: "recall-scope")
            TextField("検索語", text: $model.recallQuery).submitLabel(.search)
                .onSubmit { Task { await model.recall() } }
                .accessibilityIdentifier("recall-query")
            PanelButton(title: "検索", symbol: "magnifyingglass", busy: false, enabled: model.canRecall, id: "recall-submit") { Task { await model.recall() } }
            failureLine(.recall)
            switch model.recallResults {
            case .none: EmptyView()
            case .empty: notFound(id: "recall-empty")
            case .items(let items):
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    VStack(alignment: .leading, spacing: 6) {
                        KindBadge(raw: item.kind)
                        Text(item.content).font(BellTheme.controlsFont).textSelection(.enabled)
                    }
                    .padding(.vertical, 3)
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel(item.rowText)
                    .accessibilityIdentifier("memory-result-\(index)")
                }
            }
        }
    }

    private var knowledgePanel: some View {
        Section(header: PanelHeader(title: "知識を追加", symbol: "books.vertical.fill", tint: .orange)) {
            ScopePicker(selection: $model.knowledgeScope, id: "knowledge-scope")
            TextField("タイトル", text: $model.knowledgeTitle).accessibilityIdentifier("knowledge-title")
            TextField("内容", text: $model.knowledgeContent, axis: .vertical).lineLimit(4...10)
                .accessibilityIdentifier("knowledge-content")
            PanelButton(title: "知識を保存", symbol: "tray.and.arrow.down.fill", busy: model.sending.contains(.knowledge),
                        enabled: model.canSaveKnowledge, id: "knowledge-submit") { Task { await model.saveKnowledge() } }
            if let note = model.knowledgeNote {
                Label(note, systemImage: "checkmark.circle.fill").foregroundStyle(BellTheme.mint)
                    .accessibilityIdentifier("knowledge-note")
            }
            failureLine(.knowledge)
        }
    }

    private var searchPanel: some View {
        Section(header: PanelHeader(title: "知識を検索", symbol: "doc.text.magnifyingglass", tint: .teal)) {
            ScopePicker(selection: $model.searchScope, id: "knowledge-search-scope")
            TextField("検索語", text: $model.searchQuery).submitLabel(.search)
                .onSubmit { Task { await model.searchKnowledge() } }
                .accessibilityIdentifier("knowledge-query")
            PanelButton(title: "検索", symbol: "magnifyingglass", busy: false, enabled: model.canSearch, id: "knowledge-search-submit") { Task { await model.searchKnowledge() } }
            failureLine(.search)
            switch model.searchResults {
            case .none: EmptyView()
            case .empty: notFound(id: "knowledge-empty")
            case .items(let items):
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(item.title).font(BellTheme.controlsFont.weight(.semibold))
                        Text(item.excerpt).font(BellTheme.detailFont).foregroundStyle(.secondary)
                    }
                    .textSelection(.enabled)
                    .padding(.vertical, 3)
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel(item.rowText)
                    .accessibilityIdentifier("knowledge-result-\(index)")
                }
            }
        }
    }

    @ViewBuilder private func failureLine(_ panel: MemoryScreenModel.Panel) -> some View {
        if let failure = model.failure, failure.panel == panel {
            Label(failure.text, systemImage: "exclamationmark.triangle.fill").font(BellTheme.detailFont).foregroundStyle(.red)
                .accessibilityIdentifier("memory-error")
        }
    }

    private func notFound(id: String) -> some View {
        Label(MemoryScreenModel.notFoundNote, systemImage: "questionmark.circle").foregroundStyle(.secondary)
            .accessibilityIdentifier(id)
    }
}

struct CharacterSheetScreen: View {
    let bot: Bot
    @StateObject private var model: CharacterSheetModel

    init(bot: Bot, store: AppStore) {
        self.bot = bot
        _model = StateObject(wrappedValue: CharacterSheetModel(botID: bot.id, api: store.api) { [weak store] in store?.requireLogin(for: $0) })
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 18) {
                ToolHeader(screen: .sheets, showsDetail: false)
                Text(CharacterSheetCaption.note).font(BellTheme.secondaryFont).foregroundStyle(.secondary)
                switch model.content {
                case .loading:
                    ProgressView("読み込んでいます…").padding(.top, 24)
                case .unsupported:
                    TerminalsCalmLine(text: MemberToolError.sheetsUnsupportedLine, identifier: "sheets-unsupported")
                case .failed(let line):
                    Label(line, systemImage: "exclamationmark.triangle.fill").font(BellTheme.detailFont).foregroundStyle(.red)
                        .accessibilityIdentifier("character-sheet-error")
                case .sheets(let entries) where entries.isEmpty:
                    Label(CharacterSheetCaption.emptyNote, systemImage: "photo.on.rectangle.angled").font(BellTheme.controlsFont)
                        .foregroundStyle(.secondary).padding(.top, 12)
                        .accessibilityIdentifier("character-sheet-empty")
                case .sheets(let entries):
                    ForEach(entries) { SheetCard(entry: $0) }
                }
            }
            .frame(maxWidth: 720)
            .padding(.horizontal, 16).padding(.bottom, 24)
            .frame(maxWidth: .infinity)
        }
        .background(BellBackground())
        .navigationTitle("\(bot.displayName)のキャラクターシート")
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.load() }
    }
}

private struct SheetCard: View {
    let entry: CharacterSheetModel.Entry

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Group {
                if let image = entry.image {
                    Image(uiImage: image).resizable().scaledToFit().accessibilityLabel(entry.file)
                } else {
                    ZStack { Color.white.opacity(0.6); ProgressView() }.aspectRatio(3.0 / 4.0, contentMode: .fit)
                }
            }
            .frame(maxWidth: .infinity)
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(BellTheme.line.opacity(0.8)))
            .accessibilityIdentifier("character-sheet-image-\(entry.file)")
            Label(entry.caption, systemImage: "clock").font(BellTheme.secondaryFont).foregroundStyle(.secondary)
                .accessibilityIdentifier("character-sheet-caption-\(entry.file)")
        }
    }
}
