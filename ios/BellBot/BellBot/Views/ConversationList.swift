import SwiftUI
import UIKit

enum ConversationRow: Hashable {
    case message(String)
    case queue
}

/// 会話を開いた時の見せ方。比較のための切替で、決まったら片方だけ残す。
enum ConversationOpening: String, CaseIterable {
    case rise, fade
    static let storageKey = "conversationOpening"
}

/// 会話の行をOS標準の表に載せる。行の高さは表が実測し、制御は「末尾にいる間は追従する」と
/// 「過去を上へ足した分だけ位置をずらす」の2つだけに限る。
struct ConversationList<RowContent: View>: UIViewRepresentable {
    let messages: [TimelineMessage]
    let queue: [QueueItem]
    let hasMore: Bool
    let loading: Bool
    let loadingOlder: Bool
    let bottomInset: CGFloat
    let opening: ConversationOpening
    let scrollToBottomRevision: Int
    let onLoadOlder: () -> Void
    let onRefresh: () async -> Void
    let onAtBottomChange: (Bool) -> Void
    @ViewBuilder let content: (ConversationRow) -> RowContent

    private var rows: [ConversationRow] {
        messages.map { .message($0.id) } + (queue.isEmpty ? [] : [.queue])
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> ConversationTableView {
        let table = ConversationTableView(frame: .zero, style: .plain)
        table.register(ConversationCell.self, forCellReuseIdentifier: "row")
        table.allowsSelection = false
        table.separatorStyle = .none
        table.backgroundColor = .clear
        table.keyboardDismissMode = .interactive
        table.selfSizingInvalidation = .enabledIncludingConstraints
        table.estimatedRowHeight = 180
        table.contentInset.top = 20
        table.alwaysBounceVertical = true
        table.accessibilityIdentifier = "conversation-messages"
        // 最初の配置が終わるまで見せない。見せる時に選んだ開き方で必ず入る。
        table.alpha = 0
        UIView.setAnimationsEnabled(false)
        let refresh = UIRefreshControl()
        refresh.addTarget(context.coordinator, action: #selector(Coordinator.refresh(_:)), for: .valueChanged)
        table.refreshControl = refresh
        context.coordinator.attach(table)
        return table
    }

    func updateUIView(_ table: ConversationTableView, context: Context) {
        let coordinator = context.coordinator
        coordinator.content = content
        coordinator.onLoadOlder = onLoadOlder
        coordinator.onRefresh = onRefresh
        coordinator.onAtBottomChange = onAtBottomChange
        coordinator.opening = opening
        coordinator.hasMore = hasMore
        // 初回取得か読み足しが終わったら、表示域を埋める判定をやり直してよい。
        if (coordinator.loading && !loading) || (coordinator.loadingOlder && !loadingOlder) { coordinator.fillRequested = false }
        coordinator.loading = loading
        coordinator.loadingOlder = loadingOlder
        if table.contentInset.bottom != bottomInset { table.contentInset.bottom = bottomInset }
        coordinator.apply(rows: rows, messages: messages, queue: queue)
        coordinator.fillIfShort()
        if coordinator.scrollToBottomRevision != scrollToBottomRevision {
            coordinator.scrollToBottomRevision = scrollToBottomRevision
            coordinator.scrollToBottom(animated: true)
        }
    }

    final class Coordinator: NSObject, UITableViewDelegate {
        var content: ((ConversationRow) -> RowContent)?
        var onLoadOlder: (() -> Void)?
        var onRefresh: (() async -> Void)?
        var onAtBottomChange: ((Bool) -> Void)?
        var opening = ConversationOpening.rise
        var hasMore = false
        var loading = false
        var loadingOlder = false
        var fillRequested = false
        var scrollToBottomRevision = 0
        private weak var table: ConversationTableView?
        private var dataSource: UITableViewDiffableDataSource<Int, ConversationRow>?
        private var messagesByID: [String: TimelineMessage] = [:]
        private var queue: [QueueItem] = []
        private var heights: [String: CGFloat] = [:]
        private var lastOffset: CGFloat = 0
        private var armed = true
        private var atBottom = true
        private var shown: Set<ConversationRow> = []
        #if targetEnvironment(macCatalyst)
        private var wheel: WheelScrollSmoother?
        #endif

        func attach(_ table: ConversationTableView) {
            self.table = table
            table.delegate = self
            dataSource = UITableViewDiffableDataSource(tableView: table) { [weak self] table, indexPath, row in
                let cell = table.dequeueReusableCell(withIdentifier: "row", for: indexPath) as! ConversationCell
                cell.row = row
                self?.configure(cell, row: row, first: indexPath.row == 0)
                return cell
            }
            table.onLayout = { [weak self] in self?.fillIfShort() }
            table.onReveal = { [weak self] in self?.reveal() }
            #if targetEnvironment(macCatalyst)
            wheel = WheelScrollSmoother(scrollView: table, onStart: { [weak self] in self?.beginUserScroll() },
                                        onStop: { [weak self] in self?.settle() })
            #endif
        }

        private func configure(_ cell: ConversationCell, row: ConversationRow, first: Bool) {
            guard let content else { return }
            cell.contentConfiguration = UIHostingConfiguration { content(row).padding(.top, first ? 0 : 17) }
                .margins(.vertical, 0)
                .margins(.horizontal, 18)
                .background(.clear)
            cell.backgroundConfiguration = .clear()
        }

        func apply(rows: [ConversationRow], messages: [TimelineMessage], queue: [QueueItem]) {
            guard let table, let dataSource else { return }
            let previous = dataSource.snapshot().itemIdentifiers
            var snapshot = NSDiffableDataSourceSnapshot<Int, ConversationRow>()
            snapshot.appendSections([0])
            snapshot.appendItems(rows)
            let updated = Dictionary(messages.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
            var changed = Set(table.indexPathsForVisibleRows?.compactMap { dataSource.itemIdentifier(for: $0) } ?? [])
            for message in messages where messagesByID[message.id] != nil && messagesByID[message.id] != message {
                changed.insert(.message(message.id))
            }
            if self.queue != queue { changed.insert(.queue) }
            // 先頭が変わった時だけ行の順番が動く。その行は保持済みの設定をそのまま使えない。
            if let first = previous.first, let index = rows.firstIndex(of: first), index > 0 { changed.insert(first) }
            snapshot.reconfigureItems(Array(changed.intersection(rows)))
            messagesByID = updated
            self.queue = queue
            let prepended = previous.first.flatMap { rows.firstIndex(of: $0) }.map { $0 > 0 } ?? false
            if prepended && !table.followsBottom {
                let height = table.contentSize.height, y = table.contentOffset.y
                UIView.performWithoutAnimation {
                    dataSource.apply(snapshot, animatingDifferences: false)
                    table.layoutIfNeeded()
                }
                table.contentOffset.y = y + (table.contentSize.height - height)
            } else {
                UIView.performWithoutAnimation { dataSource.apply(snapshot, animatingDifferences: false) }
            }
            if prepended { armed = true }
            if previous.isEmpty && !rows.isEmpty {
                table.followsBottom = true
                table.layoutIfNeeded()
                table.pinToBottom()
            }
        }

        func scrollToBottom(animated: Bool) {
            guard let table else { return }
            table.followsBottom = true
            table.setContentOffset(CGPoint(x: 0, y: table.bottomOffset), animated: animated)
            if !animated { settle() }
        }

        /// 最初の配置の直後に、選んだ開き方で表を見せる。1回だけ。
        private func reveal() {
            guard let table else { return }
            UIView.setAnimationsEnabled(true)
            switch opening {
            case .fade:
                UIView.animate(withDuration: 0.25) { table.alpha = 1 }
            case .rise:
                let cells = (table.indexPathsForVisibleRows ?? []).sorted { $0.row > $1.row }.compactMap { table.cellForRow(at: $0) }
                for cell in cells {
                    cell.alpha = 0
                    cell.transform = CGAffineTransform(translationX: 0, y: 24)
                }
                table.alpha = 1
                for (order, cell) in cells.enumerated() {
                    UIView.animate(withDuration: 0.28, delay: 0.035 * Double(order), options: .curveEaseOut) {
                        cell.alpha = 1
                        cell.transform = .identity
                    }
                }
            }
            for cell in table.visibleCells.compactMap({ ($0 as? ConversationCell)?.row }) { shown.insert(cell) }
        }

        /// 後から画面に入る行（読み足した過去・新着）にも、開いた時と同じ動きを付ける。
        private func enter(_ cell: UITableViewCell) {
            switch opening {
            case .fade:
                cell.alpha = 0
                UIView.animate(withDuration: 0.22) { cell.alpha = 1 }
            case .rise:
                cell.alpha = 0
                cell.transform = CGAffineTransform(translationX: 0, y: 16)
                UIView.animate(withDuration: 0.22, delay: 0, options: .curveEaseOut) {
                    cell.alpha = 1
                    cell.transform = .identity
                }
            }
        }

        @objc func refresh(_ control: UIRefreshControl) {
            Task { @MainActor in
                await onRefresh?()
                control.endRefreshing()
            }
        }

        private func beginUserScroll() {
            table?.followsBottom = false
        }

        /// 利用者の操作が終わった位置で、末尾にいるかを決める。
        private func settle() {
            guard let table else { return }
            table.followsBottom = table.distanceFromBottom <= 48
            if table.followsBottom { table.pinToBottom() }
            report()
        }

        private func report() {
            guard let table else { return }
            let now = table.distanceFromBottom <= 48
            guard now != atBottom else { return }
            atBottom = now
            // 表の配置の途中で呼ばれるので、親の状態は次の周で変える。
            DispatchQueue.main.async { [onAtBottomChange] in onAtBottomChange?(now) }
        }

        func fillIfShort() {
            #if targetEnvironment(macCatalyst)
            // Macのホイールは動かせる長さが無いと位置が変わらないので、表示域が埋まるまで過去を足す。
            // 親が取得中の間は頼まず、取得が終わった後の判定で頼む。
            if let table, table.bounds.height > 0, table.contentSize.height <= table.bounds.height,
               hasMore, !loading, !loadingOlder, !fillRequested {
                fillRequested = true
                // 親の更新中の配置から呼ばれ得るので、親の状態は次の周で変える。
                DispatchQueue.main.async { [onLoadOlder] in onLoadOlder?() }
            }
            #endif
        }

        // MARK: UITableViewDelegate

        func tableView(_ tableView: UITableView, estimatedHeightForRowAt indexPath: IndexPath) -> CGFloat {
            if case .message(let id)? = dataSource?.itemIdentifier(for: indexPath), let height = heights[id] { return height }
            return tableView.estimatedRowHeight
        }

        func tableView(_ tableView: UITableView, willDisplay cell: UITableViewCell, forRowAt indexPath: IndexPath) {
            guard let table, table.revealed, let row = (cell as? ConversationCell)?.row, !shown.contains(row) else { return }
            shown.insert(row)
            enter(cell)
        }

        func tableView(_ tableView: UITableView, didEndDisplaying cell: UITableViewCell, forRowAt indexPath: IndexPath) {
            guard let cell = cell as? ConversationCell, case .message(let id)? = cell.row else { return }
            heights[id] = cell.bounds.height
            tableView.estimatedRowHeight = heights.values.reduce(0, +) / CGFloat(heights.count)
        }

        func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
            #if targetEnvironment(macCatalyst)
            wheel?.stop()
            #endif
            beginUserScroll()
        }

        func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
            if !decelerate { settle() }
        }

        func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) { settle() }

        func scrollViewDidEndScrollingAnimation(_ scrollView: UIScrollView) { settle() }

        func scrollViewDidScroll(_ scrollView: UIScrollView) {
            guard let table else { return }
            let delta = table.contentOffset.y - lastOffset
            lastOffset = table.contentOffset.y
            var userDriven = table.isDragging || table.isDecelerating
            #if targetEnvironment(macCatalyst)
            userDriven = userDriven || wheel?.isActive == true
            #endif
            if userDriven && table.followsBottom && table.distanceFromBottom > 48 { table.followsBottom = false }
            report()
            guard userDriven else { return }
            if delta > 0 { armed = true }
            if delta < 0, armed, hasMore, !loadingOlder,
               let first = table.indexPathsForVisibleRows?.first, first.row <= ConversationHistoryPage.lowStockRows {
                armed = false
                onLoadOlder?()
            }
        }
    }
}

