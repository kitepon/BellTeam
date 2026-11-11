import Foundation

// Member memory and knowledge (docs/architecture/modules/apple/memory-and-sheets.md). Same contract as web/memory-view.js:
// POST|GET /api/bots/:id/memory and /api/bots/:id/knowledge. Only the fields Web reads are decoded; the rest (ids, importance, pins) is ignored.

/// The nine memory kinds of the Web form (web/index.html #remember-kind). Raw values are what the server stores.
enum MemoryKind: String, CaseIterable, Identifiable {
    case fact, preference, policy, task, config, incident, relationship, episode, growth

    var id: String { rawValue }

    var label: String {
        switch self {
        case .fact: "事実"
        case .preference: "好み"
        case .policy: "方針"
        case .task: "継続中の仕事"
        case .config: "設定"
        case .incident: "出来事"
        case .relationship: "関係"
        case .episode: "思い出"
        case .growth: "成長"
        }
    }

    var symbol: String {
        switch self {
        case .fact: "checkmark.seal.fill"
        case .preference: "heart.fill"
        case .policy: "flag.fill"
        case .task: "checklist"
        case .config: "gearshape.fill"
        case .incident: "exclamationmark.bubble.fill"
        case .relationship: "person.2.fill"
        case .episode: "photo.fill"
        case .growth: "leaf.fill"
        }
    }

    /// The label for a server `kind`. A kind this app does not know is shown as the server wrote it, never hidden.
    static func label(forRaw raw: String) -> String { MemoryKind(rawValue: raw)?.label ?? raw }
}

/// Where a memory or knowledge item is kept: this member only, or shared by every member (web/index.html scope options).
enum MemoryScope: String, CaseIterable, Identifiable {
    case personal, shared

    var id: String { rawValue }
    var label: String { self == .personal ? "このBot" : "BellTeam共通" }
}

struct MemoryItem: Decodable, Equatable {
    var kind = ""
    var content = ""

    init(kind: String = "", content: String = "") { self.kind = kind; self.content = content }

    private enum CodingKeys: String, CodingKey { case kind, content }

    /// Only `kind` and `content` are read; a missing or mistyped one reads as empty text.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = (try? c.decodeIfPresent(String.self, forKey: .kind)) ?? ""
        content = (try? c.decodeIfPresent(String.self, forKey: .content)) ?? ""
    }

    /// Accessibility text and tests: 「[事実] 内容」, the Web row with the Japanese kind.
    var rowText: String { "[\(MemoryKind.label(forRaw: kind))] \(content)" }
}

struct KnowledgeItem: Decodable, Equatable {
    var title = ""
    var excerpt = ""

    init(title: String = "", excerpt: String = "") { self.title = title; self.excerpt = excerpt }

    private enum CodingKeys: String, CodingKey { case title, excerpt }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        title = (try? c.decodeIfPresent(String.self, forKey: .title)) ?? ""
        excerpt = (try? c.decodeIfPresent(String.self, forKey: .excerpt)) ?? ""
    }

    /// Web row text: the title, then the excerpt on its own line.
    var rowText: String { "\(title)\n\(excerpt)" }
}

struct MemoryRecallResponse: Decodable { let items: [MemoryItem] }
struct KnowledgeSearchResponse: Decodable { let items: [KnowledgeItem] }

struct MemoryBody: Encodable, Equatable, Sendable {
    let kind: String
    let scope: String
    let content: String
}

struct KnowledgeBody: Encodable, Equatable, Sendable {
    let scope: String
    let title: String
    let content: String
}

/// Paths of the member memory, knowledge and character-sheet routes.
enum MemberToolRoutes {
    static func memory(_ botID: String) -> String { "/api/bots/\(botID)/memory" }
    static func knowledge(_ botID: String) -> String { "/api/bots/\(botID)/knowledge" }
    static func characterSheets(_ botID: String) -> String { "/api/bots/\(botID)/character-sheet" }

    static func recall(botID: String, query: String, scope: MemoryScope) -> String { search(memory(botID), query, scope) }
    static func knowledgeSearch(botID: String, query: String, scope: MemoryScope) -> String { search(knowledge(botID), query, scope) }

    private static func search(_ base: String, _ query: String, _ scope: MemoryScope) -> String {
        "\(base)?query=\(encode(query))&scope=\(scope.rawValue)"
    }

    /// Same set as JavaScript's encodeURIComponent for ASCII: letters, digits and - _ . ! ~ * ' ( ) stay; everything else (including every non-ASCII letter) is escaped.
    static func encode(_ value: String) -> String {
        var allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")
        allowed.insert(charactersIn: "-_.!~*'()")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }
}

enum MemberToolError {
    /// A route this BellTeam does not have (an older body): 405, or a 404 that is not BOT_NOT_FOUND. A missing member (BOT_NOT_FOUND) is a failure, not "unsupported".
    static func isUnsupported(_ error: Error) -> Bool {
        guard case BellAPIError.httpStatus(let status, _, _) = error else { return false }
        return status == 405 || (status == 404 && TerminalErrorText.code(error) != "BOT_NOT_FOUND")
    }

    static let memoryUnsupportedLine = "このBellTeamはまだ記憶と知識に対応していません"
    static let sheetsUnsupportedLine = "このBellTeamはまだキャラクターシートに対応していません"
}

/// One open memory screen of one member. A new model per screen: closing the screen, or opening another member, drops every result.
@MainActor
final class MemoryScreenModel: ObservableObject {
    enum Panel: Equatable { case remember, recall, knowledge, search }
    /// A search outcome: nothing asked yet, no hit (「見つかりませんでした。」), or the hits.
    enum Results<Item: Equatable>: Equatable { case none, empty, items([Item]) }

