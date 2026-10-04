import SwiftUI

enum BellTheme {
    static let ink = Color(red: 0.13, green: 0.16, blue: 0.24)
    static let muted = Color(red: 0.47, green: 0.49, blue: 0.57)
    static let violet = Color(red: 0.38, green: 0.28, blue: 0.83)
    static let violetLight = Color(red: 0.91, green: 0.88, blue: 1.0)
    static let mint = Color(red: 0.18, green: 0.70, blue: 0.62)
    static let canvas = Color(red: 0.974, green: 0.971, blue: 0.985)
    static let line = Color(red: 0.90, green: 0.89, blue: 0.94)

    #if targetEnvironment(macCatalyst)
    static let messageFontSize: CGFloat = 18
    static let inputFontSize: CGFloat = 18
    static let listNameFontSize: CGFloat = 16
    static let listDetailFontSize: CGFloat = 14
    static let conversationLabelFontSize: CGFloat = 14
    static let peerMessageFontSize: CGFloat = 18
    static let secondaryFont = Font.system(size: 14)
    static let controlsFont = Font.system(size: 16)
    static let profileTitleFont = Font.system(size: 20)
    static let profileMemberFont = Font.system(size: 16)
    static let messageHelperFont = Font.system(size: 14)
    static var profileBodyFont: UIFont { .systemFont(ofSize: 18) }
    #else
    static let messageFontSize: CGFloat = 15.5
    static let inputFontSize: CGFloat = 16
    static let listNameFontSize: CGFloat = 13
    static let listDetailFontSize: CGFloat = 11
    static let conversationLabelFontSize: CGFloat = 12
    static let peerMessageFontSize: CGFloat = 17
    static let secondaryFont = Font.caption
    static let controlsFont = Font.body
    static let profileTitleFont = Font.title3
    static let profileMemberFont = Font.callout
    static let messageHelperFont = Font.footnote
    static var profileBodyFont: UIFont { .preferredFont(forTextStyle: .callout) }
    #endif

    static func accent(_ name: String) -> Color {
        switch name {
        case "rose": Color(red: 0.91, green: 0.42, blue: 0.58)
        case "indigo": Color(red: 0.27, green: 0.35, blue: 0.76)
        case "sky": Color(red: 0.28, green: 0.63, blue: 0.89)
        case "mint": mint
        case "amber": Color(red: 0.91, green: 0.62, blue: 0.28)
        default: violet
        }
    }
}

struct BellBackground: View {
    var body: some View {
        ZStack {
            BellTheme.canvas
            LinearGradient(
                colors: [BellTheme.violetLight.opacity(0.75), BellTheme.canvas, .white],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            Circle()
                .fill(BellTheme.violet.opacity(0.08))
                .frame(width: 380, height: 380)
                .blur(radius: 65)
                .offset(x: 170, y: -330)
        }
        .ignoresSafeArea()
    }
}

struct AvatarView: View {
    let name: String
    let avatar: String
    let color: Color
    let size: CGFloat
    var isRoom = false

    private var portrait: UIImage? {
        guard avatar.hasPrefix("data:image/"), let comma = avatar.firstIndex(of: ","),
              let data = Data(base64Encoded: String(avatar[avatar.index(after: comma)...])) else { return nil }
        return UIImage(data: data)
    }

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.31, style: .continuous)
                .fill(LinearGradient(colors: [color.opacity(0.73), color], startPoint: .topLeading, endPoint: .bottomTrailing))
            if let portrait {
                Image(uiImage: portrait)
                    .resizable()
                    .scaledToFill()
                    .frame(width: size, height: size)
                    .clipped()
            } else if isRoom {
                Image(systemName: "person.3.fill")
                    .font(.system(size: size * 0.37, weight: .semibold))
                    .foregroundStyle(.white)
            } else {
                Text(String(name.prefix(1)))
                    .font(.system(size: size * 0.42, weight: .bold, design: .rounded))
                    .foregroundStyle(.white)
            }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: size * 0.31, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: size * 0.31, style: .continuous).strokeBorder(.white.opacity(0.7), lineWidth: 1))
    }
}

enum BellDate {
    static func parse(_ value: String) -> Date? {
        let precise = ISO8601DateFormatter()
        precise.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return precise.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }

    static func short(_ value: String?) -> String {
        guard let value, let date = parse(value) else { return "" }
        if Calendar.current.isDateInToday(date) { return date.formatted(date: .omitted, time: .shortened) }
        if Calendar.current.isDateInYesterday(date) { return "昨日" }
        return date.formatted(.dateTime.month(.abbreviated).day())
    }
}

extension View {
    func bellCard() -> some View {
        self
            .background(.white.opacity(0.91), in: RoundedRectangle(cornerRadius: 24, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 24, style: .continuous).strokeBorder(BellTheme.line.opacity(0.65)))
            .shadow(color: BellTheme.ink.opacity(0.035), radius: 16, y: 8)
    }
}