final class ConversationCell: UITableViewCell {
    var row: ConversationRow?

    override func prepareForReuse() {
        super.prepareForReuse()
        layer.removeAllAnimations()
        alpha = 1
        transform = .identity
    }
}

/// 末尾追従と幅変更時の読書位置だけを持つ表。
final class ConversationTableView: UITableView {
    var followsBottom = true
    /// 最初の配置を終えて見せた後か。見せるまでは行の高さの確定も描かない。
    private(set) var revealed = false
    private var revealScheduled = false
    var onLayout: (() -> Void)?
    var onReveal: (() -> Void)?
    private var layoutWidth: CGFloat = 0

    deinit {
        // 見せる前に会話を閉じても、アプリ全体のアニメーションを止めたままにしない。
        if !revealed { UIView.setAnimationsEnabled(true) }
    }

    /// 大きさが付いて行が見えた最初の配置の直後に、1回だけ見せる。
    private func scheduleReveal() {
        guard !revealScheduled, bounds.height > 0, indexPathsForVisibleRows?.isEmpty == false else { return }
        revealScheduled = true
        DispatchQueue.main.async { [weak self] in
            guard let self, !revealed else { return }
            revealed = true
            onReveal?()
        }
    }

    var bottomOffset: CGFloat {
        max(-adjustedContentInset.top, contentSize.height + adjustedContentInset.bottom - bounds.height)
    }