    static let rememberedNote = "記憶しました。"
    static let knowledgeSavedNote = "知識を保存しました。"
    static let notFoundNote = "見つかりませんでした。"

    let botID: String
    private let api: BellAPI
    private let requireLogin: @MainActor (Error) -> Void

    @Published var rememberKind = MemoryKind.fact
    @Published var rememberScope = MemoryScope.personal
    @Published var rememberContent = ""
    @Published var recallScope = MemoryScope.personal
    @Published var recallQuery = ""
    @Published var knowledgeScope = MemoryScope.personal
    @Published var knowledgeTitle = ""
    @Published var knowledgeContent = ""
    @Published var searchScope = MemoryScope.personal
    @Published var searchQuery = ""

    @Published private(set) var rememberNote: String?
    @Published private(set) var knowledgeNote: String?
    @Published private(set) var recallResults = Results<MemoryItem>.none
    @Published private(set) var searchResults = Results<KnowledgeItem>.none
    /// The one failure line, with the panel it belongs to (Web has one error element; it is cleared when any action starts).
    @Published private(set) var failure: (panel: Panel, text: String)?
    @Published private(set) var sending: Set<Panel> = []
    @Published private(set) var unsupported = false
    private var recallSequence = 0
    private var searchSequence = 0

    init(botID: String, api: BellAPI, requireLogin: @escaping @MainActor (Error) -> Void) {
        self.botID = botID
        self.api = api
        self.requireLogin = requireLogin
    }

    var canRemember: Bool { !sending.contains(.remember) && !rememberContent.isEmpty && !unsupported }
    var canSaveKnowledge: Bool { !sending.contains(.knowledge) && !knowledgeTitle.isEmpty && !knowledgeContent.isEmpty && !unsupported }
    var canRecall: Bool { !recallQuery.isEmpty && !unsupported }
    var canSearch: Bool { !searchQuery.isEmpty && !unsupported }

    private var rememberBody: MemoryBody { MemoryBody(kind: rememberKind.rawValue, scope: rememberScope.rawValue, content: rememberContent) }
    private var knowledgeBody: KnowledgeBody { KnowledgeBody(scope: knowledgeScope.rawValue, title: knowledgeTitle, content: knowledgeContent) }

    /// One POST. The content is cleared only if it was not edited while the request ran (as Web).
    func remember() async {
        guard canRemember else { return }
        let body = rememberBody
        await write(.remember, path: MemberToolRoutes.memory(botID), body: body, label: "記憶できませんでした") {
            if self.rememberBody == body { self.rememberContent = "" }
            self.rememberNote = Self.rememberedNote
        }
    }

    func saveKnowledge() async {
        guard canSaveKnowledge else { return }
        let body = knowledgeBody
        await write(.knowledge, path: MemberToolRoutes.knowledge(botID), body: body, label: "保存できませんでした") {
            if self.knowledgeBody == body {
                self.knowledgeScope = .personal; self.knowledgeTitle = ""; self.knowledgeContent = ""
            }
            self.knowledgeNote = Self.knowledgeSavedNote
        }
    }

    func recall() async {
        guard canRecall else { return }
        recallSequence += 1
        let mine = recallSequence
        failure = nil
        let path = MemberToolRoutes.recall(botID: botID, query: recallQuery, scope: recallScope)
        do {
            let response: MemoryRecallResponse = try await api.get(path)
            guard mine == recallSequence else { return }
            recallResults = response.items.isEmpty ? .empty : .items(response.items)
        } catch { readFailed(error, panel: .recall, mine == recallSequence, route: MemberToolRoutes.memory(":id"), retained: recallResults != .none) }
    }

    func searchKnowledge() async {
        guard canSearch else { return }
        searchSequence += 1
        let mine = searchSequence
        failure = nil
        let path = MemberToolRoutes.knowledgeSearch(botID: botID, query: searchQuery, scope: searchScope)
        do {
            let response: KnowledgeSearchResponse = try await api.get(path)
            guard mine == searchSequence else { return }
            searchResults = response.items.isEmpty ? .empty : .items(response.items)
        } catch { readFailed(error, panel: .search, mine == searchSequence, route: MemberToolRoutes.knowledge(":id"), retained: searchResults != .none) }
    }

    private func write<Body: Encodable & Sendable>(_ panel: Panel, path: String, body: Body, label: String, done: () -> Void) async {
        sending.insert(panel)
        failure = nil
        if panel == .remember { rememberNote = nil } else { knowledgeNote = nil }
        defer { sending.remove(panel) }
        do {
            let _: APIAcknowledgement = try await api.post(path, body: body)
            done()
        } catch let error where BellAPIError.isAuthenticationError(error) { requireLogin(error) }
        catch {
            if MemberToolError.isUnsupported(error) { unsupported = true; return }
            failure = (panel, "\(label)（\(BellAPIError.operationFailureMessage(error))）")
            api.diagnostics.report(error, path: path.replacingOccurrences(of: botID, with: ":id"), method: "POST", observation: .write)
        }
    }

    private func readFailed(_ error: Error, panel: Panel, _ current: Bool, route: String, retained: Bool) {
        if BellAPIError.isAuthenticationError(error) { requireLogin(error); return }
        guard current else { return }
        if MemberToolError.isUnsupported(error) { unsupported = true; return }
        failure = (panel, "検索できませんでした（\(error.localizedDescription)）")
        api.diagnostics.report(error, path: route, method: "GET", observation: .read(error, retainedData: retained))
    }
}
