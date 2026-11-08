import ChatLayout
import SwiftUI
import UIKit

enum ConversationRow: Hashable {
    case message(String)
    case queue
}

/// 行の見た目に効く、本文以外の素材。これが変わった時だけ、本文の変わらない可視行も作り直す。
struct ConversationRowContext: Hashable {
    let id: String
    let name: String
    let color: String
    let avatar: String

    init(_ bot: Bot) {
        id = bot.id
        name = bot.displayName
        color = bot.color
        // 画像本体の比較は重いので版で比べる。版を持たない旧サーバーだけ本体で比べる。
        avatar = bot.avatarVersion ?? bot.avatar
    }
}

/// 会話を開いた時の見せ方。比較のための切替で、決まったら片方だけ残す。
enum ConversationOpening: String, CaseIterable {
    case rise, fade
    static let storageKey = "conversationOpening"
}

/// 会話の行をチャット用レイアウト（ChatLayout）に載せる。読んでいる位置を保つのはレイアウトの役目で、ここでは位置を計算しない。
/// - 過去を上へ足す・見えている行より上の行の高さが実測で変わる → レイアウトが表示中の行の画面上の位置を保つ。
/// - 新着を下へ足す → 末尾にいる時だけ追従し、上を読んでいる時は動かない（keepContentOffsetAtBottomOnBatchUpdates）。
struct ConversationList<RowContent: View>: UIViewRepresentable {
    let messages: [TimelineMessage]
    let queue: [QueueItem]
    let rowContext: [ConversationRowContext]
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