    var distanceFromBottom: CGFloat { bottomOffset - contentOffset.y }

    func pinToBottom() {
        let y = bottomOffset
        if abs(contentOffset.y - y) > 0.5 { contentOffset = CGPoint(x: contentOffset.x, y: y) }
    }

    override var contentSize: CGSize {
        didSet { if followsBottom, contentSize != oldValue { pinToBottom() } }
    }

    override func adjustedContentInsetDidChange() {
        super.adjustedContentInsetDidChange()
        if followsBottom { pinToBottom() }
    }

    override func layoutSubviews() {
        // 幅が変わると行の高さが変わる。先頭に見えていた行の画面内の位置を保つ。
        var anchor: (IndexPath, CGFloat)?
        if bounds.width != layoutWidth {
            if layoutWidth > 0, !followsBottom, let first = indexPathsForVisibleRows?.first {
                anchor = (first, rectForRow(at: first).minY - contentOffset.y)
            }
            layoutWidth = bounds.width
        }
        if revealed {
            layoutFollowingBottom()
        } else {
            UIView.performWithoutAnimation { layoutFollowingBottom() }
            scheduleReveal()
        }
        if let (path, offset) = anchor, path.row < numberOfRows(inSection: 0) {
            contentOffset.y = rectForRow(at: path).minY - offset
        }
        onLayout?()
    }

