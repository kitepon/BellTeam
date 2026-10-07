#if DEBUG
import SwiftUI

extension AppStore {
    func preparePreview() {
        let arguments = ProcessInfo.processInfo.arguments
        api.baseURL = nil
        if let index = arguments.firstIndex(of: "-bellbot-preview-server"), arguments.indices.contains(index + 1) {
            api.baseURL = URL(string: arguments[index + 1])
        }
        api.diagnostics.configure(serverURL: api.baseURL)
        let source = """
        {
          "bots": [
            {"id":"bot-one","name":"ユキ","displayName":"ユキ","harness":"claude","model":"opus","reasoningEffort":"high","color":"indigo","profileText":"","personality":"","speechStyle":"","position":"","role":"相談と実務","avatar":"","online":true,"recent":{"id":"m1","kind":"message","direction":"incoming","at":"2026-09-26T00:12:00Z","message":"今朝の準備ができました。確認していただけますか？"}},
            {"id":"bot-two","name":"ハル","displayName":"ハル","harness":"codex","model":"","reasoningEffort":"","color":"violet","profileText":"","personality":"","speechStyle":"","position":"","role":"","avatar":"","online":true,"recent":{"id":"m2","kind":"message","direction":"incoming","at":"2026-09-25T23:54:00Z","message":"おかえりなさい。今日も一緒に進めましょう。"}},
            {"id":"bot-three","name":"ナギ","displayName":"ナギ","harness":"grok","model":"","reasoningEffort":"","color":"rose","profileText":"","personality":"","speechStyle":"","position":"","role":"","avatar":"","online":false,"recent":{"id":"m3","kind":"message","direction":"outgoing","at":"2026-09-24T08:30:00Z","message":"資料をお願い"}}
          ],
          "rooms": [
            {"id":"planning","name":"計画室","purpose":"今日の仕事を一緒に進める","representativeId":"bot-one","memberIds":["bot-one","bot-three"],"avatar":"","recent":{"id":"r1","kind":"message","at":"2026-09-26T00:04:00Z","message":"明日の予定を整理しました。","sender":{"id":"bot-three","name":"ナギ"}}},
            {"id":"ideas","name":"アイデア室","purpose":"アイデアを形にする","representativeId":"bot-two","memberIds":["bot-two","bot-three"],"avatar":"","recent":{"id":"r2","kind":"message","at":"2026-09-25T06:00:00Z","message":"新しい案を見てみよう。","sender":{"id":"bot-two","name":"ハル"}}}
          ],
          "owner": {"name":"利用者","profile":"","avatar":"","xUrl":"","githubUrl":"","links":[]}
        }
        """
        struct Fixture: Decodable {
            let bots: [Bot]
            let rooms: [Room]
            let owner: Owner
        }
        let fixture = try! JSONDecoder().decode(Fixture.self, from: Data(source.utf8))
        bots = fixture.bots
        rooms = fixture.rooms
        owner = fixture.owner
        workingBotIDs = ["bot-one"]
        phase = .ready
    }
}

enum PreviewMessages {
    static func items(for target: ChatTarget) -> [TimelineMessage] {
        if target == .bot("bot-one") { return items }
        if target == .bot("bot-three") { return questionItems }
        let text = target.isRoom ? "計画室専用の会話ログです。" : "ハル専用の会話ログです。\n\n" + richMarkdown
        let source: [[String: String]] = [["id": "preview-\(target.id)", "kind": "message",
            "direction": "incoming", "at": "2026-09-26T00:13:00Z", "message": text,
            "delivery": "delivered"]]
        return try! JSONDecoder().decode([TimelineMessage].self, from: JSONSerialization.data(withJSONObject: source))
    }

    static let richMarkdown = """
    ## 表示の確認

    **強調**と[資料](https://example.org)を読みやすく表示します。

    | 項目 | 状態 |
    | --- | --- |
    | 調査 | 完了 |
    | アプリの表示確認 | 進行中 |

    - 見出しと段落の余白
    - 長い項目も字下げを揃えて折り返します。

    > これは表示確認用のメモです。

    ```swift
    let status = "working"
    ```
    """

    static let updatingItems: [TimelineMessage] = {
        let lengths = [1200, 40, 1050, 90, 12, 1240, 11, 600, 90, 9]
        let paragraph = "これは会話画面の更新とスクロールを確認するためのテスト文章です。\n\n"
        let rows = lengths.enumerated().map { index, length in
            ["id": "updating-\(index)", "kind": "message",
             "direction": index.isMultiple(of: 2) ? "incoming" : "outgoing",
             "at": "2026-01-01T00:00:00Z",
             "message": String(String(repeating: paragraph, count: 40).prefix(length)),
             "delivery": "delivered"]
        }
        return try! JSONDecoder().decode([TimelineMessage].self, from: JSONSerialization.data(withJSONObject: rows))
    }()

    static let questionItems: [TimelineMessage] = {
        let source = """
        [
          {"id":"q1","kind":"owner_question","direction":"incoming","at":"2026-09-26T00:14:00Z","message":"資料の公開範囲を決めてほしいです。","ownerQuestion":{"id":"q1","botId":"bot-three","question":"資料の公開範囲を決めてほしいです。","options":["チームだけ","全員に公開"],"allowOther":true,"status":"open"}}
        ]
        """
        return try! JSONDecoder().decode([TimelineMessage].self, from: Data(source.utf8))
    }()

    static let items: [TimelineMessage] = {
        let source = """
        [
          {"id":"p1","kind":"message","direction":"incoming","at":"2026-09-26T00:11:00Z","message":"おはようございます。今朝の準備を整えました。","delivery":"delivered"},
          {"id":"p2","kind":"message","direction":"outgoing","at":"2026-09-26T00:12:00Z","message":"ありがとう。今日の予定を教えて。","delivery":"delivered"},
          {"id":"p3","kind":"message","direction":"incoming","at":"2026-09-26T00:13:00Z","message":"午前は打ち合わせ、午後はBellTeamの確認です。[資料](https://example.org) と https://example.com を見てください。","delivery":"delivered"}
        ]
        """
        return try! JSONDecoder().decode([TimelineMessage].self, from: Data(source.utf8))
    }()
}

struct PreviewNotificationControls: View {
    var body: some View {
        HStack {
            openButton("ハルの通知を開く", roomID: nil)
            openButton("計画室の通知を開く", roomID: "planning")
        }
        .font(.caption)
        .padding(8)
        .background(.regularMaterial)
    }

    private func openButton(_ title: String, roomID: String?) -> some View {
        Button(title) {
            var value = ["server": "https://bellteam.example", "kind": "reply", "botId": "bot-two"]
            value["roomId"] = roomID
            let route = BellNotificationRoute(userInfo: ["bellteam": value])!
            BellNotifications.shared.onOpen?(route)
        }
    }
}

struct PreviewAvatarCropView: View {
    @State private var source: AvatarCropSource? = AvatarCropSource(image: {
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 320, height: 240))
        return renderer.image { context in
            UIColor.systemBlue.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 160, height: 240))
            UIColor.systemGreen.setFill()
            context.fill(CGRect(x: 160, y: 0, width: 160, height: 240))
        }
    }())
    @State private var used = false

    var body: some View {
        Text(used ? "画像の調整が完了しました" : "アバター調整の確認")
            .sheet(item: $source) { value in
                AvatarCropEditor(image: value.image) { _ in used = true }
            }
    }
}
#endif
