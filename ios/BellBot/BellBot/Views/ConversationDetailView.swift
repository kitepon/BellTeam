import SwiftUI
import UIKit

struct ConversationDetailView: View {
    let target: ChatTarget
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var errorText: String?
    @State private var editingProfile = false
    @State private var showingScreen = false
    @StateObject private var images = BotProfileImageState()

    private var bot: Bot? { store.bots.first { $0.id == target.id } }
    private var room: Room? { store.rooms.first { $0.id == target.id } }

    var body: some View {
        NavigationStack {
            ZStack {
                BellBackground()
                ScrollView {
                    VStack(spacing: 18) {
                        if let bot {
                            BotProfileHero(bot: bot, smallSize: UIDevice.current.userInterfaceIdiom == .phone ? 88 : 176,
                                           images: images)
                        } else if let room {
                            AvatarView(name: room.name, avatar: room.avatar, color: BellTheme.violet,
                                       size: 88, isRoom: true)
                            Text(room.name)
                                .font(.system(size: 27, weight: .bold, design: .rounded))
                                .foregroundStyle(BellTheme.ink)
                        }
                        if let room {
                            SelectableText(room.purpose, color: BellTheme.muted)
                            ForEach(room.memberIds, id: \.self) { id in
                                Text(store.bots.first(where: { $0.id == id })?.displayName ?? id)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(15)
                                    .bellCard()
                            }
                            Button("ルームを編集") { editingProfile = true }
                                .buttonStyle(.borderedProminent)
                        } else if let bot {
                            BotProfileAISection(bot: bot, errorText: errorText,
                                                onScreen: { showingScreen = true }, onRestart: {
                                Task {
                                    do {
                                        try await store.restartConversation(target: target)
                                        dismiss()
                                    } catch { errorText = error.localizedDescription }
                                }
                            })
                            BotProfileDetails(bot: bot)
                            Button("メンバーを編集") { editingProfile = true }
                                .buttonStyle(.borderedProminent)
                        }
                    }
                    .padding(25)
                }
            }
            .navigationTitle("詳細")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("閉じる") { dismiss() } } }
            .sheet(isPresented: $editingProfile) {
                Group {
                    if let room { RoomEditor(initial: room).environmentObject(store) }
                    else if let bot { BotEditor(initial: bot).environmentObject(store) }
                }
                .bellEditorSheet()
            }
            .sheet(isPresented: $showingScreen) {
                if let bot { BotScreenView(bot: bot).environmentObject(store) }
            }
            .botProfileImageActions(bot: bot, images: images)
            .onChange(of: room?.id) { _, id in
                if target.isRoom && id == nil { dismiss() }
            }
            .onChange(of: bot?.id) { _, id in
                if !target.isRoom && id == nil { dismiss() }
            }
        }
    }
}
