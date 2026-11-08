import SwiftUI

// Screen input contract: docs/architecture/modules/execution/screen-input.md

struct ScreenApprovalChoice: Decodable, Equatable {
    let decision: String
    let label: String
}

struct ScreenApproval: Decodable, Equatable {
    let status: String
    let promptDigest: String?
    let choices: [ScreenApprovalChoice]?

    var isRequired: Bool { status == "approval_required" && promptDigest != nil && !(choices ?? []).isEmpty }
}

private struct ScreenKeyBody: Encodable { let key: String }
private struct ScreenKeyAck: Decodable { let key: String }
private struct ScreenApprovalBody: Encodable { let decision: String; let promptDigest: String }
private struct ScreenApprovalAck: Decodable { let status: String }

/// State of the key bar and approval banner for one Bot's screen view. No automatic retry: every send is one Owner tap.
@MainActor
final class ScreenInputModel: ObservableObject {
    @Published private(set) var available = true
    @Published private(set) var sendingKey: String?
    @Published private(set) var sentKey: String?
    @Published private(set) var notice: String?
    @Published private(set) var approval: ScreenApproval?
    @Published private(set) var approvalUnsupported = false

    private let api: BellAPI
    private var botID: String
    private var approvalPollFailed = false
    private var feedbackTask: Task<Void, Never>?

    init(api: BellAPI, botID: String) {
        self.api = api
        self.botID = botID
    }

    func reset(botID: String) {
        feedbackTask?.cancel()
        self.botID = botID
        available = true
        sendingKey = nil
        sentKey = nil
        notice = nil
        approval = nil
        approvalUnsupported = false
        approvalPollFailed = false
    }

    func sendKey(_ key: String) async {
        guard available, sendingKey == nil else { return }
        let id = botID
        sendingKey = key
        sentKey = nil
        notice = nil
        defer { sendingKey = nil }
        do {
            let _: ScreenKeyAck = try await api.post("/api/bots/\(id)/screen/key", body: ScreenKeyBody(key: key))
            guard id == botID else { return }
            sentKey = key
            feedbackTask?.cancel()
            feedbackTask = Task { [weak self] in
                try? await Task.sleep(for: .seconds(1.2))
                if !Task.isCancelled { self?.sentKey = nil }
            }
        } catch {
            await handle(error, path: "/api/bots/\(id)/screen/key", method: "POST", botID: id)
        }
    }

    /// Called once per screen refresh. Failures here stay quiet (the key bar still works) except an unexpected one, reported once.
    func refreshApproval() async {
        guard available, !approvalPollFailed, !approvalUnsupported else { return }
        let id = botID
        let path = "/api/bots/\(id)/screen/approval"
        do {
            let result: ScreenApproval = try await api.get(path)
            guard id == botID else { return }
            let next = result.isRequired ? result : nil
            if approval != next { approval = next }
        } catch is CancellationError {
        } catch let error as URLError where error.code == .cancelled {
        } catch BellAPIError.httpStatus(503, "SCREEN_INPUT_UNAVAILABLE", _) {
            available = false
        } catch BellAPIError.httpStatus(409, "SCREEN_SEAT_ABSENT", _) {
            approval = nil
        } catch BellAPIError.httpStatus(422, "SCREEN_APPROVAL_UNSUPPORTED", _) {
            approval = nil
            approvalUnsupported = true
        } catch where BellAPIError.isAuthenticationError(error) {
        } catch {
            approvalPollFailed = true
            api.diagnostics.report(error, path: path, method: "GET", observation: .read(error, retainedData: false))
        }
    }

