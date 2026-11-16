import SwiftUI

/// 発言の転送（conversation forward.md）。転送先（Bot、続けて部屋）とコメントを選び、`forward`に識別子だけを付けて送る。
/// 本文はサーバーが元の発言から組むので、ここは「どの発言か」しか送らない。
struct ForwardSheet: View {
    let message: TimelineMessage
    let source: ChatTarget
    let senderName: String

    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var pick: ChatTarget?
    @State private var comment = ""
    @State private var members: Set<String> = []
    @State private var sending = false
    @State private var errorText: String?
    @State private var sentName: String?

    struct Destination: Identifiable {
        let target: ChatTarget
        let name: String
        let avatar: String
        let color: String
        var id: ChatTarget { target }
    }

    private var destinations: [Destination] {
        let word = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let all = store.bots.filter { $0.deleting != true }.map {
            Destination(target: .bot($0.id), name: $0.displayName, avatar: $0.avatar, color: $0.color)
        } + store.rooms.map { Destination(target: .room($0.id), name: $0.name, avatar: $0.avatar, color: "violet") }
        return word.isEmpty ? all : all.filter { $0.name.lowercased().contains(word) }
    }

    /// 返信者の自動選択が無い部屋では、返信してほしいメンバーを選ばせる（会話の送信と同じ規則）。
    private var roomMembers: [Bot] {
        guard case .room(let id)? = pick, !store.routingEnabled, let room = store.rooms.first(where: { $0.id == id }) else { return [] }
        return room.memberIds.compactMap { member in store.bots.first { $0.id == member } }
    }

    private var ready: Bool {
        guard pick != nil, !sending else { return false }
        return roomMembers.isEmpty || !members.isEmpty
    }

    var body: some View {
        NavigationStack {
            Group {
                if let sentName { sent(sentName) } else { form }
            }
            .background(BellBackground())
            .navigationTitle("転送")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("閉じる") { dismiss() } }
            }
        }
        .presentationDetents([.large])
    }

    private var form: some View {
        Form {
            Section("転送する発言") {
                VStack(alignment: .leading, spacing: 4) {
                    Text(senderName).font(.footnote.weight(.bold)).foregroundStyle(BellTheme.muted)
                    Text(preview).font(BellTheme.messageHelperFont).lineLimit(3)
                }
                .accessibilityIdentifier("forward-preview")
            }
            Section("転送先") {
                if destinations.count > 8 || !query.isEmpty {
                    TextField("名前で探す", text: $query).accessibilityIdentifier("forward-search")
                }
                ForEach(destinations) { entry in
                    Button {
                        pick = entry.target
                        members = []
                    } label: {
                        HStack(spacing: 10) {
                            AvatarView(name: entry.name, avatar: entry.avatar, color: BellTheme.accent(entry.color),
                                       size: 32, isRoom: entry.target.isRoom)
                            Text(entry.name)
                            if entry.target.isRoom { Text("部屋").font(.caption).foregroundStyle(BellTheme.muted) }
                            Spacer()
                            if pick == entry.target { Image(systemName: "checkmark.circle.fill").foregroundStyle(BellTheme.violet) }
                        }
                    }
                    .foregroundStyle(BellTheme.ink)
                    .accessibilityAddTraits(pick == entry.target ? .isSelected : [])
                    .accessibilityIdentifier("forward-dest-\(entry.target.id)")
                }
                if destinations.isEmpty { Text("見つかりません。").foregroundStyle(BellTheme.muted) }
            }
            if !roomMembers.isEmpty {
                Section("返信してほしいメンバー") {
                    Text("この部屋は返信者の自動選択がありません。返信してほしいメンバーを選んでください。")
                        .font(.footnote).foregroundStyle(BellTheme.muted)
                    ForEach(roomMembers) { member in
                        Button {
                            if members.contains(member.id) { members.remove(member.id) } else { members.insert(member.id) }
                        } label: {
                            HStack {
                                Text(member.displayName)
                                Spacer()
                                if members.contains(member.id) { Image(systemName: "checkmark") }
                            }
                        }
                        .foregroundStyle(BellTheme.ink)
                    }
                }
            }
            Section("コメント（なくても送れます）") {
                TextField("この発言についての依頼や一言", text: $comment, axis: .vertical)
                    .lineLimit(3...6)
                    .accessibilityIdentifier("forward-comment")
            }
            if let errorText {
                Text(errorText).foregroundStyle(.red).font(.footnote).accessibilityIdentifier("forward-error")
            }
            Section {
                Button(sending ? "送っています…" : "転送する") { Task { await send() } }
                    .disabled(!ready)
                    .accessibilityIdentifier("forward-send")
            }
        }
        .scrollContentBackground(.hidden)
    }

    private func sent(_ name: String) -> some View {
        VStack(spacing: 16) {
            Text("転送しました（\(name)）。").font(.headline).accessibilityIdentifier("forward-done")
            Button("閉じる") { dismiss() }.buttonStyle(.bellPrimary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var preview: String {
        let text = (message.message ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? "（画像）" : text
    }

    private func send() async {
        guard let pick, ready else { return }
        sending = true
        errorText = nil
        defer { sending = false }
        let body = SendMessageBody(
            message: comment.trimmingCharacters(in: .whitespacesAndNewlines), images: [],
            targets: pick.isRoom && !roomMembers.isEmpty ? Array(members) : nil,
            forward: ForwardBody(source: .init(kind: source.isRoom ? "room" : "bot", id: source.id), messageID: message.id))
        do {
            try await store.authorizeAIUse(target: pick)
            _ = try await store.api.sendMessage(pick.path + "/messages", body: body)
            sentName = destinations.first { $0.target == pick }?.name ?? "転送先"
        } catch let error where BellAPIError.isAuthenticationError(error) {
            store.requireLogin(for: error)
        } catch {
            errorText = ForwardSheet.failureMessage(error)
            store.api.diagnostics.report(error, path: pick.path + "/messages", method: "POST", observation: .write)
        }
    }

    /// 失敗を言葉で。サーバーの文言は出さない（web/forward-dialog.js と同じ）。
    static func failureMessage(_ error: Error) -> String {
        if case .httpStatus(let status, _, _)? = error as? BellAPIError {
            switch status {
            case 404: return "転送する発言が見つかりません。会話を読み直してから、もう一度お試しください。"
            case 415: return "画像やファイルを含む発言は、まだ転送できません。"
            case 400: return "転送できませんでした。内容を確かめてください。"
            default: break
            }
        }
        return "転送できませんでした。少し待って、もう一度お試しください。\n\(BellAPIError.operationFailureMessage(error))"
    }
}
