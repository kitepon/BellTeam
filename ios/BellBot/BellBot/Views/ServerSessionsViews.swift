import SwiftUI
import UIKit

enum ServerLoginWords {
    static func kind(_ kind: String) -> String {
        switch kind {
        case "web": "Web"
        case "apple": String(localized: "iPhone・iPad・Mac")
        case "windows": "Windows"
        case "linux": "Linux"
        case "android": "Android"
        default: kind
        }
    }

    static func network(_ networkClass: String) -> String { networkClass == "lan" ? String(localized: "同じネットワークから") : String(localized: "ネットワークは確認できません") }

    static func origin(_ origin: String) -> String {
        switch origin {
        case "phone": String(localized: "スマホで承認")
        case "console": String(localized: "サーバーのコンソールのコード")
        case "added": String(localized: "「アプリを追加」のコード")
        default: origin
        }
    }

    static let consoleTitle = String(localized: "サーバーのコンソールのコード")
    static let sectionTitle = String(localized: "このサーバーに入っている端末")

    /// 一覧の上の一行。台数は自分の行も数える。
    static func summary(_ count: Int) -> String { count == 1 ? String(localized: "この端末だけが入っています") : String(localized: "\(count)台が入っています") }

    static let addAppNote = String(localized: "この画面のコードは1回だけ使えて、10分で切れます。購読していない人は、このコードでブラウザー版に入れます。このコードで入ったものは、このアプリが終わると一緒に終わります。")

    static func date(_ text: String?) -> String? {
        guard let text else { return nil }
        let fractional = ISO8601DateFormatter(), plain = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return (fractional.date(from: text) ?? plain.date(from: text)).map { $0.formatted(date: .abbreviated, time: .shortened) }
    }
}

/// 承認待ちのログイン（別のアプリが入りたがっている）。2つ目の手：自分で始めたログインだけ許可する。
struct LoginRequestsList: View {
    @ObservedObject var model: ServerSessionsModel

    var body: some View {
        ForEach(model.requests) { request in
            VStack(alignment: .leading, spacing: 8) {
                Text("\(ServerLoginWords.kind(request.kind))が入ろうとしています").font(.headline)
                Text("\(ServerLoginWords.network(request.networkClass))・\(ServerLoginWords.date(request.requestedAt) ?? "")")
                    .font(.footnote).foregroundStyle(BellTheme.muted)
                Text("自分で始めたログインだけ許可してください。").font(.footnote)
                HStack {
                    Button("許可") { Task { await model.approve(request) } }
                        .buttonStyle(.borderedProminent).accessibilityIdentifier("login-request-approve")
                    Button("拒否", role: .destructive) { Task { await model.deny(request) } }
                        .buttonStyle(.bordered).accessibilityIdentifier("login-request-deny")
                }
                .disabled(model.busy)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// どの画面にいても承認待ちが目に入るように、準備ができた画面の上に出す。
struct LoginRequestBanner: View {
    @EnvironmentObject private var store: AppStore

    var body: some View {
        if store.usesServerSessions, !store.serverSessions.requests.isEmpty {
            VStack(alignment: .leading, spacing: 8) { LoginRequestsList(model: store.serverSessions) }
                .padding(14).bellCard().padding(.horizontal, 12).padding(.top, 4)
                .accessibilityIdentifier("login-request-banner")
        }
    }
}

/// 設定の「接続」に置く: アプリを追加・入っているアプリの一覧と取消。
struct ServerSessionsSection: View {
    @EnvironmentObject private var store: AppStore
    @ObservedObject var model: ServerSessionsModel
    @State private var addingApp = false

    var body: some View {
        Group {
            if !model.requests.isEmpty { Section("承認待ち") { LoginRequestsList(model: model) } }
            Section {
                Button("アプリを追加", systemImage: "plus.app") { addingApp = true }
                    .accessibilityIdentifier("sessions-add-app")
            }
            Section {
                DeviceSummaryLine(count: model.sessions.count)
                ForEach(model.sessions) { entry in
                    DeviceRowView(info: DeviceRowInfo(entry), busy: model.busy, onEnd: { Task { if entry.current { await store.signOut() } else { await model.revoke(entry) } } })
                }
            } header: { Text(ServerLoginWords.sectionTitle) }
            if let error = model.errorText { Section { Text(error).font(.footnote).foregroundStyle(.red) } }
        }
        .task { await model.refresh() }
        .sheet(isPresented: $addingApp, onDismiss: { model.discardCode() }) { AddAppView(model: model) }
    }
}

/// 「アプリを追加」: 新しいアプリの「サーバーのコードで入る」に入れる1回限りのコードを出す（app-sessions.md 2a'）。
struct AddAppView: View {
    @ObservedObject var model: ServerSessionsModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 18) {
                if let issued = model.issued {
                    Text(issued.code).font(.system(.largeTitle, design: .monospaced).bold()).textSelection(.enabled)
                        .accessibilityIdentifier("add-app-code")
                    if let until = ServerLoginWords.date(issued.expiresAt) { Text("\(until)まで有効").font(.footnote).foregroundStyle(BellTheme.muted) }
                } else {
                    Button { Task { await model.issueCode() } } label: { Text(model.busy ? "作っています…" : "コードを出す").frame(maxWidth: .infinity) }
                        .buttonStyle(.bellPrimary).controlSize(.large).disabled(model.busy)
                        .accessibilityIdentifier("add-app-issue")
                }
                Text(ServerLoginWords.addAppNote).font(.subheadline).foregroundStyle(BellTheme.muted)
                    .accessibilityIdentifier("add-app-note")
                if let error = model.errorText { Text(error).font(.footnote).foregroundStyle(.red) }
                Spacer()
            }
            .padding(24)
            .navigationTitle("アプリを追加")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("閉じる") { dismiss() } } }
        }
    }
}