    func makeUIView(context: Context) -> ConversationCollectionView {
        let layout = CollectionViewChatLayout()
        layout.settings.interItemSpacing = 17
        layout.settings.additionalInsets = UIEdgeInsets(top: 20, left: 0, bottom: 0, right: 0)
        layout.settings.estimatedItemSize = CGSize(width: 320, height: 120)
        layout.keepContentOffsetAtBottomOnBatchUpdates = true
        layout.supportSelfSizingInvalidation = true
        let view = ConversationCollectionView(frame: .zero, collectionViewLayout: layout)
        view.register(ConversationCell.self, forCellWithReuseIdentifier: "row")
        view.backgroundColor = .clear
        view.keyboardDismissMode = .interactive
        view.selfSizingInvalidation = .enabled
        // 先読みのセルはレイアウトの実測と食い違う（ChatLayoutの推奨）。
        view.isPrefetchingEnabled = false
        view.alwaysBounceVertical = true
        view.accessibilityIdentifier = "conversation-messages"
        // 最初の配置が終わるまで見せない。見せる時に選んだ開き方で必ず入る。
        view.alpha = 0
        let refresh = UIRefreshControl()
        refresh.addTarget(context.coordinator, action: #selector(Coordinator.refresh(_:)), for: .valueChanged)
        view.refreshControl = refresh
        context.coordinator.attach(view, layout: layout)
        return view
    }

    func updateUIView(_ view: ConversationCollectionView, context: Context) {
        let coordinator = context.coordinator
        coordinator.content = content
        coordinator.onLoadOlder = onLoadOlder
        coordinator.onRefresh = onRefresh
        coordinator.onAtBottomChange = onAtBottomChange
        coordinator.opening = opening
        coordinator.hasMore = hasMore
        // 初回取得が終わったら、表示域を埋める判定をやり直してよい。読み足しは行が入った時にやり直す。失敗では繰り返さない。
        if coordinator.loading && !loading { coordinator.fillRequested = false }
        coordinator.loading = loading
        coordinator.loadingOlder = loadingOlder
        if view.contentInset.bottom != bottomInset { view.contentInset.bottom = bottomInset }
        coordinator.present(rows: rows, messages: messages, queue: queue, rowContext: rowContext,
                            environment: context.environment)
        coordinator.fillIfShort()
        if coordinator.scrollToBottomRevision != scrollToBottomRevision {
            coordinator.scrollToBottomRevision = scrollToBottomRevision
            coordinator.scrollToBottom(animated: true)
        }
    }

    final class Coordinator: NSObject, UICollectionViewDelegate, ChatLayoutDelegate {
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
        private weak var view: ConversationCollectionView?
        private weak var layout: CollectionViewChatLayout?
        private var dataSource: ChatLayoutDiffableDataSource<Int, ConversationRow>?
        private var messagesByID: [String: TimelineMessage] = [:]
        private var queue: [QueueItem] = []
        private var rowContext: [ConversationRowContext] = []
        private var lastOffset: CGFloat = 0
        private var armed = true
        private var atBottom = true
        private var shown: Set<ConversationRow> = []
        private var prepared: Set<String> = []
        private var preparing = false
        private var latest: (rows: [ConversationRow], messages: [TimelineMessage], queue: [QueueItem],
                             rowContext: [ConversationRowContext])?
        #if targetEnvironment(macCatalyst)
        private var wheel: WheelScrollSmoother?
        #endif

        func attach(_ view: ConversationCollectionView, layout: CollectionViewChatLayout) {
            self.view = view
            self.layout = layout
            view.delegate = self
            layout.delegate = self
            dataSource = ChatLayoutDiffableDataSource(collectionView: view) { [weak self] view, indexPath, row in
                let cell = view.dequeueReusableCell(withReuseIdentifier: "row", for: indexPath) as! ConversationCell
                cell.row = row
                self?.configure(cell, row: row)
                return cell
            }
            view.onLayout = { [weak self] in self?.fillIfShort() }
            view.onReveal = { [weak self] in self?.reveal() }
            // キーボードや入力欄で下の余白が変わる時、末尾にいたなら末尾に残す（レイアウトはこれを自動では補わない）。
            view.onInsetChange = { [weak self] in
                guard let self, atBottom else { return }
                self.view?.pinToBottom()
            }
            #if targetEnvironment(macCatalyst)
            wheel = WheelScrollSmoother(scrollView: view, onStart: {}, onStop: { [weak self] in self?.report() })
            #endif
        }

        private func configure(_ cell: ConversationCell, row: ConversationRow) {
            guard let content else { return }
            cell.contentConfiguration = UIHostingConfiguration { content(row) }
                .margins(.vertical, 0)
                .margins(.horizontal, 18)
                .background(.clear)
            cell.backgroundConfiguration = .clear()
        }

        /// 本文の素材が揃ってから行を入れる。組み立て中に届いた更新は、最新の状態だけを次に渡す。
        func present(rows: [ConversationRow], messages: [TimelineMessage], queue: [QueueItem],
                     rowContext: [ConversationRowContext], environment: EnvironmentValues) {
            latest = (rows, messages, queue, rowContext)
            guard !preparing else { return }
            let sources = Array(Set(messages.compactMap(\.message)).subtracting(prepared))
            if sources.isEmpty {
                apply(rows: rows, messages: messages, queue: queue, rowContext: rowContext)
                return
            }
            preparing = true
            Task { @MainActor [weak self] in
                await MessageText.prerender(sources, environment: environment)
                guard let self else { return }
                preparing = false
                prepared.formUnion(sources)
                if let latest {
                    present(rows: latest.rows, messages: latest.messages, queue: latest.queue,
                            rowContext: latest.rowContext, environment: environment)
                }
            }
        }

        /// 作り直すのは中身の変わった行だけ。行の追加・削除・高さの変化で読んでいる位置を保つのはレイアウトに任せる。
        private func apply(rows: [ConversationRow], messages: [TimelineMessage], queue: [QueueItem],
                           rowContext: [ConversationRowContext]) {
            guard let view, let dataSource else { return }
            let previous = dataSource.snapshot?.itemIdentifiers ?? []
            let updated = Dictionary(messages.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
            var changed = Set<ConversationRow>()
            if self.rowContext != rowContext {
                changed.formUnion(view.indexPathsForVisibleItems.compactMap { dataSource.snapshot?.itemIdentifiers[safe: $0.item] })
            }
            for message in messages where messagesByID[message.id] != nil && messagesByID[message.id] != message {
                changed.insert(.message(message.id))
            }
            if self.queue != queue { changed.insert(.queue) }
            changed.formIntersection(previous)
            changed.formIntersection(rows)
            // 行も中身も変わらない親の更新では触らない。
            if rows == previous && changed.isEmpty { return }
            var snapshot = NSDiffableDataSourceSnapshot<Int, ConversationRow>()
            snapshot.appendSections([0])
            snapshot.appendItems(rows)
            snapshot.reconfigureItems(Array(changed))
            let commit = { [self] in
                messagesByID = updated
                self.queue = queue
                self.rowContext = rowContext
            }
            let prepended = previous.first.flatMap { rows.firstIndex(of: $0) }.map { $0 > 0 } ?? false
            if previous.isEmpty {
                // 最初の行は末尾から見せる。
                UIView.performWithoutAnimation {
                    dataSource.applySnapshotUsingReloadData(snapshot, commitAlongsideUpdates: commit)
                    view.layoutIfNeeded()
                    if !rows.isEmpty {
                        layout?.restoreContentOffset(with: ChatLayoutPositionSnapshot(
                            indexPath: IndexPath(item: rows.count - 1, section: 0), edge: .bottom))
                    }
                }
                atBottom = true
            } else {
                UIView.performWithoutAnimation {
                    dataSource.apply(snapshot, animatingDifferences: false, commitAlongsideUpdates: commit)
                }
            }
            if prepended {
                armed = true
                fillRequested = false
            }
            report()
        }

        func scrollToBottom(animated: Bool) {
            guard let view else { return }
            atBottom = true
            view.setContentOffset(CGPoint(x: 0, y: view.bottomOffset), animated: animated)
            if !animated { report() }
        }

        /// 最初の配置の直後に、選んだ開き方で見せる。1回だけ。
        /// 位置と透明度はレイアウトがセルへ当て直すため、動きはセルの中身（contentView）に付ける。
        private func reveal() {
            guard let view else { return }
            switch opening {
            case .fade:
                UIView.animate(withDuration: 0.25) { view.alpha = 1 }
            case .rise:
                let cells = view.indexPathsForVisibleItems.sorted { $0.item > $1.item }.compactMap { view.cellForItem(at: $0) }
                for cell in cells {
                    cell.contentView.alpha = 0
                    cell.contentView.transform = CGAffineTransform(translationX: 0, y: 24)
                }
                view.alpha = 1
                for (order, cell) in cells.enumerated() {
                    UIView.animate(withDuration: 0.28, delay: 0.035 * Double(order), options: .curveEaseOut) {
                        cell.contentView.alpha = 1
                        cell.contentView.transform = .identity
                    }
                }
            }
            for cell in view.visibleCells.compactMap({ ($0 as? ConversationCell)?.row }) { shown.insert(cell) }
        }

        /// 後から画面に入る行（読み足した過去・新着）にも、開いた時と同じ動きを付ける。
        private func enter(_ cell: UICollectionViewCell) {
            switch opening {
            case .fade:
                cell.contentView.alpha = 0
                UIView.animate(withDuration: 0.22) { cell.contentView.alpha = 1 }
            case .rise:
                cell.contentView.alpha = 0
                cell.contentView.transform = CGAffineTransform(translationX: 0, y: 16)
                UIView.animate(withDuration: 0.22, delay: 0, options: .curveEaseOut) {
                    cell.contentView.alpha = 1
                    cell.contentView.transform = .identity
                }
            }
        }

        @objc func refresh(_ control: UIRefreshControl) {
            Task { @MainActor in
                await onRefresh?()
                control.endRefreshing()
            }
        }

        /// 末尾から48pt以内なら末尾にいるとみなす。親の新着ボタンと、余白変更時の末尾維持に使う。
        private func report() {
            guard let view else { return }
            let now = view.distanceFromBottom <= 48
            guard now != atBottom else { return }
            atBottom = now
            // 配置の途中で呼ばれるので、親の状態は次の周で変える。
            DispatchQueue.main.async { [onAtBottomChange] in onAtBottomChange?(now) }
        }

        func fillIfShort() {
            #if targetEnvironment(macCatalyst)
            // Macのホイールは動かせる長さが無いと位置が変わらないので、表示域が埋まるまで過去を足す。
            // 親が取得中の間と、届いた行を組み立てている間は頼まず、入った後の判定で頼む。
            if let view, let layout, view.bounds.height > 0, layout.collectionViewContentSize.height <= view.bounds.height,
               hasMore, !loading, !loadingOlder, !preparing, !fillRequested {
                fillRequested = true
                // 親の更新中の配置から呼ばれ得るので、親の状態は次の周で変える。
                DispatchQueue.main.async { [onLoadOlder] in onLoadOlder?() }
            }
            #endif
        }

        // MARK: UICollectionViewDelegate

        func collectionView(_ collectionView: UICollectionView, willDisplay cell: UICollectionViewCell, forItemAt indexPath: IndexPath) {
            guard let view, view.revealed, let row = (cell as? ConversationCell)?.row, !shown.contains(row) else { return }
            shown.insert(row)
            enter(cell)
        }

        func collectionView(_ collectionView: UICollectionView, shouldSelectItemAt indexPath: IndexPath) -> Bool { false }

        func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
            #if targetEnvironment(macCatalyst)
            wheel?.stop()
            #endif
        }

        func scrollViewDidScroll(_ scrollView: UIScrollView) {
            guard let view else { return }
            let delta = view.contentOffset.y - lastOffset
            lastOffset = view.contentOffset.y
            report()
            var userDriven = view.isDragging || view.isDecelerating
            #if targetEnvironment(macCatalyst)
            userDriven = userDriven || wheel?.isActive == true
            #endif
            guard userDriven else { return }
            if delta > 0 { armed = true }
            // 読込済みの残りが少なくなったら、上端に届く前に次の過去を頼む（同じ取得は重ねない）。
            if delta < 0, armed, hasMore, !loadingOlder,
               let first = view.indexPathsForVisibleItems.map(\.item).min(), first <= ConversationHistoryPage.lowStockRows {
                armed = false
                onLoadOlder?()
            }
        }
    }
}

private extension Array {
    subscript(safe index: Int) -> Element? { indices.contains(index) ? self[index] : nil }
}

final class ConversationCell: UICollectionViewCell {
    var row: ConversationRow?

