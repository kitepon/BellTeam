import Foundation
import UIKit
import XCTest
@testable import BellBot

/// apple/memory-and-sheets.md: kind labels, row text, query encoding, "older body" detection, the memory screen's request rules
/// (one POST, latest search wins, one failure line) and the character-sheet list/caption/load.
@MainActor
final class MemoryKnowledgeTests: XCTestCase {
    override func setUp() { MemoryProtocol.reset() }

    // MARK: pure helpers

    func testNineKindsHaveTheWebLabelsAndAnUnknownKindKeepsTheServerWord() {
        let web: [(String, String)] = [("fact", "事実"), ("preference", "好み"), ("policy", "方針"), ("task", "継続中の仕事"), ("config", "設定"),
                                       ("incident", "出来事"), ("relationship", "関係"), ("episode", "思い出"), ("growth", "成長")]
        XCTAssertEqual(MemoryKind.allCases.map(\.rawValue), web.map(\.0), "Webの選択肢と同じ順")
        for (raw, label) in web { XCTAssertEqual(MemoryKind.label(forRaw: raw), label) }
        XCTAssertEqual(MemoryKind.label(forRaw: "new-kind"), "new-kind")
        XCTAssertEqual(Set(MemoryKind.allCases.map(\.symbol)).count, 9, "種類ごとに別のアイコン")
        XCTAssertEqual(MemoryScope.personal.label, "このBot")
        XCTAssertEqual(MemoryScope.shared.label, "BellTeam共通")
    }

