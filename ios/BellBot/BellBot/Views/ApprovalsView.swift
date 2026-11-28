import CryptoKit
import SwiftUI

// 決裁箱の画面（docs/architecture/modules/approval-box-extension/screen-spec.md）。色・札・カードはLatticeの意匠を使う。

/// Keeps the 決裁箱 read path (entry count + screen) running while the app is in front; 読み直す restarts it.
struct ApprovalsRunner: ViewModifier {
    @ObservedObject var model: ApprovalsModel
    @EnvironmentObject private var store: AppStore
    @Environment(\.scenePhase) private var scenePhase

    func body(content: Content) -> some View {
        content.task(id: "\(scenePhase == .active)-\(model.readRequest)") {
            guard scenePhase == .active else { return }
            model.setRoster(store.bots)
            await model.run(api: store.api)
        }
        .onChange(of: store.bots) { _, bots in model.setRoster(bots) }
    }
}

/// 左のメニューの先頭の固定行（screen-spec 「Entry」A）。待ちが1件以上なら輪郭とグロー、0件なら静か。
struct ApprovalsEntryRow: View {
    @ObservedObject var model: ApprovalsModel
    let action: () -> Void

    var body: some View {
        let count = model.pendingCount
        let waiting = count > 0 && model.gate == .ready
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: "tray").font(.system(size: 17, weight: .semibold)).foregroundStyle(.white)
                    .frame(width: 38, height: 38).background(waiting ? BellTheme.violet : LatticePalette.unknown, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                VStack(alignment: .leading, spacing: 2) {
                    Text("決裁箱").font(.system(size: 15, weight: .bold)).foregroundStyle(BellTheme.ink)
                    Text(model.entrySubtitle).font(.system(size: 12)).foregroundStyle(BellTheme.muted).lineLimit(1)
                }
                Spacer(minLength: 6)
                if (model.summary?.urgent ?? 0) > 0 { Image(systemName: "bolt.fill").foregroundStyle(LatticePalette.amber).accessibilityHidden(true) }
                if waiting {
                    Text("\(count)").font(.system(size: 13, weight: .bold)).foregroundStyle(.white)
                        .padding(.horizontal, 9).padding(.vertical, 3).background(BellTheme.violet, in: Capsule())
                }
            }
            .padding(10)
            .background(.white.opacity(0.9), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(waiting ? BellTheme.violet.opacity(0.6) : BellTheme.line, lineWidth: waiting ? 1.6 : 1))
            .shadow(color: waiting ? BellTheme.violet.opacity(0.14) : .clear, radius: 8, y: 3)
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(waiting ? "決裁箱、回答待ち\(count)件" : "決裁箱、待っている決裁はありません")
        .accessibilityIdentifier("open-approvals")
    }
}

struct ApprovalsHomeView: View {
    @EnvironmentObject private var store: AppStore

    var body: some View { ApprovalsScreen(model: store.approvals) }
}

// MARK: Atoms

private struct ApprovalBadge: View {
    let text: String
    let symbol: String
    var tone: Color = LatticePalette.muted

    var body: some View {
        Label { Text(text).lineLimit(1) } icon: { Image(systemName: symbol) }
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(tone)
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(tone.opacity(0.12), in: Capsule())
    }
}

/// 出どころの顔：BellTeamのメンバーは名簿の顔、外部は灰色の角丸の道具の札（メンバーの色とは混ざらない）。
private struct ApprovalOriginFace: View {
    @EnvironmentObject private var store: AppStore
    let decision: ApprovalDecision
    let size: CGFloat

    var body: some View {
        if decision.origin.isBellTeam {
            if let bot = store.bots.first(where: { $0.id == decision.requester?.botId }) {
                AvatarView(name: bot.displayName, avatar: bot.avatar, color: BellTheme.accent(bot.color), size: size)
            } else {
                tile(nil, symbol: decision.origin.tileSymbol)
            }
        } else {
            tile(nil, symbol: decision.origin.tileSymbol)
        }
    }

    private func tile(_ text: String?, symbol: String?) -> some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.31, style: .continuous).fill(LatticePalette.unknown.opacity(0.22))
            if let symbol { Image(systemName: symbol).font(.system(size: size * 0.46, weight: .semibold)).foregroundStyle(LatticePalette.muted) }
            if let text { Text(text).font(.system(size: size * 0.46, weight: .bold, design: .rounded)).foregroundStyle(LatticePalette.muted) }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

private struct ApprovalCard: View {
    let decision: ApprovalDecision
    let selected: Bool
    let done: Bool

