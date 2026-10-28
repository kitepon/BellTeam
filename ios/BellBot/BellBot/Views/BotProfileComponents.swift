import SwiftUI

struct BotProfileHero: View {
    let bot: Bot
    let smallSize: CGFloat
    @EnvironmentObject private var store: AppStore
    @State private var loadedLargeAvatar: String?
    @State private var largeAvatarError = false

    private var usesSmallImage: Bool {
        bot.avatarLargeVersion == nil || bot.avatarLargeVersion == bot.avatarVersion || bot.avatarLargeVersion == ""
    }
    private var backgroundImage: UIImage? {
        AvatarPortraitCache.image(for: usesSmallImage ? bot.avatar : loadedLargeAvatar ?? "")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            GeometryReader { area in
                ZStack(alignment: .topLeading) {
                    if let backgroundImage {
                        Image(uiImage: backgroundImage)
                            .resizable()
                            .scaledToFill()
                            .frame(width: area.size.width, height: area.size.height)
                            .clipped()
                    } else {
                        LinearGradient(colors: [BellTheme.accent(bot.color).opacity(0.75), BellTheme.accent(bot.color)],
                                       startPoint: .topLeading, endPoint: .bottomTrailing)
                    }
                    AvatarView(name: bot.name, avatar: bot.avatar, color: BellTheme.accent(bot.color), size: smallSize)
                        .overlay(RoundedRectangle(cornerRadius: smallSize * 0.31)
                            .strokeBorder(.white, lineWidth: 2))
                        .padding(16)
                }
                .frame(width: area.size.width, height: area.size.height)
                .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
            }
            .frame(height: 220)
            if largeAvatarError {
                Text("大画像を読み込めませんでした。")
                    .font(.footnote).foregroundStyle(.red)
            }
            Text(bot.displayName)
                .font(BellTheme.profileTitleFont.bold())
                .foregroundStyle(BellTheme.ink)
            Label(bot.online ? "オンライン" : "オフライン", systemImage: "circle.fill")
                .font(BellTheme.secondaryFont)
                .foregroundStyle(bot.online ? BellTheme.mint : BellTheme.muted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .task(id: "\(bot.id):\(bot.avatarLargeVersion ?? "")") {
            loadedLargeAvatar = nil
            largeAvatarError = false
            guard !usesSmallImage, let version = bot.avatarLargeVersion else { return }
            let path = "/api/bots/\(bot.id)/avatar-large"
            do {
                let image = try await store.api.avatar(path + "?v=" + version)
                try Task.checkCancellation()
                loadedLargeAvatar = image
            } catch is CancellationError { return }
            catch let error where BellAPIError.isAuthenticationError(error) { store.requireLogin(for: error) }
            catch {
                largeAvatarError = true
                store.api.diagnostics.report(error, path: path, method: "GET", observation: .read(error, retainedData: false))
            }
        }
    }
}

struct BotProfileAISection: View {
    let bot: Bot
    let errorText: String?
    let onScreen: () -> Void
    let onRestart: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("AIと操作").font(BellTheme.secondaryFont.weight(.bold))
                .foregroundStyle(BellTheme.muted)
            LabeledContent("ハーネス", value: bot.harness)
            LabeledContent("希望モデル", value: bot.model.isEmpty ? "CLIの既定" : bot.model)
            LabeledContent("希望エフォート", value: bot.reasoningEffort.isEmpty ? "CLIの既定" : bot.reasoningEffort)
            Button("Botの画面を見る", systemImage: "terminal", action: onScreen)
                .buttonStyle(.bordered)
            Button("会話セッションを再起動", action: onRestart)
                .buttonStyle(.bordered)
            if let errorText { Text(errorText).font(.footnote).foregroundStyle(.red) }
        }
        .font(BellTheme.secondaryFont)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .bellCard()
    }
}

struct BotProfileDetails: View {
    let bot: Bot

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            detail("役職", value: bot.position)
            detail("背景・見た目・関係性", value: bot.profileText)
            detail("性格・考え方", value: bot.personality)
            detail("口調", value: bot.speechStyle)
            detail("担当する仕事", value: bot.role)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func detail(_ title: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(BellTheme.secondaryFont.weight(.bold)).foregroundStyle(BellTheme.muted)
            SelectableText(value.isEmpty ? "未設定" : value, font: BellTheme.profileBodyFont,
                           color: value.isEmpty ? BellTheme.muted : BellTheme.ink)
        }
    }
}
