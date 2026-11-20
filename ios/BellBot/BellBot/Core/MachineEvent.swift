import Foundation

/// 機械席（machine seat）のstream-jsonをconversationが解釈した行（`kind: "machine_event"`）。
/// 契約: docs/architecture/modules/conversation/machine-stream.md。アプリは`view`だけで描き、生の行は読まない。
/// 形が崩れていても履歴全体のdecodeを壊さず、`unknown`として出す。
struct MachineEvent: Decodable, Equatable {
    struct Tool: Decodable, Equatable {
        let id: String?
        let name: String?
        let summary: String?

        private enum CodingKeys: String, CodingKey { case id, name, summary }
        init(from decoder: Decoder) {
            let c = try? decoder.container(keyedBy: CodingKeys.self)
            id = (try? c?.decodeIfPresent(String.self, forKey: .id)) ?? nil
            name = (try? c?.decodeIfPresent(String.self, forKey: .name)) ?? nil
            summary = (try? c?.decodeIfPresent(String.self, forKey: .summary)) ?? nil
        }
    }

    let view: String
    /// show | fold | hide。サーバーの表示規則表が決める。
    let display: String
    let title: String?
    let text: String
    let tool: Tool?
    let request: MachineRequest?

    private enum CodingKeys: String, CodingKey { case view, display, title, text, tool, request }

    init(from decoder: Decoder) {
        let c = try? decoder.container(keyedBy: CodingKeys.self)
        view = (try? c?.decodeIfPresent(String.self, forKey: .view)) ?? "unknown"
        display = (try? c?.decodeIfPresent(String.self, forKey: .display)) ?? "show"
        title = (try? c?.decodeIfPresent(String.self, forKey: .title)) ?? nil
        text = (try? c?.decodeIfPresent(String.self, forKey: .text)) ?? ""
        tool = (try? c?.decodeIfPresent(Tool.self, forKey: .tool)) ?? nil
        request = (try? c?.decodeIfPresent(MachineRequest.self, forKey: .request)) ?? nil
    }

    var isThinking: Bool { view == "words" && title == "thinking" }
}

/// 席が答えを待つ要求。`questions`があれば質問カード、無ければ許可カード。
struct MachineRequest: Decodable, Equatable {
    let requestId: String
    let status: String
    let questions: [MachineQuestion]
    let answers: [MachineAnswer]
    let decision: String?

    var isPending: Bool { status == "pending" }

    private enum CodingKeys: String, CodingKey { case requestId, status, questions, answers, decision }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        requestId = try c.decode(String.self, forKey: .requestId)
        status = try c.decode(String.self, forKey: .status)
        questions = try c.decodeIfPresent([MachineQuestion].self, forKey: .questions) ?? []
        answers = try c.decodeIfPresent([MachineAnswer].self, forKey: .answers) ?? []
        decision = try c.decodeIfPresent(String.self, forKey: .decision)
    }
}

struct MachineQuestion: Decodable, Equatable {
    let header: String?
    let question: String
    let multiSelect: Bool
    let options: [MachineOption]

    private enum CodingKeys: String, CodingKey { case header, question, multiSelect, options }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        header = try c.decodeIfPresent(String.self, forKey: .header)
        question = try c.decode(String.self, forKey: .question)
        multiSelect = try c.decodeIfPresent(Bool.self, forKey: .multiSelect) ?? false
        options = try c.decode([MachineOption].self, forKey: .options)
    }
}

struct MachineOption: Decodable, Equatable {
    let index: Int
    let label: String
    let description: String?
}

struct MachineAnswer: Codable, Equatable {
    let indexes: [Int]
    let other: String?
}

/// `answers`は質問と同じ順。許可カードは`decision`（allow / deny）だけ。
struct MachineAnswerBody: Encodable, Equatable {
    var answers: [MachineAnswer]? = nil
    var decision: String? = nil
}

/// `POST /api/seat-requests/:request_id/answer`の200。409 REQUEST_NOT_PENDINGも同じ形の`request`を返す。
struct MachineAnswerResult: Decodable, Equatable {
    struct Request: Decodable, Equatable {
        let status: String
        let answers: [MachineAnswer]?
        let decision: String?
    }
    let request: Request
}

extension Array where Element == TimelineMessage {
    /// machine-stream.md: `hide`の行は描かない。foldした`tool_result`は同じ`tool.id`の`tool_use`の行へ畳み、別行にしない。
    var machineDisplayed: [TimelineMessage] {
        guard contains(where: { $0.machineEvent != nil }) else { return self }
        let called = Set(compactMap { $0.machineEvent?.view == "tool_use" ? $0.machineEvent?.tool?.id : nil })
        return filter { message in
            guard let event = message.machineEvent else { return true }
            if event.display == "hide" { return false }
            if event.view == "tool_result", event.display == "fold", let id = event.tool?.id, called.contains(id) { return false }
            return true
        }
    }
}
