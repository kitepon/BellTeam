import SwiftUI
import UIKit

enum ConversationRow: Hashable {
    case message(String)
    case queue
}

/// 会話の行をOS標準の表に載せる。行の高さは表が実測し、制御は「末尾にいる間は追従する」と
/// 「過去を上へ足した分だけ位置をずらす」の2つだけに限る。
struct ConversationList<RowContent: View>: UIViewRepresentable {
    let messages: [TimelineMessage]
    let queue: [QueueItem]
    let hasMore: Bool
    let loadingOlder: Bool
    let bottomInset: CGFloat
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
        coordinator.hasMore = hasMore
        coordinator.loadingOlder = loadingOlder
        if table.contentInset.bottom != bottomInset { table.contentInset.bottom = bottomInset }
        coordinator.apply(rows: rows, messages: messages, queue: queue)
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
        var hasMore = false
        var loadingOlder = false
        var scrollToBottomRevision = 0
        private weak var table: ConversationTableView?
        private var dataSource: UITableViewDiffableDataSource<Int, ConversationRow>?
        private var messagesByID: [String: TimelineMessage] = [:]
        private var queue: [QueueItem] = []
        private var heights: [String: CGFloat] = [:]
        private var lastOffset: CGFloat = 0
        private var armed = true
        private var atBottom = true
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
            table.onLayout = { [weak self] in self?.layoutChanged() }
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

        private func layoutChanged() {
            #if targetEnvironment(macCatalyst)
            // Macのホイールは動かせる長さが無いと位置が変わらないので、表示域が埋まるまで過去を足す。
            if let table, table.contentSize.height <= table.bounds.height, hasMore, !loadingOlder, armed {
                armed = false
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
}

/// 末尾追従と幅変更時の読書位置だけを持つ表。
final class ConversationTableView: UITableView {
    var followsBottom = true
    var onLayout: (() -> Void)?
    private var layoutWidth: CGFloat = 0

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
        super.layoutSubviews()
        if let (path, offset) = anchor, path.row < numberOfRows(inSection: 0) {
            contentOffset.y = rectForRow(at: path).minY - offset
        }
        if followsBottom { pinToBottom() }
        onLayout?()
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