    func respond(_ decision: String) async {
        guard available, sendingKey == nil, let current = approval, let digest = current.promptDigest else { return }
        let id = botID
        sendingKey = "approval:\(decision)"
        notice = nil
        defer { sendingKey = nil }
        do {
            let _: ScreenApprovalAck = try await api.post("/api/bots/\(id)/screen/approval",
                                                           body: ScreenApprovalBody(decision: decision, promptDigest: digest))
            guard id == botID else { return }
            approval = nil
            sentKey = "approval:\(decision)"
            feedbackTask?.cancel()
            feedbackTask = Task { [weak self] in
                try? await Task.sleep(for: .seconds(1.2))
                if !Task.isCancelled { self?.sentKey = nil }
            }
        } catch {
            await handle(error, path: "/api/bots/\(id)/screen/approval", method: "POST", botID: id)
        }
    }

    private func handle(_ error: Error, path: String, method: String, botID id: String) async {
        if error is CancellationError { return }
        switch error {
        case BellAPIError.httpStatus(503, "SCREEN_INPUT_UNAVAILABLE", _):
            available = false
        case BellAPIError.httpStatus(409, "SCREEN_APPROVAL_CHANGED", _):
            notice = "画面が変わりました。もう一度確認してください"
            await refreshApproval()
        case BellAPIError.httpStatus(422, "SCREEN_APPROVAL_UNSUPPORTED", _):
            approval = nil
            approvalUnsupported = true
            notice = "キーで答えてください"
        case BellAPIError.httpStatus(409, "SCREEN_SEAT_ABSENT", _):
            notice = "席が起動していません"
        case BellAPIError.unauthorized, BellAPIError.accessLoginRequired: // BellAPI maps 401/403 to .unauthorized
            notice = "オーナーとしてログインしていません"
        case BellAPIError.httpStatus(502, "SCREEN_INPUT_FAILED", _):
            notice = "送れませんでした"
        default:
            notice = "送れませんでした"
            api.diagnostics.report(error, path: path, method: method, observation: .write)
        }
    }
}

struct ScreenKeyBar: View {
    let sendingKey: String?
    let sentKey: String?
    let notice: String?
    let approval: ScreenApproval?
    var digitsOpen = false
    let onKey: (String) -> Void
    let onDecision: (String) -> Void

    @State private var showDigits: Bool

    init(sendingKey: String?, sentKey: String?, notice: String?, approval: ScreenApproval?, digitsOpen: Bool = false,
         onKey: @escaping (String) -> Void, onDecision: @escaping (String) -> Void) {
        self.sendingKey = sendingKey
        self.sentKey = sentKey
        self.notice = notice
        self.approval = approval
        self.digitsOpen = digitsOpen
        self.onKey = onKey
        self.onDecision = onDecision
        _showDigits = State(initialValue: digitsOpen)
    }