    var body: some View {
        let held = decision.isHeld
        let cancelled = decision.status == "cancelled"
        HStack(alignment: .top, spacing: 0) {
            if decision.isUrgent && decision.isOpen { Rectangle().fill(LatticePalette.amber).frame(width: 4) }
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 6) {
                    if done {
                        ApprovalBadge(text: cancelled ? "取り下げ" : "回答済み", symbol: cancelled ? "xmark" : "checkmark.seal", tone: LatticePalette.muted)
                    } else if held {
                        ApprovalBadge(text: "保留", symbol: "pause", tone: LatticePalette.muted)
                    } else {
                        ApprovalBadge(text: "回答待ち", symbol: "tray", tone: BellTheme.violet)
                    }
                    if decision.isUrgent && decision.isOpen { ApprovalBadge(text: "急ぎ", symbol: "bolt.fill", tone: LatticePalette.amber) }
                    if decision.origin.isExternal { ApprovalBadge(text: "外部から", symbol: "arrow.down.right", tone: LatticePalette.muted) }
                    Spacer(minLength: 4)
                    Text(LatticeTime.since(decision.createdAt, now: Date())).font(.system(size: 11)).foregroundStyle(LatticePalette.muted)
                }
                HStack(spacing: 8) {
                    ApprovalOriginFace(decision: decision, size: 22)
                    Text(ApprovalText.originCaption(decision)).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(LatticePalette.muted).lineLimit(1)
                }
                Text(verbatim: decision.title)
                    .font(.system(size: 15, weight: .semibold)).foregroundStyle(LatticePalette.ink)
                    .strikethrough(cancelled).lineLimit(2).multilineTextAlignment(.leading)
                if done {
                    if cancelled, let reason = decision.cancelReason, !reason.isEmpty {
                        Text(verbatim: reason).font(.system(size: 12.5)).foregroundStyle(LatticePalette.muted).lineLimit(2)
                    } else if let answer = decision.answer {
                        HStack(spacing: 6) {
                            Text("あなたの答え：\(answerText(answer))").lineLimit(1)
                            Text(LatticeTime.stopTime(answer.answeredAt, now: Date()))
                        }
                        .font(.system(size: 12.5)).foregroundStyle(LatticePalette.muted)
                        deliveryBadge
                    }
                } else {
                    Label { Text(held ? (decision.origin.isExternal ? ApprovalText.heldExternal : ApprovalText.held) : decision.linkNote).lineLimit(2) } icon: {
                        Image(systemName: decision.linkIsMuted ? "link.badge.plus" : "link")
                    }
                    .font(.system(size: 12)).foregroundStyle(decision.linkIsMuted || held ? LatticePalette.muted : BellTheme.violet)
                    HStack(spacing: 6) {
                        if let deadline = ApprovalText.deadline(decision.deadline) {
                            ApprovalBadge(text: deadline, symbol: "clock", tone: LatticePalette.muted)
                        }
                        if decision.recommended != nil { ApprovalBadge(text: "推奨あり", symbol: "star", tone: BellTheme.violet) }
                    }
                }
            }
            .padding(14)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(LatticePalette.surface.opacity(held || done ? 0.7 : 1), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous)
            .strokeBorder(held ? LatticePalette.line : (selected || (!done && decision.isPending) ? BellTheme.violet.opacity(selected ? 0.9 : 0.5) : LatticePalette.line),
                          style: StrokeStyle(lineWidth: selected ? 2 : 1.2, dash: held ? [5, 4] : [])))
        .shadow(color: !done && decision.isPending ? BellTheme.violet.opacity(0.12) : .clear, radius: 10, y: 4)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibility)
        .accessibilityIdentifier("approval-card")
    }

    private func answerText(_ answer: ApprovalAnswer) -> String {
        if let id = answer.optionId, let option = decision.options.first(where: { $0.id == id }) { return option.label }
        return "指示を返しました"
    }

    @ViewBuilder private var deliveryBadge: some View {
        switch decision.delivery {
        case "delivered", "fetched": ApprovalBadge(text: "届きました", symbol: "checkmark", tone: LatticePalette.live)
        case "unknown": ApprovalBadge(text: "届いたか不明", symbol: "questionmark", tone: LatticePalette.amber)
        default: EmptyView()
        }
    }

    private var accessibility: String {
        var parts = [done ? "回答済み" : (decision.isHeld ? "保留" : "回答待ち")]
        if decision.isUrgent && decision.isOpen { parts.append("急ぎ") }
        if decision.origin.isExternal { parts.append("外部から") }
        parts += [decision.title, ApprovalText.originCaption(decision)]
        if let deadline = ApprovalText.deadline(decision.deadline) { parts.append(deadline) }
        if !done { parts.append(decision.linkNote) }
        return parts.joined(separator: "、")
    }
}

// MARK: Screen

private struct ApprovalsScreen: View {
    enum Tab: String, CaseIterable { case pending = "待ち", held = "保留", done = "済み" }
    enum Origin: String, CaseIterable { case all = "すべて", bellteam = "BellTeam", external = "外部" }

