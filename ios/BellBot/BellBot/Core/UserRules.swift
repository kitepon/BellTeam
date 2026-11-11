import Foundation

/// The user rules text (`GET /api/user-rules`) read for display. The text itself stays the source of truth: this only splits the
/// RULES format (`SECTION <topic>`, `RULE <id>`, clause lines) so the settings page can show it as rules instead of one text block.
/// shortcut: several clauses on one line stay one clause (the format does not say how they are separated); upgrade when it does.
struct UserRulesDocument: Equatable {
    struct Clause: Equatable {
        /// The clause word as written, e.g. `DO`, `DEFAULT (codex)`.
        let keyword: String
        var text: String

        /// The plain Japanese label of the clause word.
        var label: String {
            let word = keyword.split(separator: " ").first.map(String.init) ?? keyword
            let base: String
            switch word {
            case "YOU": base = "あなたは"
            case "PURPOSE": base = "目的"
            case "FACT": base = "事実"
            case "WHEN": base = "いつ"
            case "DO": base = "すること"
            case "MAY": base = "してよいこと"
            case "NEVER": base = "してはいけないこと"
            case "WHY": base = "理由"
            case "DEFAULT": base = "既定"
            default: base = keyword
            }
            guard word == "DEFAULT", let open = keyword.firstIndex(of: "(") else { return base }
            return base + " " + keyword[open...]
        }
    }

    struct Rule: Equatable {
        let id: String
        var clauses: [Clause] = []
    }

    struct Section: Equatable {
        let topic: String
        var note: String?
        var rules: [Rule] = []
    }

    var sections: [Section] = []
    /// Lines outside the format, shown as written.
    var plainLines: [String] = []

    var ruleCount: Int { sections.reduce(0) { $0 + $1.rules.count } }
    var isEmpty: Bool { sections.isEmpty && plainLines.isEmpty }

    private static let clausePattern = try! NSRegularExpression(
        pattern: #"^(PURPOSE|FACT|WHEN|DO|MAY|NEVER|WHY|DEFAULT(?: \([^)]*\))?|YOU ARE):\s*(.*)$"#)

    static func parse(_ text: String) -> UserRulesDocument {
        var document = UserRulesDocument()
        var inRule = false
        var inContinuation = false
        // The format header's own `FORMAT` explanation (it quotes `SECTION <topic>`) runs until the first section or rule at column 0.
        var inFormat = false
        for raw in text.components(separatedBy: .newlines) {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.isEmpty { inContinuation = false; continue }
            if inFormat {
                if raw.hasPrefix("SECTION ") || raw.hasPrefix("RULE ") { inFormat = false } else { continue }
            } else if line == "FORMAT" && document.sections.isEmpty { inFormat = true; continue }
            if line.hasPrefix("SECTION ") {
                document.sections.append(Section(topic: String(line.dropFirst(8)).trimmingCharacters(in: .whitespaces)))
                inRule = false; inContinuation = false
                continue
            }
            if line.hasPrefix("RULE ") {
                let id = String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces)
                if document.sections.isEmpty { document.sections.append(Section(topic: id.split(separator: ".").first.map(String.init) ?? "")) }
                document.sections[document.sections.count - 1].rules.append(Rule(id: id))
                inRule = true; inContinuation = false
                continue
            }
            if inRule, let match = clausePattern.firstMatch(in: line, range: NSRange(line.startIndex..., in: line)),
               let keyword = Range(match.range(at: 1), in: line), let body = Range(match.range(at: 2), in: line) {
                let lastSection = document.sections.count - 1
                document.sections[lastSection].rules[document.sections[lastSection].rules.count - 1]
                    .clauses.append(Clause(keyword: String(line[keyword]), text: String(line[body])))
                inContinuation = true
                continue
            }
            // The format header line (`RULES … v1`) before the first section is not a rule.
            if document.sections.isEmpty && line.hasPrefix("RULES ") { continue }
            if line.hasPrefix("#") && inRule { continue }
            if line.hasPrefix("#") && !document.sections.isEmpty {
                let note = line.drop(while: { $0 == "#" || $0 == " " })
                let last = document.sections.count - 1
                document.sections[last].note = [document.sections[last].note, String(note)].compactMap { $0 }.joined(separator: " ")
                continue
            }
            if inRule && inContinuation && raw.first?.isWhitespace == true {
                let last = document.sections.count - 1
                let rule = document.sections[last].rules.count - 1
                let clause = document.sections[last].rules[rule].clauses.count - 1
                document.sections[last].rules[rule].clauses[clause].text += (document.sections[last].rules[rule].clauses[clause].text.isEmpty ? "" : " ") + line
                continue
            }
            document.plainLines.append(line)
            inContinuation = false
        }
        return document
    }
}

struct UserRulesResponse: Decodable { let text: String }
struct UserRulesRequest: Encodable { let text: String }