    var body: some View {
        VStack(spacing: 10) {
            if let approval, approval.isRequired { banner(approval) }
            if let notice {
                Label(notice, systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier("screen-key-notice")
            }
            HStack(spacing: 8) {
                key("Escape", "取消", "escape")
                key("Tab", "Tab", "arrow.right.to.line")
                key("Enter", "決定", "return", prominent: true)
                key("C-c", "中断", "stop.fill", destructive: true)
            }
            HStack(spacing: 8) {
                key("Left", "左", "arrow.left", compact: true)
                key("Down", "下", "arrow.down", compact: true)
                key("Up", "上", "arrow.up", compact: true)
                key("Right", "右", "arrow.right", compact: true)
                Button { withAnimation(.snappy) { showDigits.toggle() } } label: {
                    Label("数字", systemImage: showDigits ? "chevron.down" : "number")
                        .labelStyle(.keyCap)
                        .modifier(KeyCapStyle(compact: true, tint: .white.opacity(0.14), foreground: .white))
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("screen-key-digits")
            }
            if showDigits {
                HStack(spacing: 5) {
                    ForEach(0..<10, id: \.self) { digit in
                        let id = String(digit)
                        Button { onKey(id) } label: {
                            ZStack {
                                Text(id).font(.body.monospacedDigit().weight(.semibold))
                                    .opacity(sendingKey == id ? 0 : 1)
                                if sendingKey == id { ProgressView().controlSize(.small).tint(.white) }
                            }
                            .modifier(KeyCapStyle(compact: true, tint: .white.opacity(0.14), foreground: .white))
                        }
                        .buttonStyle(.plain)
                        .disabled(sendingKey != nil)
                        .accessibilityLabel("数字\(id)")
                        .accessibilityIdentifier("screen-key-\(id)")
                    }
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity)
        .background(Color(white: 0.09))
        .overlay(alignment: .top) { Rectangle().fill(.white.opacity(0.12)).frame(height: 0.5) }
        .environment(\.colorScheme, .dark)
        .sensoryFeedback(.success, trigger: sentKey) { _, new in new != nil }
    }

    private func banner(_ approval: ScreenApproval) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("許可を求められています", systemImage: "hand.raised.fill")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(BellTheme.accent("amber"))
            HStack(spacing: 8) {
                ForEach(approval.choices ?? [], id: \.decision) { choice in
                    let approve = choice.decision == "approve_once"
                    let id = "approval:\(choice.decision)"
                    Button { onDecision(choice.decision) } label: {
                        HStack(spacing: 6) {
                            if sendingKey == id { ProgressView().controlSize(.small).tint(.white) }
                            else { Image(systemName: sentKey == id ? "checkmark" : (approve ? "checkmark.circle.fill" : "xmark.circle.fill")) }
                            Text(choice.label).lineLimit(2).multilineTextAlignment(.center)
                        }
                        .font(.body.weight(.semibold))
                        .foregroundStyle(.white)
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .padding(.horizontal, 8)
                        .background(approve ? BellTheme.mint : Color.white.opacity(0.16), in: RoundedRectangle(cornerRadius: 12))
                    }
                    .buttonStyle(.plain)
                    .disabled(sendingKey != nil)
                    .accessibilityIdentifier("screen-approval-\(choice.decision)")
                }
            }
        }
        .padding(12)
        .background(BellTheme.accent("amber").opacity(0.18), in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(BellTheme.accent("amber").opacity(0.7), lineWidth: 1))
        .accessibilityIdentifier("screen-approval-banner")
    }

    private func key(_ id: String, _ label: String, _ symbol: String,
                     prominent: Bool = false, destructive: Bool = false, compact: Bool = false) -> some View {
        let tint: Color = destructive ? Color.red.opacity(0.85) : (prominent ? BellTheme.violet : .white.opacity(0.14))
        return Button { onKey(id) } label: {
            ZStack {
                Label(label, systemImage: sentKey == id ? "checkmark" : symbol)
                    .labelStyle(.keyCap)
                    .opacity(sendingKey == id ? 0 : 1)
                if sendingKey == id { ProgressView().controlSize(.small).tint(.white) }
            }
            .modifier(KeyCapStyle(compact: compact, tint: tint, foreground: .white))
        }
        .buttonStyle(.plain)
        .disabled(sendingKey != nil)
        .accessibilityLabel(label)
        .accessibilityIdentifier("screen-key-\(id)")
    }
}

private struct KeyCapLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        VStack(spacing: 3) {
            configuration.icon.font(.body.weight(.semibold))
            configuration.title.font(.caption2.weight(.medium)).lineLimit(1).minimumScaleFactor(0.7)
        }
    }
}

private extension LabelStyle where Self == KeyCapLabelStyle {
    static var keyCap: KeyCapLabelStyle { KeyCapLabelStyle() }
}

private struct KeyCapStyle: ViewModifier {
    let compact: Bool
    let tint: Color
    let foreground: Color

    func body(content: Content) -> some View {
        content
            .foregroundStyle(foreground)
            .frame(maxWidth: .infinity, minHeight: compact ? 44 : 52)
            .background(tint, in: RoundedRectangle(cornerRadius: 10))
            .contentShape(RoundedRectangle(cornerRadius: 10))
    }
}