    @ObservedObject var model: ApprovalsModel
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openWindow) private var openWindow
    @State private var tab = Tab.pending
    @State private var origin = Origin.all
    @State private var selected: String?
    @State private var sheet: String?
    @State private var isWide = false

    private func matches(_ d: ApprovalDecision) -> Bool {
        switch origin {
        case .all: true
        case .bellteam: d.origin.isBellTeam
        case .external: d.origin.isExternal
        }
    }

    private var pending: [ApprovalDecision] { model.open.filter(\.isPending) }
    private var held: [ApprovalDecision] { model.open.filter(\.isHeld) }
    private func count(_ list: [ApprovalDecision], _ o: Origin) -> Int {
        list.filter { o == .all ? true : (o == .bellteam ? $0.origin.isBellTeam : $0.origin.isExternal) }.count
    }
    private var currentList: [ApprovalDecision] { tab == .pending ? pending : (tab == .held ? held : model.done) }

    var body: some View {
        GeometryReader { area in
            let wide = area.size.width >= 1000
            VStack(spacing: 0) {
                header(wide: wide)
                Divider()
                content(wide: wide, width: area.size.width)
            }
            .background(LatticePalette.canvas)
            .onChange(of: area.size.width, initial: true) { _, width in isWide = width >= 1360 }
        }
        .navigationTitle("決裁箱")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: tab) { if tab == .done, !model.doneLoaded { await model.loadDone(more: false) } }
        .onChange(of: model.openRequest, initial: true) { _, id in
            guard let id else { return }
            model.openRequest = nil
            tab = .pending
            select(id)
        }
        .sheet(item: Binding(get: { sheet.map(SheetID.init) }, set: { sheet = $0?.id })) { item in
            ApprovalDetailView(model: model, id: item.id, onClose: { sheet = nil }, openChart: openChart)
                .environmentObject(store)
                .presentationDetents([.large])
        }
    }

    private struct SheetID: Identifiable { let id: String }

    private func select(_ id: String) {
        selected = id
        if tab != .done, let d = model.decision(id), d.isHeld { tab = .held } else if let d = model.decision(id), !d.isOpen { tab = .done }
    }

    private func open(_ d: ApprovalDecision, wide: Bool) {
        selected = d.id
        if !wide { sheet = d.id }
    }

    private func openChart(_ link: ApprovalLink, _ card: String?) {
        store.openLatticeCard(project: link.chart.projectId, card: card)
        #if targetEnvironment(macCatalyst)
        MainWindow.bringToFront("lattice", open: { openWindow(id: "lattice") }) { _ in }
        #endif
    }

    // MARK: Header

    private func header(wide: Bool) -> some View {
        let summary = model.summary
        let ring = LatticeRing(done: summary?.answeredToday ?? 0, total: max(summary?.filedToday ?? 0, summary?.answeredToday ?? 0), size: 38)
        return VStack(spacing: 10) {
            HStack(spacing: 12) {
                Label { Text("決裁箱") } icon: { Image(systemName: "tray") }
                    .font(.system(size: 15, weight: .bold)).foregroundStyle(BellTheme.violet)
                    .padding(.horizontal, 12).padding(.vertical, 6).background(BellTheme.violet.opacity(0.12), in: Capsule())
                if let summary, summary.pending > 0 {
                    Text("\(summary.pending)").font(.system(size: 12, weight: .bold)).foregroundStyle(.white)
                        .padding(.horizontal, 8).padding(.vertical, 2).background(BellTheme.violet, in: Capsule())
                        .accessibilityLabel("回答待ち\(summary.pending)件")
                }
                if showsData { livePill }
                Spacer(minLength: 8)
                if wide && showsData { segmented; Spacer(minLength: 8) }
                if summary != nil && showsData { HStack(spacing: 6) { ring; Text("今日の回答").font(.system(size: 11)).foregroundStyle(LatticePalette.muted) } }
                Button { model.reread() } label: { Image(systemName: "arrow.clockwise") }
                    .accessibilityLabel("読み直す").accessibilityIdentifier("approvals-reread")
            }
            if !wide && showsData { segmented }
            if showsData, let summary {
                HStack(spacing: 14) {
                    counter("待ち", summary.pending); counter("急ぎ", summary.urgent); counter("保留", summary.held)
                    Spacer(minLength: 0)
                }
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 10)
        .background(LatticePalette.surface)
    }

    /// The gates (not entitled, not connected, …) draw no list controls: there is nothing to count or switch.
    private var showsData: Bool { model.gate == .ready || model.gate == .reconnecting || model.gate == .loading }

    private func counter(_ label: String, _ value: Int) -> some View {
        HStack(spacing: 4) {
            Text(label).foregroundStyle(LatticePalette.muted)
            Text("\(value)").fontWeight(.bold).foregroundStyle(LatticePalette.ink).monospacedDigit()
        }
        .font(.system(size: 12.5)).accessibilityElement(children: .combine)
    }

    private var livePill: some View {
        let live = model.gate == .ready
        return HStack(spacing: 5) {
            Circle().fill(live ? LatticePalette.live : LatticePalette.amber).frame(width: 7, height: 7)
            Text(live ? "ライブ" : "再接続中").font(.system(size: 12, weight: .semibold))
        }
        .foregroundStyle(LatticePalette.muted)
        .padding(.horizontal, 9).padding(.vertical, 4).background(LatticePalette.lane, in: Capsule())
    }

    private var segmented: some View {
        Picker("表示", selection: $tab) {
            Text("待ち \(summaryCount(.pending))").tag(Tab.pending)
            Text("保留 \(summaryCount(.held))").tag(Tab.held)
            Text("済み").tag(Tab.done)
        }
        .pickerStyle(.segmented).frame(maxWidth: 340)
        .accessibilityIdentifier("approvals-tabs")
    }

    private func summaryCount(_ t: Tab) -> Int { t == .pending ? (model.summary?.pending ?? pending.count) : (model.summary?.held ?? held.count) }

    // MARK: Body

    @ViewBuilder private func content(wide: Bool, width: CGFloat) -> some View {
        switch model.gate {
        case .loading:
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        case .ready, .reconnecting:
            ZStack(alignment: .top) {
                if wide {
                    HStack(spacing: 0) {
                        list(wide: true).frame(width: 500)
                        Divider()
                        detailColumn.frame(width: 520)
                        Divider()
                        chainColumn.frame(maxWidth: .infinity)
                    }
                } else {
                    list(wide: false)
                }
                if model.stale {
                    HStack(spacing: 10) {
                        Text(ApprovalBoxWords.reconnecting).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(LatticePalette.ink)
                        Button(ApprovalBoxWords.retryNow) { model.link.retryNow() }.font(.system(size: 12.5, weight: .semibold))
                    }
                    .padding(.horizontal, 12).padding(.vertical, 6).background(.regularMaterial, in: Capsule()).padding(.top, 8)
                }
            }
            .opacity(model.stale ? 0.55 : 1)
            .animation(.easeInOut(duration: 0.2), value: model.stale)
        case .join:
            ChildJoinView(source: model.link)
        case .notEntitled, .updateRequired, .adding:
            ApprovalGateView(model: model)
        }
    }

    private func list(wide: Bool) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 10) {
                if tab != .done { originFilter }
                if tab == .done { doneList } else { openList }
                disconnectRow
            }
            .padding(14)
            .padding(.top, model.stale ? 44 : 0) // room for the 再接続 band, which lies over the list
            .padding(.bottom, wide ? 0 : 70)
        }
        .refreshable { model.reread() }
    }

    /// 「つなぎを外す」 (two steps): this device leaves the Owner's Approval Box; BellTeam's own sign-in stays.
    private var disconnectRow: some View { ChildJoinLiveBlock(source: model.link).padding(.top, 14) }

    private var originFilter: some View {
        VStack(alignment: .leading, spacing: 6) {
            Picker("出どころ", selection: $origin) {
                ForEach(Origin.allCases, id: \.self) { o in Text("\(o.rawValue) \(count(tab == .held ? held : pending, o))").tag(o) }
            }
            .pickerStyle(.segmented).accessibilityIdentifier("approvals-origin")
            let hidden = origin == .bellteam ? count(tab == .held ? held : pending, .external) : 0
            if hidden > 0 {
                HStack(spacing: 8) {
                    Text(ApprovalText.filter(hidden: hidden)).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(LatticePalette.amber)
                    Button("すべてを見る") { origin = .all }.font(.system(size: 12.5, weight: .semibold))
                }
            }
        }
    }

    @ViewBuilder private var openList: some View {
        let first = (tab == .held ? [] : pending.filter(matches))
        let second = (tab == .pending ? held.filter(matches) : (tab == .held ? held.filter(matches) : []))
        if first.isEmpty && second.isEmpty {
            empty(summaryCount(.pending) + summaryCount(.held) == 0 ? ApprovalText.empty : "この条件の決裁はありません。", showDone: true)
        }
        ForEach(first) { d in cardButton(d, done: false) }
        if tab == .pending && !second.isEmpty {
            HStack { Text("保留").font(.system(size: 11.5, weight: .semibold)).foregroundStyle(LatticePalette.muted); Rectangle().fill(LatticePalette.line).frame(height: 1) }
                .padding(.top, 6)
        }
        if tab != .held || first.isEmpty { ForEach(second) { d in cardButton(d, done: false) } }
    }

    @ViewBuilder private var doneList: some View {
        if !model.doneLoaded {
            ProgressView().frame(maxWidth: .infinity).padding(.top, 40)
        } else if model.done.isEmpty {
            empty(ApprovalText.noDone, showDone: false)
        } else {
            let groups = Dictionary(grouping: model.done) { LatticeTime.tokyo.startOfDay(for: LatticeTime.date($0.updatedAt) ?? .distantPast) }
            ForEach(groups.keys.sorted(by: >), id: \.self) { day in
                Text(LatticeTime.dayHeading(day, now: Date())).font(.system(size: 12, weight: .semibold)).foregroundStyle(LatticePalette.muted).padding(.top, 4)
                ForEach(groups[day] ?? []) { d in cardButton(d, done: true) }
            }
        }
    }

    private func empty(_ text: String, showDone: Bool) -> some View {
        VStack(spacing: 10) {
            Image(systemName: "tray").font(.system(size: 30)).foregroundStyle(LatticePalette.muted)
            Text(text).font(.system(size: 14)).foregroundStyle(LatticePalette.muted).multilineTextAlignment(.center)
            if showDone { Button("済みを見る") { tab = .done } }
        }
        .frame(maxWidth: .infinity).padding(.top, 40)
        .accessibilityIdentifier("approvals-empty")
    }

    private func cardButton(_ d: ApprovalDecision, done: Bool) -> some View {
        Button { open(d, wide: isWide) } label: {
            ApprovalCard(decision: d, selected: selected == d.id, done: done)
        }
        .buttonStyle(.plain)
        .transition(.scale(scale: 0.92).combined(with: .opacity))
    }

    private var detailColumn: some View {
        Group {
            if let id = selected, model.decision(id) != nil {
                ApprovalDetailView(model: model, id: id, onClose: nil, openChart: openChart, showsChain: false)
            } else {
                VStack(spacing: 8) {
                    Image(systemName: "tray").font(.system(size: 28)).foregroundStyle(LatticePalette.muted)
                    Text("決裁を選ぶと、ここに詳細が出ます。").font(.system(size: 13.5)).foregroundStyle(LatticePalette.muted)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }

    private var chainColumn: some View {
        ScrollView {
            if let id = selected, let d = model.decision(id) { ApprovalChainPanel(decision: d, openChart: openChart).padding(16) }
        }
        .background(LatticePalette.lane.opacity(0.5))
    }
}

// MARK: Detail

private struct ApprovalDetailView: View {
    enum Choice: Equatable { case option(String), text }

    @ObservedObject var model: ApprovalsModel
    let id: String
    let onClose: (() -> Void)?
    let openChart: (ApprovalLink, String?) -> Void
    var showsChain = true
    @EnvironmentObject private var store: AppStore
    @Environment(\.openURL) private var openURL
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var choice: Choice?
    @State private var draft = ""
    @State private var copied = false
    @State private var viewing: ApprovalAttachment?

    var body: some View {
        if let d = model.decision(id) {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    top(d)
                    if d.origin.isExternal { externalBlock(d) }
                    section("背景") { linkified(d.context) }
                    if !d.requestAttachments.isEmpty { section("添付") { attachments(d) } }
                    if let recommended = d.recommended, d.isOpen {
                        Label { Text("AIの推奨：\(recommended.label)") } icon: { Image(systemName: "star") }
                            .font(.system(size: 13.5, weight: .semibold)).foregroundStyle(BellTheme.violet)
                    }
                    actions(d)
                    if showsChain { ApprovalChainPanel(decision: d, openChart: openChart) }
                    history(d)
                }
                .padding(18)
            }
            .background(LatticePalette.surface)
            .onChange(of: d.version) { _, _ in if choice != nil, d.amended.is { choice = nil } }
            .accessibilityIdentifier("approval-detail")
        }
    }

    private func top(_ d: ApprovalDecision) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                if d.isOpen {
                    ApprovalBadge(text: d.isHeld ? "保留" : "回答待ち", symbol: d.isHeld ? "pause" : "tray", tone: d.isHeld ? LatticePalette.muted : BellTheme.violet)
                } else {
                    ApprovalBadge(text: d.status == "cancelled" ? "取り下げ" : "回答済み", symbol: d.status == "cancelled" ? "xmark" : "checkmark.seal")
                }
                if d.isUrgent && d.isOpen { ApprovalBadge(text: "急ぎ", symbol: "bolt.fill", tone: LatticePalette.amber) }
                if d.origin.isExternal { ApprovalBadge(text: "外部から", symbol: "arrow.down.right") }
                if d.amended.is { ApprovalBadge(text: "修正あり", symbol: "pencil", tone: BellTheme.violet) }
                Spacer()
                if let onClose { Button(action: onClose) { Image(systemName: "xmark.circle.fill").font(.title3) }.foregroundStyle(LatticePalette.muted).accessibilityLabel("閉じる") }
            }
            Text(verbatim: d.title).font(.system(size: 19, weight: .bold)).foregroundStyle(LatticePalette.ink)
            HStack(spacing: 8) {
                ApprovalOriginFace(decision: d, size: 24)
                Text(ApprovalText.originCaption(d)).font(.system(size: 13, weight: .semibold)).foregroundStyle(LatticePalette.muted)
            }
            HStack(spacing: 12) {
                Text("受付 \(LatticeTime.jstText(d.createdAt))")
                if let deadline = ApprovalText.deadline(d.deadline) { Text(deadline) }
            }
            .font(.system(size: 12)).foregroundStyle(LatticePalette.muted)
            if d.amended.is, let note = d.amended.note, !note.isEmpty {
                Text(verbatim: note).font(.system(size: 12.5)).foregroundStyle(BellTheme.violet)
            }
        }
    }

    private func externalBlock(_ d: ApprovalDecision) -> some View {
        HStack(alignment: .top, spacing: 12) {
            ApprovalOriginFace(decision: d, size: 34)
            VStack(alignment: .leading, spacing: 3) {
                Text("BellTeamの外から届いた決裁です").font(.system(size: 13.5, weight: .bold)).foregroundStyle(LatticePalette.ink)
                Text(d.origin.toolName + (d.origin.viaText.isEmpty ? "" : " · \(d.origin.viaText)")).font(.system(size: 12.5)).foregroundStyle(LatticePalette.muted)
                if let label = d.origin.sessionLabel, !label.isEmpty { Text(verbatim: label).font(.system(size: 12.5)).foregroundStyle(LatticePalette.muted) }
            }
        }
        .padding(12).frame(maxWidth: .infinity, alignment: .leading)
        .background(LatticePalette.lane, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(title).font(.system(size: 11.5, weight: .semibold)).foregroundStyle(LatticePalette.muted)
            content()
        }
    }

    /// 背景: plain text; a link opens the browser in one tap.
    private func linkified(_ text: String) -> some View {
        var attributed = AttributedString(text)
        let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)
        for match in detector?.matches(in: text, range: NSRange(text.startIndex..., in: text)) ?? [] {
            if let range = Range(match.range, in: attributed), let url = match.url, ["http", "https"].contains(url.scheme) { attributed[range].link = url }
        }
        return Text(attributed).font(.system(size: 14)).foregroundStyle(LatticePalette.ink).fixedSize(horizontal: false, vertical: true)
    }

    private func attachments(_ d: ApprovalDecision) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                ForEach(d.requestAttachments) { a in
                    Button { viewing = a } label: { ApprovalImage(link: model.link, attachment: a, side: 96) }.buttonStyle(.plain)
                }
            }
        }
        .sheet(item: $viewing) { a in
            ApprovalImage(link: model.link, attachment: a, side: nil).padding().presentationDetents([.large])
        }
    }

    // MARK: Actions

    @ViewBuilder private func actions(_ d: ApprovalDecision) -> some View {
        let sending = model.sending.contains(d.id)
        VStack(alignment: .leading, spacing: 10) {
            if d.status == "answered" {
                answered(d)
            } else if d.status == "cancelled" {
                if let reason = d.cancelReason, !reason.isEmpty { Text(verbatim: "AIが取り下げました：\(reason)").font(.system(size: 13.5)).foregroundStyle(LatticePalette.muted) }
            } else if d.isPending {
                if sending {
                    HStack(spacing: 8) { ProgressView(); Text("答えを送っています…") }.font(.system(size: 14, weight: .semibold)).foregroundStyle(LatticePalette.muted)
                } else if let choice { confirm(d, choice) } else { options(d) }
            } else {
                Button("保留を戻す") { Task { await model.hold(d, hold: false) } }.buttonStyle(.bordered).disabled(sending)
            }
            if let note = model.notes[d.id] { noteView(note) }
            if d.isPending && choice == nil && !sending {
                Button { Task { await model.hold(d, hold: true) } } label: { Label("保留にする", systemImage: "pause") }
                    .font(.system(size: 13.5, weight: .semibold)).buttonStyle(.bordered)
                    .accessibilityIdentifier("approval-hold")
            }
        }
    }

    private func options(_ d: ApprovalDecision) -> some View {
        section("答えを選ぶ") {
            VStack(spacing: 8) {
                ForEach(d.options) { o in
                    Button { withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.15)) { choice = .option(o.id) } } label: {
                        HStack {
                            Text(verbatim: o.label).multilineTextAlignment(.leading)
                            Spacer(minLength: 6)
                            if o.recommended { Text("推奨").font(.system(size: 11, weight: .bold)).padding(.horizontal, 6).padding(.vertical, 2).background(.white.opacity(0.25), in: Capsule()) }
                        }
                        .font(.system(size: 14.5, weight: .semibold))
                        .foregroundStyle(o.recommended ? .white : LatticePalette.ink)
                        .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                        .background(o.recommended ? AnyShapeStyle(BellTheme.violet) : AnyShapeStyle(LatticePalette.lane), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(o.recommended ? "\(o.label)、推奨" : o.label)
                }
                Button { choice = .text } label: { Label("選ばずに、指示を書いて返す", systemImage: "pencil") }
                    .font(.system(size: 13.5, weight: .semibold)).padding(.top, 2)
                    .accessibilityIdentifier("approval-text-answer")
            }
        }
    }

    @ViewBuilder private func confirm(_ d: ApprovalDecision, _ choice: Choice) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            switch choice {
            case .option(let id):
                let label = d.options.first { $0.id == id }?.label ?? ""
                Text(ApprovalText.confirm(label: label, d: d)).font(.system(size: 14, weight: .semibold)).foregroundStyle(LatticePalette.ink)
                    .fixedSize(horizontal: false, vertical: true)
                HStack {
                    Button("答える") { Task { await model.answer(d, optionId: id, text: nil); self.choice = nil } }
                        .buttonStyle(.borderedProminent).accessibilityIdentifier("approval-confirm")
                    Button("やめる") { self.choice = nil }.buttonStyle(.bordered)
                }
            case .text:
                TextEditor(text: $draft).frame(minHeight: 100).padding(6)
                    .background(LatticePalette.lane, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .overlay(alignment: .topLeading) { if draft.isEmpty { Text("AIへの指示を書いてください").foregroundStyle(LatticePalette.muted).padding(12).allowsHitTesting(false) } }
                let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty {
                    Text("この指示で返しますか？ 答えると、\(d.addressee)に届きます。").font(.system(size: 14, weight: .semibold)).foregroundStyle(LatticePalette.ink)
                }
                HStack {
                    Button("指示を送る") { Task { await model.answer(d, optionId: nil, text: trimmed); draft = ""; self.choice = nil } }
                        .buttonStyle(.borderedProminent).disabled(trimmed.isEmpty).accessibilityIdentifier("approval-text-confirm")
                    Button("やめる") { self.choice = nil }.buttonStyle(.bordered)
                }
            }
        }
        .padding(12).background(BellTheme.violet.opacity(0.07), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    @ViewBuilder private func answered(_ d: ApprovalDecision) -> some View {
        if let answer = d.answer {
            section("あなたの答え") {
                VStack(alignment: .leading, spacing: 6) {
                    if let optionId = answer.optionId, let label = d.options.first(where: { $0.id == optionId })?.label {
                        Label { Text(verbatim: label) } icon: { Image(systemName: "checkmark.seal") }.font(.system(size: 14.5, weight: .semibold))
                    }
                    if let text = answer.text, !text.isEmpty { Text(verbatim: text).font(.system(size: 14)) }
                    ForEach(answer.attachments) { a in Label { Text(verbatim: a.name) } icon: { Image(systemName: "paperclip") }.font(.system(size: 12.5)) }
                    Text(LatticeTime.jstText(answer.answeredAt)).font(.system(size: 12)).foregroundStyle(LatticePalette.muted)
                }
                .foregroundStyle(LatticePalette.ink)
            }
            if model.notes[d.id] == nil {
                let banner = ApprovalText.answerBanner(d)
                noteView(.init(text: banner.text, tone: banner.tone))
            }
            if d.delivery == "unknown" {
                Button { UIPasteboard.general.string = d.resumePhrase; copied = true
                    Task { try? await Task.sleep(for: .seconds(2)); copied = false } } label: {
                    Label(copied ? "コピーしました" : "再開の文をコピー", systemImage: copied ? "checkmark" : "doc.on.doc")
                }
                .buttonStyle(.bordered).accessibilityIdentifier("approval-copy-resume")
            }
        }
    }

    private func noteView(_ note: ApprovalsModel.Note) -> some View {
        Text(verbatim: note.text).font(.system(size: 13.5, weight: .semibold)).foregroundStyle(note.tone.color)
            .fixedSize(horizontal: false, vertical: true)
            .padding(10).frame(maxWidth: .infinity, alignment: .leading)
            .background(note.tone.color.opacity(0.1), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .accessibilityIdentifier("approval-note")
    }

    private func history(_ d: ApprovalDecision) -> some View {
        section("経過") {
            VStack(alignment: .leading, spacing: 5) {
                ForEach(Array(d.history.enumerated()), id: \.offset) { _, entry in
                    if let text = Self.historyText(entry) {
                        HStack(alignment: .top, spacing: 8) {
                            Text(LatticeTime.jstText(entry.at)).monospacedDigit().foregroundStyle(LatticePalette.muted)
                            Text(text).foregroundStyle(LatticePalette.ink)
                        }
                        .font(.system(size: 12.5))
                    }
                }
            }
        }
    }

    static let fieldWords = ["title": "件名", "context": "背景", "options": "選択肢", "deadline": "期限", "urgency": "急ぎ度", "recommendation": "推奨"]

    static func historyText(_ entry: ApprovalHistoryEntry) -> String? {
        switch entry.kind {
        case "created": return "依頼を受け付けました"
        case "amended":
            let fields = (entry.fields ?? []).compactMap { fieldWords[$0] }
            return fields.isEmpty ? "内容を直しました（修正あり）" : "内容を直しました（修正あり）：\(fields.joined(separator: "・"))"
        case "held": return "保留にしました"
        case "unheld": return "保留を戻しました"
        case "answered": return "答えました"
        case "cancelled": return "取り下げられました"
        default: return nil
        }
    }
}

// MARK: Attachment image (size and sha256 are checked against the body)

private struct ApprovalImage: View {
    let link: ApprovalBoxLink
    let attachment: ApprovalAttachment
    let side: CGFloat?
    @State private var image: UIImage?
    @State private var failed = false

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image).resizable().scaledToFit()
                    .frame(width: side, height: side)
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .accessibilityLabel("添付の画像 \(attachment.name)")
            } else {
                RoundedRectangle(cornerRadius: 10, style: .continuous).fill(LatticePalette.lane)
                    .frame(width: side ?? 200, height: side ?? 200)
                    .overlay { if failed { Text("画像を確かめられませんでした").font(.system(size: 11)).foregroundStyle(LatticePalette.muted).padding(6) } else { ProgressView() } }
            }
        }
        .task {
            guard let data = link.blob(attachment.id), data.count == attachment.size,
                  SHA256.hash(data: data).map({ String(format: "%02x", $0) }).joined() == attachment.sha256.lowercased(),
                  let picture = UIImage(data: data) else { failed = true; return }
            image = picture
        }
    }
}

