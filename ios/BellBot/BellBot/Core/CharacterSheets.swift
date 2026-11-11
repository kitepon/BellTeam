import UIKit

// Member character sheets (docs/architecture/modules/apple/memory-and-sheets.md). Same contract as createCharacterSheetView in
// web/bot-read-views.js: GET /api/bots/:id/character-sheet -> {sheets:[{file, updatedAt, url}]}, then each image at `url` with the app's auth.

struct CharacterSheetListResponse: Decodable {
    struct Sheet: Decodable, Equatable {
        let file: String
        let updatedAt: String
        let url: String
    }
    let sheets: [Sheet]
}

enum CharacterSheetCaption {
    static let emptyNote = "まだ置かれていない。"
    static let note = "メンバーのプロジェクトの assets/character-sheet/ 直下にある画像です。メンバーが自分を描く時の正本で、アイコンとは別です。"

    /// 「file（2026/11/10 9:05:03）」: Web's `toLocaleString('ja-JP')`. A date that cannot be read leaves the file name alone.
    @MainActor
    static func text(file: String, updatedAt: String, timeZone: TimeZone = .current) -> String {
        guard let date = BellDate.parse(updatedAt) else { return file }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "ja_JP")
        formatter.timeZone = timeZone
        formatter.dateFormat = "yyyy/M/d H:mm:ss"
        return "\(file)（\(formatter.string(from: date))）"
    }

    static func failureLine(_ error: Error) -> String { "キャラクターシートを読めませんでした（\(error.localizedDescription)）" }
}

/// One open character-sheet screen of one member. Images load one after another, as Web; the first failure replaces the whole list with one line.
@MainActor
final class CharacterSheetModel: ObservableObject {
    struct Entry: Identifiable {
        let id: String
        let file: String
        let caption: String
        var image: UIImage?
    }
    enum Content {
        case loading
        case sheets([Entry])
        case unsupported
        case failed(String)
    }

    let botID: String
    private let api: BellAPI
    private let requireLogin: @MainActor (Error) -> Void
    @Published private(set) var content = Content.loading
    private var started = false

    init(botID: String, api: BellAPI, requireLogin: @escaping @MainActor (Error) -> Void) {
        self.botID = botID
        self.api = api
        self.requireLogin = requireLogin
    }

    func load() async {
        guard !started else { return }
        started = true
        do {
            let list: CharacterSheetListResponse = try await api.get(MemberToolRoutes.characterSheets(botID))
            var entries = list.sheets.map { Entry(id: $0.url, file: $0.file, caption: CharacterSheetCaption.text(file: $0.file, updatedAt: $0.updatedAt)) }
            content = .sheets(entries)
            for index in entries.indices {
                try Task.checkCancellation()
                let data = try await api.image(list.sheets[index].url)
                guard let image = UIImage(data: data) else { throw BellAPIError.invalidResponse }
                entries[index].image = image
                content = .sheets(entries)
            }
        } catch is CancellationError {
            started = false
        } catch let error where BellAPIError.isAuthenticationError(error) { requireLogin(error) }
        catch {
            if MemberToolError.isUnsupported(error) { content = .unsupported; return }
            content = .failed(CharacterSheetCaption.failureLine(error))
            api.diagnostics.report(error, path: MemberToolRoutes.characterSheets(":id"), method: "GET", observation: .read(error, retainedData: false))
        }
    }
}
