import SwiftUI
import XCTest
@testable import BellBot

@MainActor
final class ScreenKeyBarTests: XCTestCase {
    func testKeyPostsClosedSetKeyAsJSON() async throws {
        let (model, session) = makeModel()
        defer { session.invalidateAndCancel() }
        ScreenInputProtocol.script["POST /api/bots/b1/screen/key"] = [(200, #"{"key":"Enter","outcome":"accepted"}"#)]
        await model.sendKey("Enter")
        XCTAssertEqual(model.sentKey, "Enter")
        XCTAssertNil(model.notice)
        let request = try XCTUnwrap(ScreenInputProtocol.requests.first)
        XCTAssertEqual(request.method, "POST")
        XCTAssertEqual(try JSONSerialization.jsonObject(with: request.body) as? [String: String], ["key": "Enter"])
    }

    func testKeyErrorsBecomeShortJapaneseLinesWithoutRetry() async throws {
        let (model, session) = makeModel()
        defer { session.invalidateAndCancel() }
        let cases: [(Int, String, String)] = [(409, "SCREEN_SEAT_ABSENT", "席が起動していません"),
                                              (403, "SCREEN_INPUT_OWNER_REQUIRED", "オーナーとしてログインしていません"),
                                              (502, "SCREEN_INPUT_FAILED", "送れませんでした")]
        for (status, code, text) in cases {
            ScreenInputProtocol.script["POST /api/bots/b1/screen/key"] = [(status, #"{"error":"\#(code)"}"#)]
            await model.sendKey("Tab")
            XCTAssertEqual(model.notice, text, code)
            XCTAssertTrue(model.available)
        }
        XCTAssertEqual(ScreenInputProtocol.requests.count, 3, "one request per tap, no retry")
    }

    func testApprovalGetDecodesAndPostCarriesPromptDigest() async throws {
        let (model, session) = makeModel()
        defer { session.invalidateAndCancel() }
        ScreenInputProtocol.script["GET /api/bots/b1/screen/approval"] = [(200, Self.required("sha256:aa"))]
        await model.refreshApproval()
        XCTAssertEqual(model.approval?.promptDigest, "sha256:aa")
        XCTAssertEqual(model.approval?.choices?.map(\.decision), ["approve_once", "deny"])
        XCTAssertEqual(model.approval?.choices?.first?.label, "今回だけ許可")

        ScreenInputProtocol.script["POST /api/bots/b1/screen/approval"] = [(200, #"{"status":"submitted","decision":"approve_once"}"#)]
        await model.respond("approve_once")
        XCTAssertNil(model.approval)
        let post = try XCTUnwrap(ScreenInputProtocol.requests.last)
        XCTAssertEqual(try JSONSerialization.jsonObject(with: post.body) as? [String: String],
                       ["decision": "approve_once", "promptDigest": "sha256:aa"])

        ScreenInputProtocol.script["GET /api/bots/b1/screen/approval"] = [(200, #"{"status":"none"}"#)]
        await model.refreshApproval()
        XCTAssertNil(model.approval)
    }

    func testChangedApprovalRefetchesInsteadOfRetrying() async throws {
        let (model, session) = makeModel()
        defer { session.invalidateAndCancel() }
        ScreenInputProtocol.script["GET /api/bots/b1/screen/approval"] = [(200, Self.required("sha256:old")), (200, Self.required("sha256:new"))]
        await model.refreshApproval()
        ScreenInputProtocol.script["POST /api/bots/b1/screen/approval"] = [(409, #"{"error":"SCREEN_APPROVAL_CHANGED"}"#)]
        await model.respond("deny")
        XCTAssertEqual(ScreenInputProtocol.requests.map { "\($0.method) \($0.path)" },
                       ["GET /api/bots/b1/screen/approval", "POST /api/bots/b1/screen/approval", "GET /api/bots/b1/screen/approval"])
        XCTAssertEqual(model.approval?.promptDigest, "sha256:new")
    }

    func testUnsupportedApprovalHidesButtonsAndLeavesKeys() async throws {
        let (model, session) = makeModel()
        defer { session.invalidateAndCancel() }
        ScreenInputProtocol.script["GET /api/bots/b1/screen/approval"] = [(422, #"{"error":"SCREEN_APPROVAL_UNSUPPORTED"}"#)]
        await model.refreshApproval()
        XCTAssertTrue(model.approvalUnsupported)
        XCTAssertNil(model.approval)
        XCTAssertTrue(model.available)
    }

    func test503HidesTheWholeBarSilently() async throws {
        let (model, session) = makeModel()
        defer { session.invalidateAndCancel() }
        ScreenInputProtocol.script["GET /api/bots/b1/screen/approval"] = [(503, #"{"error":"SCREEN_INPUT_UNAVAILABLE"}"#)]
        await model.refreshApproval()
        XCTAssertFalse(model.available)
        XCTAssertNil(model.notice)
        model.reset(botID: "b1")
        ScreenInputProtocol.script["POST /api/bots/b1/screen/key"] = [(503, #"{"error":"SCREEN_INPUT_UNAVAILABLE"}"#)]
        await model.sendKey("Enter")
        XCTAssertFalse(model.available)
        XCTAssertNil(model.notice)
    }

    func testBarComesBackWhenTheServerLaterAnswers200() async throws {
        let (model, session) = makeModel()
        defer { session.invalidateAndCancel() }
        ScreenInputProtocol.script["GET /api/bots/b1/screen/approval"] = [(503, #"{"error":"SCREEN_INPUT_UNAVAILABLE"}"#), (200, #"{"status":"none"}"#)]
        await model.refreshApproval()
        XCTAssertFalse(model.available)
        await model.refreshApproval()
        XCTAssertTrue(model.available, "the next 200 shows the bar again on the same open screen")
    }

    func testApprovalBannerAppearsAfterAFailedPoll() async throws {
        let (model, session) = makeModel()
        defer { session.invalidateAndCancel() }
        ScreenInputProtocol.script["GET /api/bots/b1/screen/approval"] = [(500, #"{"error":"INTERNAL"}"#), (500, #"{"error":"INTERNAL"}"#),
                                                                          (200, Self.required("sha256:later"))]
        await model.refreshApproval()
        await model.refreshApproval()
        XCTAssertNil(model.approval)
        await model.refreshApproval()
        XCTAssertEqual(model.approval?.promptDigest, "sha256:later", "a failed poll does not stop later polls")
        XCTAssertEqual(ScreenInputProtocol.requests.count, 3)
    }

    // MARK: rendering

    func testRenderKeyBarStates() throws {
        let folder = URL(fileURLWithPath: "/Users/kite/bellteam-screens", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let approval = try JSONDecoder().decode(ScreenApproval.self, from: Data(Self.required("sha256:aa").utf8))
        let states: [(String, ScreenApproval?, String?, Bool)] = [("keys", nil, nil, false),
                                                                  ("digits-error", nil, "席が起動していません", true),
                                                                  ("approval", approval, nil, false)]
        for (name, approvalState, notice, digits) in states {
            for width in [390.0, 820.0] {
                for scheme in [ColorScheme.light, .dark] {
                    let view = VStack(spacing: 0) {
                        Color.black.frame(height: 120).overlay(Text("Allow this command? 1. Yes  2. No").font(.caption.monospaced()).foregroundStyle(.white))
                        ScreenKeyBar(sendingKey: nil, sentKey: name == "keys" ? "Enter" : nil, notice: notice, approval: approvalState,
                                     digitsOpen: digits, onKey: { _ in }, onDecision: { _ in })
                    }
                    .frame(width: width)
                    .background(Color.black)
                    .environment(\.colorScheme, scheme)
                    let renderer = ImageRenderer(content: view)
                    renderer.scale = 2
                    let image = try XCTUnwrap(renderer.uiImage)
                    let png = try XCTUnwrap(image.pngData())
                    let label = scheme == .dark ? "dark" : "light"
                    try png.write(to: folder.appendingPathComponent("screenkeys-\(name)-\(Int(width))-\(label).png"))
                    let attachment = XCTAttachment(image: image)
                    attachment.name = "screenkeys-\(name)-\(Int(width))-\(label)"
                    attachment.lifetime = .keepAlways
                    add(attachment)
                }
            }
        }
    }

    // MARK: helpers

    private static func required(_ digest: String) -> String {
        #"{"status":"approval_required","promptDigest":"\#(digest)","choices":[{"decision":"approve_once","label":"今回だけ許可"},{"decision":"deny","label":"拒否"}]}"#
    }

    private func makeModel() -> (ScreenInputModel, URLSession) {
        ScreenInputProtocol.reset()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ScreenInputProtocol.self]
        let session = URLSession(configuration: configuration)
        let api = BellAPI(baseURL: URL(string: "https://screen-input.test.invalid")!, session: session,
                          diagnostics: BellDiagnostics(onReport: { _, _, _, _ in }),
                          cookieStorage: configuration.httpCookieStorage!)
        return (ScreenInputModel(api: api, botID: "b1"), session)
    }
}

private final class ScreenInputProtocol: URLProtocol {
    struct Recorded { let method: String; let path: String; let body: Data }
    private static let lock = NSLock()
    private static var _requests: [Recorded] = []
    private static var _script: [String: [(Int, String)]] = [:]

    static var script: [String: [(Int, String)]] {
        get { lock.lock(); defer { lock.unlock() }; return _script }
        set { lock.lock(); _script = newValue; lock.unlock() }
    }
    static var requests: [Recorded] { lock.lock(); defer { lock.unlock() }; return _requests }
    static func reset() { lock.lock(); _requests = []; _script = [:]; lock.unlock() }

    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "screen-input.test.invalid" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let method = request.httpMethod ?? "GET"
        let path = request.url!.path
        var body = request.httpBody ?? Data()
        if let stream = request.httpBodyStream {
            stream.open()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                body.append(buffer, count: count)
            }
            stream.close()
        }
        Self.lock.lock()
        Self._requests.append(Recorded(method: method, path: path, body: body))
        let key = "\(method) \(path)"
        var queue = Self._script[key] ?? [(404, #"{"error":"UNSCRIPTED"}"#)]
        let (status, text) = queue.count > 1 ? queue.removeFirst() : queue[0]
        Self._script[key] = queue
        Self.lock.unlock()
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil,
                                       headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(text.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
