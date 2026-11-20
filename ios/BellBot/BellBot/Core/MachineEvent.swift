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

    let seq: Int
    let view: String
    /// show | fold。表の値がfoldでなければshow（hideは無い）。サーバーの表示規則表が決める。
    let display: String
    let foldGroup: String
    /// 道具の連なり（fold_group tools）を数える。tool_useが1、他の仲間は0。無ければ1として数える（machine-stream.md「Tool calls fold」）。
    let foldCount: Int?
    let title: String?
    let text: String
    let truncated: Bool
    let tool: Tool?
    let request: MachineRequest?
    /// machine-stream.md「Turn answer bubble」。`words`でtrueなら、終わったターンの最後の言葉（吹き出しで出す）。アプリは「最後」を決めずこの値だけを読む。
    let bubble: Bool
    /// `machineFolded`が付ける。fold行の後ろに隣り合う同じfoldGroupの行。サーバーからは来ない。
    var attached: [TimelineMessage] = []

    private enum CodingKeys: String, CodingKey { case seq, view, display, foldGroup, foldCount, title, text, truncated, tool, request, bubble }

    init(from decoder: Decoder) {
        let c = try? decoder.container(keyedBy: CodingKeys.self)
        seq = (try? c?.decodeIfPresent(Int.self, forKey: .seq)) ?? 0
        view = (try? c?.decodeIfPresent(String.self, forKey: .view)) ?? "unknown"
        display = (try? c?.decodeIfPresent(String.self, forKey: .display)) == "fold" ? "fold" : "show"
        foldGroup = (try? c?.decodeIfPresent(String.self, forKey: .foldGroup)) ?? view
        foldCount = (try? c?.decodeIfPresent(Int.self, forKey: .foldCount)) ?? nil
        title = (try? c?.decodeIfPresent(String.self, forKey: .title)) ?? nil
        text = (try? c?.decodeIfPresent(String.self, forKey: .text)) ?? ""
        truncated = (try? c?.decodeIfPresent(Bool.self, forKey: .truncated)) ?? false
        tool = (try? c?.decodeIfPresent(Tool.self, forKey: .tool)) ?? nil
        request = (try? c?.decodeIfPresent(MachineRequest.self, forKey: .request)) ?? nil
        bubble = (try? c?.decodeIfPresent(Bool.self, forKey: .bubble)) ?? false
    }

    var isThinking: Bool { view == "words" && title == "thinking" }
    var isBubble: Bool { view == "words" && bubble }
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

/// `GET /api/bots/:id/machine-events/:seq`。保存済みの行をそのまま返す。
struct MachineRawLine: Decodable { let seq: Int; let line: String }

extension TimelineMessage {
    func replacingText(_ text: String) -> TimelineMessage { var copy = self; copy.message = text; return copy }
}

extension Array where Element == TimelineMessage {
    /// machine-stream.md「Fold view」「Tool calls fold and the order rule」。連続する`fold`行は`fold_group`が同じ間だけ先頭の行へ束ねる。
    /// 別のgroup・`show`の行・機械席以外の行が群を切る。行は時系列の位置から動かさず、消す行も無い。
    var machineFolded: [TimelineMessage] {
        guard contains(where: { $0.machineEvent != nil }) else { return self }
        var rows: [TimelineMessage] = []
        for message in self {
            if let event = message.machineEvent, event.display == "fold", let last = rows.last?.machineEvent, last.display == "fold", last.foldGroup == event.foldGroup {
                rows[rows.count - 1].machineEvent?.attached.append(message)
            } else {
                rows.append(message)
            }
        }
        return rows
    }
}