    override func prepareForReuse() {
        super.prepareForReuse()
        contentView.layer.removeAllAnimations()
        contentView.alpha = 1
        contentView.transform = .identity
    }

    /// 幅はレイアウトが決め、高さだけを中身から測る。
    override func preferredLayoutAttributesFitting(_ layoutAttributes: UICollectionViewLayoutAttributes) -> UICollectionViewLayoutAttributes {
        let attributes = layoutAttributes.copy() as! UICollectionViewLayoutAttributes
        let size = contentView.systemLayoutSizeFitting(
            CGSize(width: layoutAttributes.size.width, height: UIView.layoutFittingCompressedSize.height),
            withHorizontalFittingPriority: .required, verticalFittingPriority: .fittingSizeLevel)
        attributes.size.height = ceil(size.height)
        return attributes
    }
}

/// 最初に見せる時機と、下の余白の変更を知らせるだけの一覧。位置の制御は持たない。
final class ConversationCollectionView: UICollectionView {
    /// 最初の配置を終えて見せた後か。
    private(set) var revealed = false
    private var revealScheduled = false
    var onLayout: (() -> Void)?
    var onReveal: (() -> Void)?
    var onInsetChange: (() -> Void)?

    var bottomOffset: CGFloat {
        max(-adjustedContentInset.top, collectionViewLayout.collectionViewContentSize.height + adjustedContentInset.bottom - bounds.height)
    }

    var distanceFromBottom: CGFloat { bottomOffset - contentOffset.y }

    func pinToBottom() {
        let y = bottomOffset
        if abs(contentOffset.y - y) > 0.5 { contentOffset = CGPoint(x: contentOffset.x, y: y) }
    }

    override func adjustedContentInsetDidChange() {
        super.adjustedContentInsetDidChange()
        onInsetChange?()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        if !revealed { scheduleReveal() }
        onLayout?()
    }

    /// 大きさが付いて行が見えた最初の配置の直後に、1回だけ見せる。
    private func scheduleReveal() {
        guard !revealScheduled, bounds.height > 0, !indexPathsForVisibleItems.isEmpty else { return }
        revealScheduled = true
        DispatchQueue.main.async { [weak self] in
            guard let self, !revealed else { return }
            revealed = true
            onReveal?()
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
