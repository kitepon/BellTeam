import SwiftUI

/// 稼働中に数えない処理 (a64, settings-user-flow.md 4.8b): approved entries and proposals waiting in Approval Box; the Owner may remove an entry.
/// The list lives in SettingsHomeState so the home row and this page show one value. Adding is only through Approval Box.
struct RunningExclusionsPage: View {
    @EnvironmentObject private var store: AppStore
    @EnvironmentObject private var home: SettingsHomeState
    @State private var removing: String?
    @State private var confirming: RunningExclusionEntry?
    @State private var notice: String?

    var body: some View {
        SettingsCardPage(page: .exclusions) {
            if home.exclusions == .unreadable {
                SettingsMainButton(title: "読み直す", identifier: "exclusions-reload") { Task { await home.loadExclusions() } }
            }
        } content: {
            Text("ここにある処理が動いていても、メンバーを作業中に数えません。メンバーが出した提案を、あなたがApproval Boxで承認した時だけ載ります。")
                .font(BellTheme.detailFont).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let notice { SettingsBanner(message: notice) }
            switch home.exclusions {
            case nil: ProgressView()
            case .oldServer: plain("この本体では使えません。本体を「アップデート」で新しくすると使えます。")
            case .unreadable: plain("一覧を読めませんでした。通信を確かめて、もう一度読み込んでください。")
            case .listed(let list): content(list)
            }
        }
        .task { await home.loadExclusions() }
        .confirmationDialog("「\(confirming?.words ?? "")」を一覧から外しますか？", isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }),
                            titleVisibility: .visible, presenting: confirming) { entry in
            Button("一覧から外す", role: .destructive) { Task { await remove(entry) } }
        } message: { _ in
            Text("外すと、この処理が動いている間はまた作業中に数えます。")
        }
    }

    @ViewBuilder private func content(_ list: RunningExclusions) -> some View {
        if list.entries.isEmpty && list.pending.isEmpty {
            plain("いまは何もありません。メンバーの処理は、すべて作業中に数えます。")
        }
        if !list.entries.isEmpty {
            section("数えないもの")
            ForEach(list.entries) { entry in
                card(entry) {
                    line("対象", entry.scopeWords(name))
                    if let approvedAt = entry.approvedAt { line("承認", dateTime(approvedAt)) }
                    if let reason = entry.reason, !reason.isEmpty { line("理由", reason) }
                    if let from = entry.from { line("提案", name(from) ?? from) }
                    Button(removing == entry.id ? "外しています…" : "一覧から外す", role: .destructive) { confirming = entry }
                        .buttonStyle(.bordered)
                        .disabled(removing != nil)
                        .accessibilityIdentifier("exclusion-remove-\(entry.id)")
                }
            }
        }
        if !list.pending.isEmpty {
            section("あなたの答えを待っている提案")
            ForEach(list.pending) { item in
                let entry = item.shownEntry(in: list.entries)
                card(entry) {
                    Text(item.action == "add" ? "追加の提案" : "外す提案").font(BellTheme.secondaryFont.bold())
                    if item.action == "add" { line("対象", entry.scopeWords(name)) }
                    if let from = item.from { line("提案", name(from) ?? from) }
                    if let filedAt = item.filedAt { line("出した日時", dateTime(filedAt)) }
                    Text(item.approved == true ? "承認済み。一覧に空きができたら載ります。" : "Approval Boxで、あなたの答えを待っています。")
                        .font(BellTheme.secondaryFont).foregroundStyle(.secondary)
                }
            }
        }
    }

    private func name(_ id: String) -> String? { store.bots.first { $0.id == id }?.name }

    private func dateTime(_ value: String) -> String {
        BellDate.parse(value)?.formatted(.dateTime.month().day().hour().minute()) ?? value
    }

    private func plain(_ text: String) -> some View {
        Text(text).font(BellTheme.detailFont).foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading).padding(16).bellCard()
    }

    private func section(_ title: String) -> some View {
        Text(title).font(.headline).frame(maxWidth: .infinity, alignment: .leading).padding(.top, 4)
    }

    private func line(_ label: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(label).font(BellTheme.secondaryFont).foregroundStyle(.secondary).frame(width: 72, alignment: .leading)
            Text(value).font(BellTheme.detailFont).fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func card<Lines: View>(_ entry: RunningExclusionEntry, @ViewBuilder lines: () -> Lines) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Image(systemName: entry.isProcess ? "terminal" : "person.crop.circle").foregroundStyle(SettingsPage.exclusions.tint)
                Text(entry.words)
                    .font(entry.isProcess ? .system(.body, design: .monospaced).weight(.semibold) : .headline)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            lines()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16).bellCard()
    }

    private func remove(_ entry: RunningExclusionEntry) async {
        guard removing == nil else { return }
        removing = entry.id
        notice = nil
        do {
            try await store.api.delete("/api/running-exclusions/\(entry.id)")
        } catch let error where BellAPIError.isAuthenticationError(error) {
            store.requireLogin(for: error)
        } catch {
            notice = RunningExclusionsRead.removalFailure(error)
            store.api.diagnostics.report(error, path: "/api/running-exclusions", method: "DELETE", observation: .write)
        }
        removing = nil
        await home.loadExclusions()
    }
}
