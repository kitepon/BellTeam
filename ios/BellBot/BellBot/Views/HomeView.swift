import SwiftUI

struct HomeView: View {
    @EnvironmentObject private var store: AppStore
    @State private var search = ""
    @State private var addingBot = false
    @State private var addingRoom = false

    private var bots: [Bot] {
        let filtered = store.bots.filter { search.isEmpty || $0.displayName.localizedCaseInsensitiveContains(search) }
        return filtered.enumerated().sorted {
            let left = BellDate.parse($0.element.recent?.at ?? "") ?? .distantPast
            let right = BellDate.parse($1.element.recent?.at ?? "") ?? .distantPast
            return left == right ? $0.offset < $1.offset : left > right
        }.map(\.element)
    }

    private var rooms: [Room] {
        store.rooms.filter { search.isEmpty || $0.name.localizedCaseInsensitiveContains(search) }
            .enumerated().sorted {
                let left = BellDate.parse($0.element.recent?.at ?? "") ?? .distantPast
                let right = BellDate.parse($1.element.recent?.at ?? "") ?? .distantPast
                return left == right ? $0.offset < $1.offset : left > right
            }.map(\.element)
    }

    var body: some View {
        NavigationStack(path: $store.chatPath) {
            ZStack {
                BellBackground()
                ScrollView {
                    VStack(alignment: .leading, spacing: 28) {
                        header
                        introduction
                        searchField
                        if !rooms.isEmpty { roomsSection }
                        botsSection
                        Text("あなたとチームの会話は、ここに集まります。")
                            .font(.footnote)
                            .foregroundStyle(BellTheme.muted)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 18)
                    }
                    .padding(.horizontal, 22)
                    .padding(.top, 18)
                    .padding(.bottom, 24)
                }
                .refreshable { await store.refreshFromView() }
            }
            .navigationDestination(for: ChatTarget.self) { target in
                ConversationView(target: target)
            }
            .toolbar(.hidden, for: .navigationBar)
            .sheet(isPresented: $addingBot) { BotEditor(initial: nil).environmentObject(store) }
            .sheet(isPresented: $addingRoom) { RoomEditor(initial: nil).environmentObject(store) }
        }
    }

    private var searchField: some View {
        HStack(spacing: 11) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(BellTheme.muted)
            TextField("メンバーとルームを探す", text: $search)
                .font(.system(size: 15))
                .textInputAutocapitalization(.never)
        }
        .padding(.horizontal, 17)
        .frame(height: 50)
        .bellCard()
    }

    private var header: some View {
        HStack {
            HStack(spacing: 10) {
                Image(systemName: "sparkle")
                    .font(.system(size: 18, weight: .bold))
                    .foregroundStyle(BellTheme.violet)
                    .frame(width: 36, height: 36)
                    .background(.white, in: RoundedRectangle(cornerRadius: 12))
                Text("BellTeam")
                    .font(.system(size: 23, weight: .bold, design: .rounded))
                    .tracking(-0.7)
                    .foregroundStyle(BellTheme.ink)
            }
            Spacer()
            Menu {
                Button("メンバーを追加", systemImage: "person.badge.plus") { addingBot = true }
                Button("ルームを作る", systemImage: "person.3.fill") { addingRoom = true }
            } label: {
                Image(systemName: "plus")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(BellTheme.violet)
                    .frame(width: 38, height: 38)
                    .background(.white, in: RoundedRectangle(cornerRadius: 12))
            }
            .accessibilityLabel("メンバーまたはルームを追加")
            AvatarView(name: store.owner?.name ?? "あなた", avatar: store.owner?.avatar ?? "", color: BellTheme.violet, size: 38)
        }
    }

    private var introduction: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("おかえりなさい、\(store.owner?.name ?? "あなた")")
                .font(.system(size: 31, weight: .bold, design: .rounded))
                .tracking(-1.1)
                .foregroundStyle(BellTheme.ink)
                .minimumScaleFactor(0.8)
                .lineLimit(2)
            Text("今日は誰と話しますか？")
                .font(.system(size: 16))
                .foregroundStyle(BellTheme.muted)
            HStack(spacing: 8) {
                Circle().fill(BellTheme.mint).frame(width: 8, height: 8)
                Text("\(store.bots.filter(\.online).count) 人がオンライン")
                Text("·")
                Text("\(store.rooms.count) ルーム")
            }
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(BellTheme.muted)
            .padding(.top, 5)
        }
    }

    private var roomsSection: some View {
        VStack(alignment: .leading, spacing: 15) {
            sectionTitle("ルーム", symbol: "person.3.sequence.fill")
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 13) {
                    ForEach(rooms) { room in
                        NavigationLink(value: ChatTarget.room(room.id)) {
                            RoomCard(room: room)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.vertical, 4)
                .padding(.horizontal, 1)
            }
            .contentMargins(.trailing, 22)
        }
    }

    private var botsSection: some View {
        VStack(alignment: .leading, spacing: 15) {
            sectionTitle("メンバー", symbol: "bubble.left.and.text.bubble.right.fill")
            if bots.isEmpty {
                ContentUnavailableView("メンバーが見つかりません", systemImage: "person.crop.circle.badge.questionmark")
                    .frame(maxWidth: .infinity)
                    .bellCard()
            } else {
                VStack(spacing: 10) {
                    ForEach(bots) { bot in
                        NavigationLink(value: ChatTarget.bot(bot.id)) {
                            BotRow(bot: bot)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }

    private func sectionTitle(_ title: String, symbol: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: symbol)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(BellTheme.violet)
            Text(title)
                .font(.system(size: 20, weight: .bold, design: .rounded))
                .foregroundStyle(BellTheme.ink)
            Spacer()
        }
    }
}

private struct RoomCard: View {
    let room: Room

    var body: some View {
        VStack(alignment: .leading, spacing: 15) {
            HStack {
                AvatarView(name: room.name, avatar: room.avatar, color: BellTheme.violet, size: 48, isRoom: true)
                Spacer()
                Image(systemName: "arrow.up.right")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(BellTheme.violet)
                    .frame(width: 30, height: 30)
                    .background(BellTheme.violetLight, in: Circle())
            }
            VStack(alignment: .leading, spacing: 6) {
                Text(room.name)
                    .font(.system(size: 17, weight: .bold, design: .rounded))
                    .foregroundStyle(BellTheme.ink)
                    .lineLimit(1)
                Text(room.recent?.preview ?? (room.purpose.isEmpty ? "チームで話す" : room.purpose))
                    .font(.system(size: 13))
                    .foregroundStyle(BellTheme.muted)
                    .lineLimit(2)
                    .frame(height: 34, alignment: .topLeading)
            }
            Text("\(room.memberIds.count)人のメンバー")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(BellTheme.violet)
        }
        .frame(width: 174, alignment: .leading)
        .padding(18)
        .bellCard()
    }
}

private struct BotRow: View {
    let bot: Bot

    var body: some View {
        HStack(spacing: 15) {
            AvatarView(name: bot.name, avatar: bot.avatar, color: BellTheme.accent(bot.color), size: 57)
                .overlay(alignment: .bottomTrailing) {
                    Circle()
                        .fill(bot.online ? BellTheme.mint : BellTheme.line)
                        .frame(width: 13, height: 13)
                        .overlay(Circle().strokeBorder(.white, lineWidth: 2))
                        .offset(x: 2, y: 2)
                }
            VStack(alignment: .leading, spacing: 5) {
                HStack {
                    Text(bot.displayName)
                        .font(.system(size: 17, weight: .semibold, design: .rounded))
                        .foregroundStyle(BellTheme.ink)
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    Text(BellDate.short(bot.recent?.at))
                        .font(.system(size: 12))
                        .foregroundStyle(BellTheme.muted)
                }
                Text(bot.recent?.kind == "peer" ? "他のメンバーと連絡しました" :
                     (bot.recent?.preview ?? (bot.position.isEmpty ? "話しかけてみましょう" : bot.position)))
                    .font(.system(size: 14))
                    .foregroundStyle(BellTheme.muted)
                    .lineLimit(1)
            }
            Image(systemName: "chevron.right")
                .font(.system(size: 11, weight: .bold))
                .foregroundStyle(BellTheme.line)
        }
        .padding(15)
        .bellCard()
    }
}
