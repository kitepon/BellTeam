import SwiftUI

struct BotProfileHero: View {
    let bot: Bot
    let smallSize: CGFloat
    @EnvironmentObject private var store: AppStore
    @State private var loadedLargeAvatar: String?
    @State private var largeAvatarError = false
    @State private var imageAction: AvatarCropVariant?
    @State private var savingImage = false
    @State private var imageSaveError: String?
    @State private var imageSaveMessage: String?
    @State private var pendingImage: PendingAvatarSave?

    private struct PendingAvatarSave {
        let variant: AvatarCropVariant
        let selection: AvatarCropSelection
    }

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
                    Button { openImageActions(.large) } label: {
                        Group {
                            if let backgroundImage {
                                Image(uiImage: backgroundImage).resizable().scaledToFill()
                            } else {
                                LinearGradient(colors: [BellTheme.accent(bot.color).opacity(0.75), BellTheme.accent(bot.color)],
                                               startPoint: .topLeading, endPoint: .bottomTrailing)
                            }
                        }
                        .frame(width: area.size.width, height: area.size.height)
                        .clipped()
                    }
                    .buttonStyle(.plain)
                    .contentShape(Rectangle())
                    .accessibilityLabel("大画像の操作")
                    .accessibilityIdentifier("profile-large-avatar")
                    .disabled(savingImage)
                    Button { openImageActions(.small) } label: {
                        AvatarView(name: bot.name, avatar: bot.avatar,
                                   color: BellTheme.accent(bot.color), size: smallSize)
                        .overlay(RoundedRectangle(cornerRadius: smallSize * 0.31)
                            .strokeBorder(.white, lineWidth: 2))
                    }
                    .buttonStyle(.plain)
                    .padding(16)
                    .zIndex(1)
                    .accessibilityLabel("小画像の操作")
                    .accessibilityIdentifier("profile-small-avatar")
                    .disabled(savingImage)
                }
                .frame(width: area.size.width, height: area.size.height)
                .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
            }
            .aspectRatio(1, contentMode: .fit)
            if largeAvatarError {
                Text("大画像を読み込めませんでした。")
                    .font(.footnote).foregroundStyle(.red)
            }
            if savingImage { ProgressView("画像を保存しています…") }
            if let imageSaveMessage { Text(imageSaveMessage).font(.footnote).foregroundStyle(BellTheme.mint) }
            if let imageSaveError { Text(imageSaveError).font(.footnote).foregroundStyle(.red) }
            if pendingImage != nil {
                Button("保存結果を確認") { Task { await confirmImageSave() } }
                    .disabled(savingImage)
            }
            Text(bot.displayName)
                .font(BellTheme.profileTitleFont.bold())
                .foregroundStyle(BellTheme.ink)
            Label(bot.online ? "オンライン" : "オフライン", systemImage: "circle.fill")
                .font(BellTheme.secondaryFont)
                .foregroundStyle(bot.online ? BellTheme.mint : BellTheme.muted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .sheet(item: $imageAction) { variant in
            BotProfileAvatarActions(bot: bot, variant: variant) { selection, current in
                Task { await saveImage(selection, current: current, variant: variant) }
            }
            .environmentObject(store)
        }
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

    private func openImageActions(_ variant: AvatarCropVariant) {
        imageSaveError = nil
        imageSaveMessage = nil
        pendingImage = nil
        imageAction = variant
    }

    private func saveImage(_ selection: AvatarCropSelection, current: BotSettings,
                           variant: AvatarCropVariant) async {
        savingImage = true
        defer { savingImage = false }
        let path = "/api/bots/\(bot.id)"
        do {
            let result = try await store.api.saveBotAvatarSelection(id: bot.id, current: current,
                                                                     variant: variant, selection: selection)
            switch result {
            case .saved, .confirmed:
                pendingImage = nil
                imageSaveError = nil
                do {
                    try await store.refresh()
                    imageSaveMessage = "画像を保存しました。"
                } catch {
                    imageSaveError = "画像を保存しましたが、表示を更新できませんでした。\n\(error.localizedDescription)"
                }
            case .different:
                imageSaveError = "サーバーの画像は選んだ内容と一致しません。もう一度画像を確認してください。"
            case .unconfirmed(let error):
                pendingImage = PendingAvatarSave(variant: variant, selection: selection)
                imageSaveError = "保存結果を確認できませんでした。入力は保持しています。\n\(error.localizedDescription)"
            }
        } catch let error where BellAPIError.isAuthenticationError(error) { store.requireLogin(for: error) }
        catch {
            imageSaveError = BellAPIError.operationFailureMessage(error)
            store.api.diagnostics.report(error, path: path, method: "PATCH", observation: .write)
        }
    }

    private func confirmImageSave() async {
        guard let pendingImage else { return }
        savingImage = true
        defer { savingImage = false }
        do {
            let result = try await store.api.confirmBotAvatarSelection(id: bot.id,
                variant: pendingImage.variant, selection: pendingImage.selection)
            switch result {
            case .saved, .confirmed:
                self.pendingImage = nil
                imageSaveError = nil
                try await store.refresh()
                imageSaveMessage = "画像の保存を確認しました。"
            case .different:
                self.pendingImage = nil
                imageSaveError = "サーバーの画像は選んだ内容と一致しません。もう一度画像を確認してください。"
            case .unconfirmed(let error):
                imageSaveError = "保存結果を確認できませんでした。入力は保持しています。\n\(error.localizedDescription)"
            }
        } catch let error where BellAPIError.isAuthenticationError(error) { store.requireLogin(for: error) }
        catch { imageSaveError = "保存結果を確認できませんでした。\n\(error.localizedDescription)" }
    }
}

