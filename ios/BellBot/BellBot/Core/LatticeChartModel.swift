import SwiftUI

/// 工程表の一覧。開いている間、10秒ごとに読み直す（screen-spec.md「Data handling」4）。
@MainActor
final class LatticeChartsModel: ObservableObject {
    enum Status: Equatable { case loading, loaded, reconnecting, unsupported, failed(String) }

    @Published private(set) var charts: [LatticeChartSummary] = []
    @Published private(set) var status: Status = .loading

    static let path = "/api/lattice/charts"
    var interval: Duration = .seconds(10)

    /// 統括の工程表の作り手（統括のBot）。工程表のレーンの先頭に使う。
    var coordinatorBotId: String? { charts.first { $0.isCoordinator && $0.createdBy != nil }?.createdBy }

    func run(api: BellAPI) async {
        while !Task.isCancelled {
            await load(api: api)
            if case .failed = status { return }
            try? await Task.sleep(for: interval)
        }
    }

    func load(api: BellAPI) async {
        do {
            let list: LatticeChartsList = try await api.get(Self.path)
            withAnimation(.spring(response: 0.45, dampingFraction: 0.82)) {
                charts = list.charts
                status = .loaded
            }
        } catch is CancellationError {
        } catch BellAPIError.httpStatus(404, _, _) {
            // 工程表の部品が無い本体。部品が入ると次の読み直しで一覧に変わる。
            status = .unsupported
        } catch let error where BellAPIError.isAuthenticationError(error) {
            status = .failed(LatticeText.login)
        } catch {
            if (error as? URLError)?.code == .cancelled { return }
            // 503（部品の入れ替え中）・通信の切断。表示中の一覧は残し、次の読み直しで戻る。
            status = .reconnecting
        }
    }
}

/// 1枚の工程表。SSEのsnapshotで描画中の図を置き換え、差分を動きで見せる（screen-spec.md「Data handling」）。
@MainActor
final class LatticeChartModel: ObservableObject {
    enum Connection: Equatable { case connecting, live, reconnecting, notFound, unsupported, failed(String) }

    let projectId: String
    @Published private(set) var snapshot: LatticeChartSnapshot?
    @Published private(set) var layout: LatticeLayout?
    @Published private(set) var connection: Connection = .connecting
    /// 新しく完了になった札と、その時刻（seal の跳ねと花の開き）。
    @Published private(set) var completedAt: [String: Date] = [:]
    var coordinator: String?
    var reduceMotion = false
    private var lastByte = Date()

    init(projectId: String) { self.projectId = projectId }

    var path: String { "/api/lattice/charts/\(projectId)/events" }
    var stale: Bool { connection == .reconnecting && snapshot != nil }

    enum StreamError: Error { case silent }

    /// 開いている間は再接続を続ける（1, 2, 4 … 30秒）。見つからない・旧本体・認証の異常だけは止めて表示する。
    func run(api: BellAPI) async {
        var attempt = 0
        while !Task.isCancelled {
            do {
                lastByte = Date()
                try await withThrowingTaskGroup(of: Void.self) { group in
                    group.addTask { [weak self, path] in
                        try await api.eventStream(path: path, onActivity: { [weak self] in
                            Task { @MainActor in self?.lastByte = Date() }
                        }, onEvent: { [weak self] name, data in
                            guard name == "snapshot" else { return }
                            let snapshot = try JSONDecoder().decode(LatticeChartSnapshot.self, from: data)
                            await self?.apply(snapshot)
                        })
                    }
                    group.addTask { [weak self] in
                        while true {
                            try await Task.sleep(for: .seconds(5))
                            guard let self else { return }
                            if await Date().timeIntervalSince(self.lastByte) > 35 { throw StreamError.silent }
                        }
                    }
                    _ = try await group.next()
                    group.cancelAll()
                }
            } catch is CancellationError {
                return
            } catch BellAPIError.httpStatus(404, _, _) {
                // SSEの404は本文を読まないので、見つからない工程表か旧本体かを通常の読み取りで見分ける。
                if await chartMissing(api: api) { connection = .notFound; return }
                connection = .unsupported
                attempt = 0
                try? await Task.sleep(for: .seconds(60))
                continue
            } catch let error where BellAPIError.isAuthenticationError(error) {
                connection = .failed(LatticeText.login)
                return
            } catch {}
            if Task.isCancelled { return }
            if connection == .live { attempt = 0 }
            connection = .reconnecting
            let wait = min(30, pow(2, Double(attempt))) * Double.random(in: 0.8...1.2)
            attempt += 1
            try? await Task.sleep(for: .seconds(wait))
        }
    }