// MARK: 工程とのつながり

private struct ApprovalChainPanel: View {
    let decision: ApprovalDecision
    let openChart: (ApprovalLink, String?) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("工程とのつながり").font(.system(size: 11.5, weight: .semibold)).foregroundStyle(LatticePalette.muted)
            if let link = decision.link {
                ForEach(Array(link.previous.enumerated()), id: \.offset) { _, t in miniCard(t, highlight: false, label: "前の工程") }
                miniCard(link.task, highlight: true, label: "この決裁の工程")
                ForEach(Array(link.next.enumerated()), id: \.offset) { _, t in miniCard(t, highlight: false, label: "次の工程") }
                if decision.isOpen {
                    Text("答えると、「\(link.task.title)」が済みになり、\(nextLine(link))答えで決まらない時は、新しい決裁が工程に差し込まれます。")
                        .font(.system(size: 13)).foregroundStyle(LatticePalette.ink).fixedSize(horizontal: false, vertical: true)
                }
                if let card = link.task.cardId {
                    Button { openChart(link, card) } label: { Label("工程表の工程を開く", systemImage: "arrow.up.right.square") }
                        .buttonStyle(.bordered).accessibilityIdentifier("approval-open-chart")
                }
            } else if decision.origin.isExternal {
                VStack(alignment: .leading, spacing: 6) {
                    Text("つながっていません。この決裁は、BellTeamの外から届きました。工程は作りません。").font(.system(size: 13, weight: .semibold))
                    Text("答えは、出したAI（\(decision.addressee)）へそのまま届きます。BellTeamの工程には何も起こりません。").font(.system(size: 12.5))
                }
                .foregroundStyle(LatticePalette.muted).padding(12).frame(maxWidth: .infinity, alignment: .leading)
                .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(LatticePalette.line, style: StrokeStyle(lineWidth: 1.2, dash: [5, 4])))
            } else {
                Text(decision.linkNote).font(.system(size: 13)).foregroundStyle(LatticePalette.muted)
                    .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(LatticePalette.line, style: StrokeStyle(lineWidth: 1.2, dash: [5, 4])))
            }
        }
        .accessibilityIdentifier("approval-chain")
    }

    private func nextLine(_ link: ApprovalLink) -> String {
        guard let next = link.next.first else { return "" }
        return "「\(next.title)」へ進めます。"
    }

    private func miniCard(_ task: ApprovalLinkTask, highlight: Bool, label: String) -> some View {
        let words = ["done": "済み", "ready": "着手可", "in-progress": "作業中", "blocked": "止まり", "pending": "待ち", "retired": "取り下げ"]
        return VStack(alignment: .leading, spacing: 4) {
            Text(label).font(.system(size: 10.5, weight: .semibold)).foregroundStyle(LatticePalette.muted)
            Text(verbatim: task.title).font(.system(size: 13.5, weight: .semibold)).foregroundStyle(LatticePalette.ink).lineLimit(2)
            Text(words[task.state] ?? "その他").font(.system(size: 11.5)).foregroundStyle(LatticePalette.muted)
        }
        .padding(10).frame(maxWidth: .infinity, alignment: .leading)
        .background(LatticePalette.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(highlight ? BellTheme.violet : LatticePalette.line, lineWidth: highlight ? 2 : 1))
        .accessibilityElement(children: .combine)
    }
}

// MARK: Gates after the join (child-join.md: notEntitled and updateRequired; the join states are ChildJoinView's)

private struct ApprovalGateView: View {
    @ObservedObject var model: ApprovalsModel

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "lock").font(.system(size: 34)).foregroundStyle(LatticePalette.muted)
            Text(verbatim: model.gate == .updateRequired ? ApprovalBoxWords.updateRequired : model.gate == .adding ? ApprovalBoxWords.adding : ApprovalBoxWords.notEntitled)
                .font(.system(size: 14.5)).foregroundStyle(LatticePalette.ink).multilineTextAlignment(.center).frame(maxWidth: 420)
            Button(model.gate == .updateRequired ? ApprovalBoxWords.retryNow : ApprovalBoxWords.checkAgain) { model.link.retryNow() }.buttonStyle(.bordered)
        }
        .padding(28).frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("approvals-gate")
    }
}