    /// 末尾へ寄せると見える行が変わり、その行の実高で末尾がまた動く。同じフレームの中で落ち着くまで繰り返す。
    private func layoutFollowingBottom() {
        super.layoutSubviews()
        guard followsBottom else { return }
        for _ in 0..<3 {
            let before = contentOffset.y
            pinToBottom()
            if abs(contentOffset.y - before) <= 0.5 { return }
            super.layoutSubviews()
        }
    }
}

/// ホイールマウスの1ノッチごとの移動を、トラックパッドと同じ減速する動きへ変える。
/// トラックパッドとMagic Mouseは表の標準の処理へそのまま渡す。
final class WheelScrollSmoother: NSObject {
    private weak var scrollView: UIScrollView?
    private let onStart: () -> Void
    private let onStop: () -> Void
    private var velocity: CGFloat = 0
    private var link: CADisplayLink?
    private(set) var isActive = false
    // 1ノッチの移動量の3倍を、毎フレーム0.9倍に減速しながら進む（ブラウザの平滑スクロールと同じ程度）。
    static let decayPerFrame: CGFloat = 0.9
    static let travelPerNotch: CGFloat = 3

    init(scrollView: UIScrollView, onStart: @escaping () -> Void, onStop: @escaping () -> Void) {
        self.scrollView = scrollView
        self.onStart = onStart
        self.onStop = onStop
        super.init()
        scrollView.panGestureRecognizer.allowedScrollTypesMask = .continuous
        let pan = UIPanGestureRecognizer(target: self, action: #selector(wheel(_:)))
        pan.allowedScrollTypesMask = .discrete
        pan.allowedTouchTypes = []
        scrollView.addGestureRecognizer(pan)
    }

    /// ノッチの移動量から、停止までの残り距離を速度に換算して足す。
    static func velocity(adding delta: CGFloat, to velocity: CGFloat) -> CGFloat {
        let base = delta.sign == velocity.sign ? velocity : 0
        return base + delta * travelPerNotch * 60 * (1 - decayPerFrame)
    }

    @objc private func wheel(_ pan: UIPanGestureRecognizer) {
        guard pan.state == .changed, let scrollView else { return }
        let delta = -pan.translation(in: scrollView).y
        pan.setTranslation(.zero, in: scrollView)
        guard delta != 0 else { return }
        velocity = Self.velocity(adding: delta, to: velocity)
        if link == nil {
            isActive = true
            onStart()
            let link = CADisplayLink(target: self, selector: #selector(tick(_:)))
            link.add(to: .main, forMode: .common)
            self.link = link
        }
    }

    @objc private func tick(_ link: CADisplayLink) {
        guard let scrollView else { stop(); return }
        let dt = CGFloat(link.targetTimestamp - link.timestamp)
        let lower = -scrollView.adjustedContentInset.top
        let upper = max(lower, scrollView.contentSize.height + scrollView.adjustedContentInset.bottom - scrollView.bounds.height)
        let y = min(max(scrollView.contentOffset.y + velocity * dt, lower), upper)
        scrollView.contentOffset.y = y
        velocity *= pow(Self.decayPerFrame, dt * 60)
        if abs(velocity) < 20 || y == lower || y == upper { stop() }
    }

    func stop() {
        guard link != nil else { return }
        link?.invalidate()
        link = nil
        velocity = 0
        isActive = false
        onStop()
    }
}