/// 一覧の1行分の表示（旧ログインの行もホームの行も同じ見た目にする）。
struct DeviceRowInfo: Identifiable, Equatable {
    enum Icon: Equatable { case phone, tablet, laptop, desktop, web, console }
    let id: String
    let title: String
    let icon: Icon
    let current: Bool
    let originLine: String?
    let times: String

    /// 種類ごとの一般の端末の字形（ブランドの印は使わない）。自分の行だけiPad・Macを区別できる（ライブラリは区別しない）。
    static func icon(kind: String, current: Bool) -> Icon {
        switch kind {
        case "apple":
            guard current else { return .phone }
            #if targetEnvironment(macCatalyst)
            return .laptop
            #else
            return UIDevice.current.userInterfaceIdiom == .pad ? .tablet : .phone
            #endif
        case "android": return .phone
        case "windows", "linux": return .desktop
        case "web": return .web
        default: return .desktop
        }
    }

    private static func times(created: String?, lastUse: String?) -> String {
        let createdText = ServerLoginWords.date(created) ?? ""
        guard let usedText = ServerLoginWords.date(lastUse) else { return String(localized: "入った日時 \(createdText)") }
        return String(localized: "入った日時 \(createdText)・最後に使った日時 \(usedText)")
    }

    init(_ entry: ServerLoginClient.SessionEntry) {
        let console = entry.origin == "console"
        id = entry.id
        title = console ? ServerLoginWords.consoleTitle : ServerLoginWords.kind(entry.kind)
        icon = console ? .console : Self.icon(kind: entry.kind, current: entry.current)
        current = entry.current
        originLine = String(localized: "\(ServerLoginWords.origin(entry.origin))・\(ServerLoginWords.network(entry.networkClass))")
        times = Self.times(created: entry.createdAt, lastUse: entry.lastUsedAt)
    }

    /// ホームの一覧には入り方・ネットワークが無いので、1行目は作らない。
    init(_ row: HomeSessionRow) {
        let console = row.kind == "console"
        id = row.id
        title = console ? ServerLoginWords.consoleTitle : ServerLoginWords.kind(row.appKind ?? "")
        icon = console ? .console : Self.icon(kind: row.appKind ?? "", current: row.current)
        current = row.current
        originLine = nil
        times = Self.times(created: row.created, lastUse: row.lastUse)
    }
}

private extension DeviceRowInfo.Icon {
    var symbol: String {
        switch self {
        case .phone: "iphone"
        case .tablet: "ipad"
        case .laptop: "laptopcomputer"
        case .desktop: "desktopcomputer"
        case .web: "globe"
        case .console: "terminal"
        }
    }
}

struct DeviceSummaryLine: View {
    let count: Int
    var body: some View {
        Text(ServerLoginWords.summary(count)).font(.footnote).foregroundStyle(BellTheme.muted)
            .accessibilityIdentifier("sessions-summary")
    }
}

/// 端末の1行: 字形のタイル、種類名と「このアプリ」、入った日時、ボタン。ボタンはどれも破壊的で、囲み線つき。
struct DeviceRowView: View {
    let info: DeviceRowInfo
    let busy: Bool
    let onEnd: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: info.icon.symbol).font(.system(size: 16)).foregroundStyle(BellTheme.muted)
                .frame(width: 32, height: 32).background(Color(.secondarySystemFill), in: RoundedRectangle(cornerRadius: 8))
                .accessibilityLabel(info.title)
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(info.title).font(.headline)
                    if info.current { BellBadge(text: String(localized: "このアプリ"), tone: .violet) }
                }
                if let line = info.originLine { Text(line).font(.footnote).foregroundStyle(BellTheme.muted) }
                Text(info.times).font(.footnote).foregroundStyle(BellTheme.muted)
                HStack {
                    Button(info.current ? "ログアウト" : "ログアウトさせる", role: .destructive, action: onEnd)
                        .accessibilityIdentifier("session-revoke-\(info.id)")
                }
                .buttonStyle(.bordered).disabled(busy)
            }
        }
    }
}

/// 設定の「接続」: ホームサーバーに入っている端末の一覧（a529a）。ホームの端末ログインがある時だけ出す。
struct HomeSessionsSection: View {
    @EnvironmentObject private var store: AppStore
    @ObservedObject var model: HomeSessionsModel

    var body: some View {
        Group {
            Section {
                DeviceSummaryLine(count: model.rows.count)
                ForEach(model.rows) { row in
                    DeviceRowView(info: DeviceRowInfo(row), busy: model.busy,
                                  onEnd: { Task { if row.current { await store.signOut() } else { await model.end(row) } } })
                }
            } header: { Text(ServerLoginWords.sectionTitle) }
            Section {
                if let error = model.errorText { Text(error).font(.footnote).foregroundStyle(.red) }
                Button("読み直す", systemImage: "arrow.clockwise") { Task { await model.refresh() } }
                    .disabled(model.busy).accessibilityIdentifier("sessions-reload")
            }
        }
        .task { await model.refresh() }
    }
}
