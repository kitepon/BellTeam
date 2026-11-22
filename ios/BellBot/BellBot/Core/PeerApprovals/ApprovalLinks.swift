import Foundation

/// 工程表とのつながり（approval-box-extension/peer-channel-feed.md 5章）。決裁の中身は端末にあり、BellTeamのサーバーが持つのはIDと状態だけ:
/// `GET /api/approvals/by-decision?id=` が {project, plan, task, state, attached} か404を返す。工程の名前・前後は、アプリが読める工程表（`/api/lattice/charts/:project`）から描く。
struct ApprovalByDecision: Decodable, Equatable {
    let project: String
    let plan: String
    let task: String
    /// linked | answered | closed | diverged
    let state: String
}

@MainActor
final class ApprovalLinkResolver {
    enum Outcome: Equatable {
        case linked(ApprovalLink)
        /// 404: the engine holds no row for this decision (external, or not linked yet).
        case notLinked
        /// Any other failure: the screen keeps what it had and draws nothing new (contract: any failure → no badge).
        case unknown
    }

    private var charts: [String: (snapshot: LatticeChartSnapshot, at: Date)] = [:]
    private let chartTTL: TimeInterval = 20

    static func path(_ decisionId: String) -> String {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))
        return "/api/approvals/by-decision?id=\(decisionId.addingPercentEncoding(withAllowedCharacters: allowed) ?? decisionId)"
    }

    func lookup(_ decisionId: String, api: BellAPI) async -> Outcome {
        let found: ApprovalByDecision
        do { found = try await api.get(Self.path(decisionId)) }
        catch BellAPIError.httpStatus(404, _, _) { return .notLinked }
        catch { return .unknown }
        guard let snapshot = await chart(found.project, api: api), let link = Self.link(found, in: snapshot) else { return .unknown }
        return .linked(link)
    }

    private func chart(_ project: String, api: BellAPI) async -> LatticeChartSnapshot? {
        if let cached = charts[project], Date().timeIntervalSince(cached.at) < chartTTL { return cached.snapshot }
        let encoded = project.addingPercentEncoding(withAllowedCharacters: CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))) ?? project
        guard let snapshot: LatticeChartSnapshot = try? await api.get("/api/lattice/charts/\(encoded)") else { return nil }
        charts[project] = (snapshot, Date())
        return snapshot
    }

    /// The decision's task with the tasks before and after it (edges of the chart), by the card the ids name.
    static func link(_ found: ApprovalByDecision, in snapshot: LatticeChartSnapshot) -> ApprovalLink? {
        let cards = snapshot.cardList
        guard let card = cards.first(where: { $0.plan == found.plan && $0.taskId == found.task }) else { return nil }
        func task(_ c: LatticeCard) -> ApprovalLinkTask { ApprovalLinkTask(title: c.title, state: c.state, cardId: c.id) }
        let edges = snapshot.edges ?? []
        let previous = edges.filter { $0.to == card.id }.compactMap { e in cards.first { $0.id == e.from } }
        let next = edges.filter { $0.from == card.id }.compactMap { e in cards.first { $0.id == e.to } }
        return ApprovalLink(state: found.state, chart: .init(name: snapshot.name ?? snapshot.projectId, projectId: snapshot.projectId),
                            task: task(card), previous: previous.map(task), next: next.map(task))
    }
}