private struct BotProfileAvatarActions: View {
    let bot: Bot
    let variant: AvatarCropVariant
    let onUse: (AvatarCropSelection, BotSettings) -> Void
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var settings: BotSettings?
    @State private var loading = false
    @State private var errorText: String?
    @State private var cropSource: AvatarCropSource?

    var body: some View {
        Group {
            if let cropSource, let settings {
                AvatarCropEditor(image: cropSource.image, variant: variant,
                                 initialCrop: cropSource.initialCrop) { selection in
                    onUse(selection, settings)
                }
            } else {
                NavigationStack {
                    VStack(spacing: 20) {
                        if loading { ProgressView("画像情報を確認しています…") }
                        if let settings {
                            AvatarImagePicker(onSelect: { cropSource = AvatarCropSource(image: $0, variant: variant) },
                                              onFailure: { errorText = "画像を読み込めませんでした。" }) {
                                Text("画像変更").frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.borderedProminent)
                            .accessibilityIdentifier("profile-image-change")
                            Button("画像調整") { adjust(settings) }
                                .buttonStyle(.bordered)
                                .frame(maxWidth: .infinity)
                                .accessibilityIdentifier("profile-image-adjust")
                            if adjustmentImage(settings).source.isEmpty {
                                Text("元画像が残っていない場合、現在の切り抜きの外側は復元できません。")
                                    .font(.footnote).foregroundStyle(BellTheme.muted)
                            }
                        } else if !loading {
                            Button("画像情報を再読込") { Task { await loadSettings() } }
                        }
                        if let errorText { Text(errorText).font(.footnote).foregroundStyle(.red) }
                    }
                    .frame(maxWidth: 340)
                    .padding(24)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(BellBackground())
                    .navigationTitle(variant == .small ? "小画像" : "大画像")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .topBarLeading) {
                            Button("閉じる") { dismiss() }.accessibilityIdentifier("profile-image-close")
                        }
                    }
                }
            }
        }
        .task(id: bot.id) { await loadSettings() }
    }

    private func loadSettings() async {
        guard !loading else { return }
        loading = true
        defer { loading = false }
        let path = "/api/bots/\(bot.id)"
        do {
            let response: BotProfileResponse = try await store.api.get(path)
            try Task.checkCancellation()
            guard response.bot.avatarLarge != nil && response.bot.avatarSource != nil
                    && response.bot.avatarLargeSource != nil else {
                errorText = "画像の独立編集はサーバー更新後に利用できます。"
                return
            }
            settings = response.bot
            errorText = nil
        } catch is CancellationError { return }
        catch let error where BellAPIError.isAuthenticationError(error) { store.requireLogin(for: error) }
        catch {
            errorText = "画像情報を読み込めませんでした。\n\(error.localizedDescription)"
            store.api.diagnostics.report(error, path: path, method: "GET",
                                         observation: .read(error, retainedData: false))
        }
    }

    private func adjust(_ settings: BotSettings) {
        let current = adjustmentImage(settings)
        guard let image = AvatarPortraitCache.image(for: current.source.isEmpty ? current.render : current.source) else {
            errorText = "画像を読み込めませんでした。"
            return
        }
        cropSource = AvatarCropSource(image: image, variant: variant,
                                      initialCrop: current.source.isEmpty ? nil : current.crop)
    }

    private func adjustmentImage(_ settings: BotSettings) -> (render: String, source: String, crop: AvatarCropRect?) {
        if variant == .small {
            return (settings.avatar, settings.avatarSource ?? "", settings.avatarCrop)
        }
        if let large = settings.avatarLarge, !large.isEmpty {
            return (large, settings.avatarLargeSource ?? "", settings.avatarLargeCrop)
        }
        return (settings.avatar, settings.avatarSource ?? "", settings.avatarCrop)
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