    func testResultRowTextUsesTheJapaneseKindAndDecodingReadsOnlyWhatWebReads() throws {
        let recall = try JSONDecoder().decode(MemoryRecallResponse.self, from: Data(#"""
        {"scope":"personal","items":[{"id":"m1","kind":"preference","content":"朝は紅茶","importance":3,"observedAt":"2026-11-01T00:00:00Z","metadata":{"pinned":true},"match":"partial"},{"kind":"zzz"}]}
        """#.utf8))
        XCTAssertEqual(recall.items[0].rowText, "[好み] 朝は紅茶")
        XCTAssertEqual(recall.items[1].rowText, "[zzz] ", "欠けた項目は空の文字")
        let knowledge = try JSONDecoder().decode(KnowledgeSearchResponse.self, from: Data(#"""
        {"items":[{"id":"k1","title":"手順 > 準備","excerpt":"最初に…","path":"notes/k1.md","line":12,"tags":["a"],"createdAt":"2026-11-01"}]}
        """#.utf8))
        XCTAssertEqual(knowledge.items[0].rowText, "手順 > 準備\n最初に…")
    }

    func testSearchPathsEscapeLikeEncodeURIComponent() {
        XCTAssertEqual(MemberToolRoutes.recall(botID: "bot-one", query: "紅茶 & 朝=1?#/+", scope: .shared),
                       "/api/bots/bot-one/memory?query=%E7%B4%85%E8%8C%B6%20%26%20%E6%9C%9D%3D1%3F%23%2F%2B&scope=shared")
        XCTAssertEqual(MemberToolRoutes.knowledgeSearch(botID: "bot-two", query: "a-b_c.d!e~f*g'h(i)", scope: .personal),
                       "/api/bots/bot-two/knowledge?query=a-b_c.d!e~f*g'h(i)&scope=personal")
        XCTAssertEqual(MemberToolRoutes.characterSheets("bot-one"), "/api/bots/bot-one/character-sheet")
    }

    func testOnlyARouteTheOlderBodyLacksCountsAsUnsupported() {
        XCTAssertTrue(MemberToolError.isUnsupported(BellAPIError.httpStatus(404, "NOT_FOUND")))
        XCTAssertTrue(MemberToolError.isUnsupported(BellAPIError.httpStatus(404, nil)))
        XCTAssertTrue(MemberToolError.isUnsupported(BellAPIError.httpStatus(405, "METHOD_NOT_ALLOWED")))
        XCTAssertFalse(MemberToolError.isUnsupported(BellAPIError.httpStatus(404, "BOT_NOT_FOUND")), "メンバーが居ないのは未対応ではない")
        XCTAssertFalse(MemberToolError.isUnsupported(BellAPIError.httpStatus(503, "MEMORY_UNAVAILABLE")))
        XCTAssertFalse(MemberToolError.isUnsupported(URLError(.notConnectedToInternet)))
    }

    // MARK: memory screen

    func testRememberPostsOnceWhileSendingThenClearsTheContentAndSaysSo() async throws {
        MemoryProtocol.respond = { _ in .json(201, #"{"id":"m1"}"#, delay: 0.3) }
        let model = makeModel()
        model.rememberKind = .policy; model.rememberScope = .shared; model.rememberContent = "週に一度まとめる"
        let first = Task { await model.remember() }
        try await waitUntil { model.sending.contains(.remember) }
        XCTAssertFalse(model.canRemember, "送信中は押せない")
        await model.remember()
        await first.value
        let posts = MemoryProtocol.seen.filter { $0.method == "POST" }
        XCTAssertEqual(posts.count, 1)
        XCTAssertEqual(posts[0].target, "/api/bots/bot-one/memory")
        XCTAssertEqual(try JSONSerialization.jsonObject(with: Data(posts[0].body.utf8)) as? [String: String],
                       ["kind": "policy", "scope": "shared", "content": "週に一度まとめる"])
        XCTAssertEqual(model.rememberContent, "")
        XCTAssertEqual(model.rememberNote, "記憶しました。")
        XCTAssertNil(model.failure)
        XCTAssertTrue(model.sending.isEmpty)
    }

    func testEditingWhileSendingKeepsTheNewTextAndKnowledgeSaveResetsTheForm() async throws {
        MemoryProtocol.respond = { _ in .json(201, #"{"id":"x"}"#, delay: 0.2) }
        let model = makeModel()
        model.rememberContent = "古い文"
        let sending = Task { await model.remember() }
        try await waitUntil { model.sending.contains(.remember) }
        model.rememberContent = "古い文に足した"
        await sending.value
        XCTAssertEqual(model.rememberContent, "古い文に足した", "送った後に変えた文は消さない")

        model.knowledgeScope = .shared; model.knowledgeTitle = "手順"; model.knowledgeContent = "本文"
        await model.saveKnowledge()
        XCTAssertEqual(MemoryProtocol.seen.last?.target, "/api/bots/bot-one/knowledge")
        XCTAssertEqual(model.knowledgeNote, "知識を保存しました。")
        XCTAssertEqual([model.knowledgeTitle, model.knowledgeContent], ["", ""])
        XCTAssertEqual(model.knowledgeScope, .personal)
    }

    func testRecallListsItemsOrSaysNothingWasFoundAndAnEmptyQueryIsNotSent() async {
        let model = makeModel()
        await model.recall()
        XCTAssertTrue(MemoryProtocol.seen.isEmpty, "検索語が空なら送らない")
        MemoryProtocol.respond = { request in
            request.url!.query!.contains("hit")
                ? .json(200, #"{"items":[{"kind":"fact","content":"紅茶が好き"},{"kind":"task","content":"週報"}]}"#)
                : .json(200, #"{"items":[]}"#)
        }
        model.recallQuery = "hit 紅茶"; model.recallScope = .shared
        await model.recall()
        XCTAssertEqual(MemoryProtocol.seen.last?.target, "/api/bots/bot-one/memory?query=hit%20%E7%B4%85%E8%8C%B6&scope=shared")
        XCTAssertEqual(model.recallResults, .items([MemoryItem(kind: "fact", content: "紅茶が好き"), MemoryItem(kind: "task", content: "週報")]))
        model.recallQuery = "none"
        await model.recall()
        XCTAssertEqual(model.recallResults, .empty)
        XCTAssertEqual(MemoryScreenModel.notFoundNote, "見つかりませんでした。")
    }

    func testOnlyTheNewestSearchWritesTheResults() async throws {
        MemoryProtocol.respond = { request in
            request.url!.query!.contains("slow")
                ? .json(200, #"{"items":[{"title":"古い","excerpt":"遅い答え"}]}"#, delay: 0.4)
                : .json(200, #"{"items":[{"title":"新しい","excerpt":"速い答え"}]}"#)
        }
        let model = makeModel()
        model.searchQuery = "slow"
        let slow = Task { await model.searchKnowledge() }
        try await waitUntil { MemoryProtocol.seen.count == 1 }
        model.searchQuery = "fast"
        await model.searchKnowledge()
        await slow.value
        XCTAssertEqual(model.searchResults, .items([KnowledgeItem(title: "新しい", excerpt: "速い答え")]))
    }

    func testFailuresShowOneLineOnTheirPanelAndTheNextActionClearsIt() async {
        MemoryProtocol.respond = { _ in .json(500, #"{"error":"MEMORY_BROKEN"}"#) }
        let model = makeModel()
        model.rememberContent = "x"
        await model.remember()
        XCTAssertEqual(model.failure?.panel, .remember)
        XCTAssertTrue(model.failure?.text.hasPrefix("記憶できませんでした（") == true)
        XCTAssertEqual(model.rememberContent, "x", "失敗した文は残す")
        XCTAssertNil(model.rememberNote)
        model.recallQuery = "q"
        await model.recall()
        XCTAssertEqual(model.failure?.panel, .recall, "表示は常に1つ")
        XCTAssertTrue(model.failure?.text.hasPrefix("検索できませんでした（BellTeamで問題が起きています") == true)
        model.knowledgeTitle = "t"; model.knowledgeContent = "c"
        await model.saveKnowledge()
        XCTAssertTrue(model.failure?.text.hasPrefix("保存できませんでした（") == true)
        XCTAssertEqual(model.failure?.panel, .knowledge)
        MemoryProtocol.respond = { _ in .json(200, #"{"items":[]}"#) }
        model.searchQuery = "q"
        await model.searchKnowledge()
        XCTAssertNil(model.failure)
    }

    func testARouteTheBodyLacksTurnsTheScreenIntoOneCalmLine() async {
        MemoryProtocol.respond = { _ in .json(404, #"{"error":"NOT_FOUND"}"#) }
        let model = makeModel()
        model.recallQuery = "q"
        await model.recall()
        XCTAssertTrue(model.unsupported)
        XCTAssertNil(model.failure)
        XCTAssertFalse(model.canRemember)
        XCTAssertEqual(MemberToolError.memoryUnsupportedLine, "このBellTeamはまだ記憶と知識に対応していません")
        MemoryProtocol.respond = { _ in .json(404, #"{"error":"BOT_NOT_FOUND"}"#) }
        let missing = makeModel()
        missing.recallQuery = "q"
        await missing.recall()
        XCTAssertFalse(missing.unsupported)
        XCTAssertEqual(missing.failure?.panel, .recall)
    }

    // MARK: character sheets

    func testCaptionIsTheFileAndTheJapaneseDate() {
        let tokyo = TimeZone(secondsFromGMT: 9 * 3600)!
        XCTAssertEqual(CharacterSheetCaption.text(file: "front.png", updatedAt: "2026-11-10T03:04:05.123Z", timeZone: tokyo), "front.png（2026/11/10 12:04:05）")
        XCTAssertEqual(CharacterSheetCaption.text(file: "b.webp", updatedAt: "2026-01-02T00:05:09Z", timeZone: tokyo), "b.webp（2026/1/2 9:05:09）")
        XCTAssertEqual(CharacterSheetCaption.text(file: "c.png", updatedAt: "not a date", timeZone: tokyo), "c.png")
        XCTAssertEqual(CharacterSheetCaption.emptyNote, "まだ置かれていない。")
    }

    func testSheetsLoadEveryImageWithTheAppsAuthPathAndTheListDecodes() async throws {
        let png = Self.png()
        MemoryProtocol.respond = { request in
            let path = request.url!.path
            if path == "/api/bots/bot-one/character-sheet" {
                return .json(200, #"{"sheets":[{"file":"front.png","size":9,"updatedAt":"2026-11-10T03:04:05.000Z","url":"/api/bots/bot-one/character-sheet/front.png"},{"file":"日本語 1.png","updatedAt":"2026-11-09T00:00:00.000Z","url":"/api/bots/bot-one/character-sheet/%E6%97%A5%E6%9C%AC%E8%AA%9E%201.png"}]}"#)
            }
            return .image(png)
        }
        let model = CharacterSheetModel(botID: "bot-one", api: makeAPI(), requireLogin: { _ in })
        await model.load()
        await model.load() // a second appearance does not read again
        guard case .sheets(let entries) = model.content else { return XCTFail("\(model.content)") }
        XCTAssertEqual(entries.map(\.file), ["front.png", "日本語 1.png"])
        XCTAssertTrue(entries.allSatisfy { $0.image != nil })
        XCTAssertEqual(MemoryProtocol.seen.map(\.target), ["/api/bots/bot-one/character-sheet", "/api/bots/bot-one/character-sheet/front.png",
                                                            "/api/bots/bot-one/character-sheet/%E6%97%A5%E6%9C%AC%E8%AA%9E%201.png"])
    }

    func testEmptyListFailureAndOlderBodyEachShowOneState() async {
        MemoryProtocol.respond = { _ in .json(200, #"{"sheets":[]}"#) }
        let empty = CharacterSheetModel(botID: "bot-one", api: makeAPI(), requireLogin: { _ in })
        await empty.load()
        guard case .sheets(let entries) = empty.content else { return XCTFail() }
        XCTAssertTrue(entries.isEmpty)

        MemoryProtocol.respond = { request in
            request.url!.path.hasSuffix("character-sheet") ? .json(200, #"{"sheets":[{"file":"a.png","updatedAt":"2026-11-10T00:00:00Z","url":"/api/bots/bot-one/character-sheet/a.png"}]}"#)
                : .json(500, #"{"error":"SHEET_READ_FAILED"}"#)
        }
        let failing = CharacterSheetModel(botID: "bot-one", api: makeAPI(), requireLogin: { _ in })
        await failing.load()
        guard case .failed(let line) = failing.content else { return XCTFail("\(failing.content)") }
        XCTAssertTrue(line.hasPrefix("キャラクターシートを読めませんでした（"), "失敗したら一覧ごと1行にする")

        MemoryProtocol.respond = { _ in .json(404, #"{"error":"NOT_FOUND"}"#) }
        let old = CharacterSheetModel(botID: "bot-one", api: makeAPI(), requireLogin: { _ in })
        await old.load()
        guard case .unsupported = old.content else { return XCTFail("\(old.content)") }
    }

    // MARK: helpers

    private func makeAPI() -> BellAPI {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MemoryProtocol.self]
        return BellAPI(baseURL: URL(string: "https://memory-ui.test.invalid")!, session: URLSession(configuration: configuration),
                       diagnostics: BellDiagnostics(onReport: { _, _, _, _ in }), cookieStorage: configuration.httpCookieStorage!)
    }

    private func makeModel() -> MemoryScreenModel { MemoryScreenModel(botID: "bot-one", api: makeAPI(), requireLogin: { _ in }) }

    private func waitUntil(_ condition: @MainActor () -> Bool) async throws {
        for _ in 0..<200 {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("条件が成り立ちませんでした")
    }

    private static func png() -> Data {
        UIGraphicsImageRenderer(size: CGSize(width: 8, height: 8)).pngData { context in
            UIColor.systemPink.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 8, height: 8))
        }
    }
}

private final class MemoryProtocol: URLProtocol {
    struct Reply {
        let status: Int, type: String, body: Data, delay: TimeInterval
        static func json(_ status: Int, _ text: String, delay: TimeInterval = 0) -> Reply { Reply(status: status, type: "application/json", body: Data(text.utf8), delay: delay) }
        static func image(_ data: Data) -> Reply { Reply(status: 200, type: "image/png", body: data, delay: 0) }
    }
    struct Seen { let method: String, target: String, body: String }

    private static let lock = NSLock()
    private static var log: [Seen] = []
    static var respond: (URLRequest) -> Reply = { _ in .json(200, "{}") }
    static var seen: [Seen] { lock.lock(); defer { lock.unlock() }; return log }
    static func reset() { lock.lock(); log = []; respond = { _ in .json(200, "{}") }; lock.unlock() }

    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "memory-ui.test.invalid" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        var body = Data()
        if let stream = request.httpBodyStream {
            stream.open()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable { let count = stream.read(&buffer, maxLength: buffer.count); if count <= 0 { break }; body.append(buffer, count: count) }
            stream.close()
        }
        let url = request.url!
        // absoluteString keeps the percent-escapes the app sent.
        let target = String(url.absoluteString.dropFirst("https://memory-ui.test.invalid".count))
        Self.lock.lock()
        Self.log.append(Seen(method: request.httpMethod ?? "GET", target: target, body: String(decoding: body, as: UTF8.self)))
        Self.lock.unlock()
        let reply = Self.respond(request)
        let send = { [self] in
            let response = HTTPURLResponse(url: url, statusCode: reply.status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": reply.type])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: reply.body)
            client?.urlProtocolDidFinishLoading(self)
        }
        if reply.delay > 0 { DispatchQueue.global().asyncAfter(deadline: .now() + reply.delay, execute: send) } else { send() }
    }

    override func stopLoading() {}
}
