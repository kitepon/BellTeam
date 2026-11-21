import SwiftUI

enum ServerLoginWords {
    static func kind(_ kind: String) -> String {
        switch kind {
        case "web": "Web"
        case "apple": "iPhone・iPad・Mac"
        case "windows": "Windows"
        case "linux": "Linux"
        case "android": "Android"
        default: kind
        }
    }

    static func network(_ networkClass: String) -> String { networkClass == "lan" ? "同じネットワークから" : "ネットワークは確認できません" }

    static func origin(_ origin: String) -> String {
        switch origin {
        case "phone": "スマホで承認"
        case "console": "サーバーのコンソールのコード"
        case "added": "「アプリを追加」のコード"
        default: origin
        }
    }

    static let addAppNote = "この画面のコードは1回だけ使えて、10分で切れます。購読していない人は、このコードでブラウザー版に入れます。このコードで入ったものは、このアプリが終わると一緒に終わります。"

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
            Section("このサーバーに入っているアプリ") {
                ForEach(model.sessions) { entry in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text(ServerLoginWords.kind(entry.kind)).font(.headline)
                            if entry.current { BellBadge(text: "このアプリ", tone: .violet) }
                        }
                        Text("\(ServerLoginWords.origin(entry.origin))・\(ServerLoginWords.network(entry.networkClass))").font(.footnote).foregroundStyle(BellTheme.muted)
                        Text("入った日時 \(ServerLoginWords.date(entry.createdAt) ?? "")" + (ServerLoginWords.date(entry.lastUsedAt).map { "・最後に使った日時 \($0)" } ?? ""))
                            .font(.footnote).foregroundStyle(BellTheme.muted)
                        Button(entry.current ? "ログアウト" : "取り消す", role: .destructive) {
                            Task { if entry.current { await store.signOut() } else { await model.revoke(entry) } }
                        }
                        .buttonStyle(.bordered).disabled(model.busy)
                        .accessibilityIdentifier("session-revoke-\(entry.id)")
                    }
                }
            }
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
