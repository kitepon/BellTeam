import SwiftUI

enum AvatarTone {
    private static let cache = NSCache<NSString, UIColor>()

    static func accent(for bot: Bot?) -> Color {
        let fallback = BellTheme.accent(bot?.color ?? "violet")
        guard let avatar = bot?.avatar, avatar.hasPrefix("data:image/"),
              let comma = avatar.firstIndex(of: ",") else { return fallback }
        let key = avatar as NSString
        if let cached = cache.object(forKey: key) { return Color(uiColor: cached) }
        guard let data = Data(base64Encoded: String(avatar[avatar.index(after: comma)...])),
              let image = UIImage(data: data)?.cgImage,
              let color = representativeColor(image) else { return fallback }
        cache.setObject(color, forKey: key)
        return Color(uiColor: color)
    }

    static func representativeColor(_ image: CGImage) -> UIColor? {
        let side = 24
        var pixels = [UInt8](repeating: 0, count: side * side * 4)
        guard let context = CGContext(data: &pixels, width: side, height: side,
                                      bitsPerComponent: 8, bytesPerRow: side * 4,
                                      space: CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        context.draw(image, in: CGRect(x: 0, y: 0, width: side, height: side))

        var red = 0.0, green = 0.0, blue = 0.0, total = 0.0
        for index in stride(from: 0, to: pixels.count, by: 4) {
            let r = Double(pixels[index]), g = Double(pixels[index + 1]), b = Double(pixels[index + 2])
            let maximum = max(r, g, b), minimum = min(r, g, b)
            if pixels[index + 3] < 128 || (maximum > 235 && minimum > 200) || maximum < 40 { continue }
            let weight = 0.15 + (maximum - minimum) / maximum
            red += r * weight; green += g * weight; blue += b * weight; total += weight
        }
        guard total > 0 else { return nil }
        var hue: CGFloat = 0, saturation: CGFloat = 0, brightness: CGFloat = 0, alpha: CGFloat = 0
        UIColor(red: red / total / 255, green: green / total / 255,
                blue: blue / total / 255, alpha: 1)
            .getHue(&hue, saturation: &saturation, brightness: &brightness, alpha: &alpha)
        guard saturation > 0.05 else { return nil }
        return UIColor(hue: hue, saturation: max(0.55, min(0.8, saturation)), brightness: 0.78, alpha: 1)
    }
}