    private func chartMissing(api: BellAPI) async -> Bool {
        do {
            let _: LatticeChartSnapshot = try await api.get("/api/lattice/charts/\(projectId)")
            return false
        } catch BellAPIError.httpStatus(404, let code, _) {
            return code == "LATTICE_CHART_NOT_FOUND"
        } catch {
            return false
        }
    }

    /// 統括が分かった時（一覧の読み取りが後から届いた時）、統括のレーンを先頭へ並べ直す。
    func setCoordinator(_ id: String?) {
        guard id != coordinator else { return }
        coordinator = id
        if let snapshot { withAnimation(.spring(response: 0.45, dampingFraction: 0.82)) { layout = LatticeLayout(snapshot, coordinator: id) } }
    }

    func apply(_ next: LatticeChartSnapshot) {
        let completed = LatticeDiff.completed(from: snapshot, to: next)
        let animation: Animation = reduceMotion ? .easeInOut(duration: 0.2) : .spring(response: 0.45, dampingFraction: 0.82)
        withAnimation(snapshot == nil ? nil : animation) {
            snapshot = next
            layout = LatticeLayout(next, coordinator: coordinator)
            connection = .live
            let now = Date()
            for id in completed { completedAt[id] = now }
            completedAt = completedAt.filter { now.timeIntervalSince($0.value) < 2 }
        }
    }
}

/// 止め一覧（screen-spec.md「止め一覧」）。読むのは開いた時・読み直す・外すの答えの後・前面へ戻った時だけ（契約にstreamは無い）。
/// 読めない間だけ 1, 2, 4 … 30秒で読み直し続ける。
@MainActor
final class LatticeStopsModel: ObservableObject {
    enum Phase: Equatable { case loading, ready, retry, old, failed(String) }

    @Published private(set) var phase = Phase.loading
    @Published private(set) var blockers: [LatticeBlocker] = []
    @Published private(set) var unread = false
    @Published private(set) var removing: Set<String> = []
    @Published private(set) var notes: [String: String] = [:]
    /// The row asking 「この止めを外しますか？」.
    @Published var confirming: String?
    /// The view's read task is keyed on this: a re-read replaces the running loop (and its backoff wait), never runs beside it.
    @Published private(set) var readRequest = 0

    static let path = "/api/lattice/blockers"

    func reread() { readRequest &+= 1 }

    func run(api: BellAPI) async {
        var attempt = 0
        while !Task.isCancelled, !(await read(api: api)) {
            phase = .retry
            try? await Task.sleep(for: .seconds(min(30, pow(2, Double(attempt))) * Double.random(in: 0.8...1.2)))
            attempt += 1
        }
    }

    /// true when the answer settles the screen (rows, empty, older server, login); false to read again after a wait.
    private func read(api: BellAPI) async -> Bool {
        do {
            let list: LatticeBlockersList = try await api.get(Self.path)
            guard list.schema == LatticeBlockersList.schema else { return false }
            let ids = Set(list.blockers.map(\.stopId))
            blockers = list.blockers
            unread = !(list.unreadCharts ?? []).isEmpty
            if let confirming, !ids.contains(confirming) { self.confirming = nil }
            notes = notes.filter { ids.contains($0.key) }
            phase = .ready
            return true
        } catch is CancellationError {
            return true
        } catch BellAPIError.httpStatus(404, _, _) {
            phase = .old
            return true
        } catch let error where BellAPIError.isAuthenticationError(error) {
            phase = .failed(LatticeText.login)
            return true
        } catch {
            return (error as? URLError)?.code == .cancelled
        }
    }

    /// 外す（確認の後）。送信中は行を残し、答えが何でもすぐ読み直す。届いたか分からない時の送り直しは already-gone になるだけ。
    func remove(_ stop: LatticeBlocker, api: BellAPI, reduceMotion: Bool) async {
        confirming = nil
        notes[stop.stopId] = nil
        removing.insert(stop.stopId)
        let outcome: LatticeUnblockOutcome
        do {
            let result: LatticeUnblockResult = try await api.post("/api/lattice/charts/\(stop.projectId)/unblock", body: ["stopId": stop.stopId])
            outcome = .of(result)
        } catch {
            outcome = .of(error)
        }
        removing.remove(stop.stopId)
        if outcome == .drop {
            withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) { blockers.removeAll { $0.stopId == stop.stopId } }
        } else {
            notes[stop.stopId] = outcome.note
        }
        reread()
    }
}
