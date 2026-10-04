import SwiftUI

struct BotPresenceDot: View {
    let online: Bool
    let working: Bool
    let size: CGFloat

    var body: some View {
        Circle()
            .fill(working ? Color.red : online ? BellTheme.mint : BellTheme.line)
            .frame(width: size, height: size)
            .overlay(Circle().strokeBorder(.white, lineWidth: 2))
            .phaseAnimator(working ? [1.0, 0.25] : [1.0]) { dot, opacity in
                dot.opacity(opacity)
            } animation: { _ in
                .easeInOut(duration: 0.8)
            }
            .accessibilityLabel(working ? "仕事中" : online ? "オンライン・待機中" : "オフライン")
    }
}
