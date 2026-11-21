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

/// 引用の元へ移る依頼。revisionが変わった時だけ動き、行がまだ入っていなければ入った後に動く。
struct ConversationJump: Equatable {
    let id: String?
    let revision: Int
    /// 部分を引用した返信は本文の該当部分を光らせるので、吹き出し全体は光らせない。
    var flashesBubble = true
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
    let olderPagesRead: Int
    let bottomInset: CGFloat
    let opening: ConversationOpening
    let scrollToBottomRevision: Int
    let jump: ConversationJump
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
        // 初回取得が終わったら、先読みの判定をやり直してよい。読み足しは行が入った時とスクロールの動きでやり直す。失敗では繰り返さない。
        if coordinator.loading && !loading { coordinator.prefetchRequested = false }
        coordinator.loading = loading
        coordinator.loadingOlder = loadingOlder
        // 頁が読めたら、描かれた量が足りるか判定をやり直す。畳まれた行ばかりの頁は並びを変えずに先頭の畳んだ行へ束ねられ、行が増えない。
        if coordinator.olderPagesRead != olderPagesRead {
            coordinator.olderPagesRead = olderPagesRead
            coordinator.prefetchRequested = false
        }
        if view.contentInset.bottom != bottomInset { view.contentInset.bottom = bottomInset }
        coordinator.present(rows: rows, messages: messages, queue: queue, rowContext: rowContext,
                            environment: context.environment)
        coordinator.prefetchIfLow()
        if coordinator.scrollToBottomRevision != scrollToBottomRevision {
            coordinator.scrollToBottomRevision = scrollToBottomRevision
            coordinator.scrollToBottom(animated: true)
        }
        coordinator.requestJump(jump)
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
        var scrollToBottomRevision = 0
        private var jumpRevision = 0
        private var pendingJump: String?
        private var pendingFlash = true
        private weak var view: ConversationCollectionView?
        private weak var layout: CollectionViewChatLayout?
        private var dataSource: ChatLayoutDiffableDataSource<Int, ConversationRow>?
        private var messagesByID: [String: TimelineMessage] = [:]
        private var queue: [QueueItem] = []
        private var rowContext: [ConversationRowContext] = []
        private var lastOffset: CGFloat = 0
        var prefetchRequested = false
        var olderPagesRead = 0
        /// 末尾へなめらかに送っている間。新着が続いても末尾にいるものとして追う。指・ホイールが触れたら外す。
        private var following = false
        /// 自分で始めたアニメーション付きのスクロール（末尾を追う・最新へ・引用元へ）が動いている間。
        /// その行き先は始めた時の座標なので、この間に過去の行を足すと行き先が過去の位置になり、画面が過去へ飛ぶ（a471-refresh-jump、build 176 で実測 21,920pt）。
        private var animatingScroll = false
        private var scrollSpeed: CGFloat = 0
        private var lastScrollTime: CFTimeInterval = 0
        private var atBottom = true
        private var shown: Set<ConversationRow> = []
        private var prepared: Set<String> = []
        private var preparing = false
        private var applyAfterDrag = false
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
            view.onLayout = { [weak self] in self?.prefetchIfLow() }
            view.onReveal = { [weak self] in self?.reveal() }
            // キーボードや入力欄で下の余白が変わる時、末尾にいたなら末尾に残す（レイアウトはこれを自動では補わない）。
            view.onInsetChange = { [weak self] in
                guard let self, atBottom else { return }
                self.view?.pinToBottom()
            }
            #if targetEnvironment(macCatalyst)
            wheel = WheelScrollSmoother(scrollView: view, onStart: { [weak self] in self?.following = false }, onStop: { [weak self] in self?.report(); self?.flushDeferred() })
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
            // 行が変わらない・束ねられるだけの更新でも、描かれた量を見て先読みを続けるかを必ず判定する。
            defer { DispatchQueue.main.async { [weak self] in self?.prefetchIfLow() } }
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
            // 指を載せたままのスクロールは、毎フレーム指の位置から位置を決め直す。過去を足してレイアウトが位置を補っても直後に打ち消されて飛ぶので、指を離すまで待つ（a426）。
            // 指を離した後の減速中とMacのホイールの平滑スクロールも、動きが自分で位置を進めるので、止まるまで待つ（a471-scroll-jump）。
            if prepended, isScrolling(view) {
                applyAfterDrag = true
                return
            }
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
                // 末尾にいる時の新着・行の伸びは瞬時に動かさず、なめらかに末尾へ送る（動いた向きが分かるように）。上を読んでいる時は動かさない。
                // 過去の行と新着が同じ更新に入った時も、末尾にいたなら追う（レイアウトは過去の分だけ位置を補い、新着の分は下に残る）。
                let follow = (atBottom || following) && !view.isTracking
                let smooth = follow && !prepended
                if smooth { layout?.keepContentOffsetAtBottomOnBatchUpdates = false }
                UIView.performWithoutAnimation {
                    dataSource.apply(snapshot, animatingDifferences: false, commitAlongsideUpdates: commit)
                    if follow { view.layoutIfNeeded() }
                }
                if smooth { layout?.keepContentOffsetAtBottomOnBatchUpdates = true }
                if follow { followBottom() }
            }
            if prepended {
                // 頁が届いたら、残りが足りるか直ぐ確かめる（速いスクロールでは頁が続く）。
                prefetchRequested = false
                DispatchQueue.main.async { [weak self] in self?.prefetchIfLow() }
            }
            report()
            performPendingJump()
        }

        private func isScrolling(_ view: UIScrollView) -> Bool {
            var scrolling = view.isTracking || view.isDecelerating || animatingScroll
            #if targetEnvironment(macCatalyst)
            scrolling = scrolling || wheel?.isActive == true
            #endif
            return scrolling
        }

        /// 止まった時に、待たせていた過去の行を入れる。
        private func flushDeferred() {
            guard applyAfterDrag, let latest, let view, !isScrolling(view) else { return }
            applyAfterDrag = false
            apply(rows: latest.rows, messages: latest.messages, queue: latest.queue, rowContext: latest.rowContext)
        }

        private func followBottom() {
            guard let view else { following = false; return }
            // 残りが数ptなら動かさずに合わせて終える。画素の丸めで1〜2pt残り続けると、追い直しのアニメーションが止まらない。
            guard view.distanceFromBottom > 4 else {
                view.pinToBottom()
                following = false
                return
            }
            following = true
            animatingScroll = true
            view.setContentOffset(CGPoint(x: view.contentOffset.x, y: view.bottomOffset), animated: true)
        }

        func requestJump(_ jump: ConversationJump) {
            if jump.revision != jumpRevision {
                jumpRevision = jump.revision
                pendingJump = jump.id
                pendingFlash = jump.flashesBubble
            }
            performPendingJump()
        }

        /// 行が入っていれば中央へ移し、少し光らせる。
        private func performPendingJump() {
            guard let id = pendingJump, let view, let dataSource,
                  let indexPath = dataSource.indexPath(for: .message(id)) else { return }
            pendingJump = nil
            // 動かない時（もう中央にある）は終わりの通知が来ないので、印を立てない。
            if let frame = view.layoutAttributesForItem(at: indexPath)?.frame {
                let y = min(max(frame.midY - view.bounds.height / 2, -view.adjustedContentInset.top), view.bottomOffset)
                animatingScroll = abs(y - view.contentOffset.y) > 0.5
            }
            view.scrollToItem(at: indexPath, at: .centeredVertically, animated: true)
            let flashes = pendingFlash
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in self?.reveal(.message(id), flash: flashes) }
        }

        /// 元の行を作り直して（本文の該当部分の強調はここで入る）、必要なら吹き出し全体を光らせる。
        private func reveal(_ row: ConversationRow, flash flashes: Bool) {
            guard let view, let indexPath = dataSource?.indexPath(for: row),
                  let cell = view.cellForItem(at: indexPath) as? ConversationCell else { return }
            configure(cell, row: row)
            guard flashes else { return }
            let mark = cell.contentView
            mark.layer.cornerRadius = 14
            mark.backgroundColor = UIColor(BellTheme.violet).withAlphaComponent(0.22)
            UIView.animate(withDuration: 1.2, delay: 0.6, options: .curveEaseOut) {
                mark.backgroundColor = .clear
            }
        }

        func scrollToBottom(animated: Bool) {
            guard let view else { return }
            atBottom = true
            animatingScroll = animated && abs(view.bottomOffset - view.contentOffset.y) > 0.5
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
            let now = following || view.distanceFromBottom <= 48
            guard now != atBottom else { return }
            atBottom = now
            // 配置の途中で呼ばれるので、親の状態は次の周で変える。
            DispatchQueue.main.async { [onAtBottomChange] in onAtBottomChange?(now) }
        }

        /// machine-stream.md「History pages of a long stream」：見ている行より上に max(3画面, 150行, 2秒分の速度) の読込済みを残す。
        /// 足りなければ次の過去の頁を頼む（開いた直後・表示域に収まらない時・届いた直後も同じ判定。上端に届いて空になってから読まない）。
        /// 頼むのは一度に一つ。失敗は次のスクロールの動きまで繰り返さない。親が取得中の間と、届いた行を組み立てている間は頼まない。
        func prefetchIfLow() {
            guard let view, view.bounds.height > 0, hasMore, !loading, !loadingOlder, !preparing, !prefetchRequested, !applyAfterDrag,
                  let first = view.indexPathsForVisibleItems.map(\.item).min() else { return }
            var moving = view.isDragging || view.isDecelerating
            #if targetEnvironment(macCatalyst)
            moving = moving || wheel?.isActive == true
            #endif
            guard ConversationHistoryPage.needsOlder(rowsAbove: first, pointsAbove: view.contentOffset.y + view.adjustedContentInset.top,
                                                     viewHeight: view.bounds.height, speed: moving ? scrollSpeed : 0) else { return }
            prefetchRequested = true
            // 親の更新中の配置から呼ばれ得るので、親の状態は次の周で変える。
            DispatchQueue.main.async { [onLoadOlder] in onLoadOlder?() }
        }

        // MARK: UICollectionViewDelegate

        func collectionView(_ collectionView: UICollectionView, willDisplay cell: UICollectionViewCell, forItemAt indexPath: IndexPath) {
            guard let view, view.revealed, let row = (cell as? ConversationCell)?.row, !shown.contains(row) else { return }
            shown.insert(row)
            enter(cell)
        }

        func collectionView(_ collectionView: UICollectionView, shouldSelectItemAt indexPath: IndexPath) -> Bool { false }

        func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
            if !decelerate { flushDeferred() }
        }

        func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) {
            flushDeferred()
        }

        func scrollViewDidEndScrollingAnimation(_ scrollView: UIScrollView) {
            animatingScroll = false
            // この通知の中で過去の行を入れると、直後にUIKitがアニメーションの行き先（古い座標）へ位置を置き直し、過去へ飛ぶ（実測 -23,174pt）。
            // 次の周で入れる（レイアウトが位置を補う）。その後で、末尾が遠のいていれば続けて追う。
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                flushDeferred()
                guard following, !animatingScroll else { return }
                followBottom()
                if !following { report() }
            }
        }

        func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
            following = false
            // 指が触れるとアニメーションは打ち切られ、終わりの通知は来ない。
            animatingScroll = false
            #if targetEnvironment(macCatalyst)
            wheel?.stop()
            #endif
        }

        func scrollViewDidScroll(_ scrollView: UIScrollView) {
            guard let view else { return }
            let delta = view.contentOffset.y - lastOffset
            lastOffset = view.contentOffset.y
            let now = CACurrentMediaTime()
            scrollSpeed = now - lastScrollTime < 0.5 && now > lastScrollTime ? abs(delta) / CGFloat(now - lastScrollTime) : 0
            lastScrollTime = now
            report()
            var userDriven = view.isDragging || view.isDecelerating
            #if targetEnvironment(macCatalyst)
            userDriven = userDriven || wheel?.isActive == true
            #endif
            guard userDriven else { return }
            prefetchRequested = false
            prefetchIfLow()
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
