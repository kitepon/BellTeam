import UIKit

enum AvatarImage {
    static let side: CGFloat = 512

    static func decode(_ data: Data) throws -> UIImage {
        guard let image = UIImage(data: data) else { throw BellAPIError.invalidResponse }
        return image
    }

    static func load(from fileURL: URL) throws -> UIImage {
        let accessing = fileURL.startAccessingSecurityScopedResource()
        defer { if accessing { fileURL.stopAccessingSecurityScopedResource() } }
        return try decode(Data(contentsOf: fileURL))
    }

    static func renderedSize(of image: UIImage, zoom: CGFloat) -> CGSize {
        let scale = max(side / image.size.width, side / image.size.height) * zoom
        return CGSize(width: image.size.width * scale, height: image.size.height * scale)
    }

    static func clampedOffset(_ offset: CGSize, image: UIImage, zoom: CGFloat) -> CGSize {
        let size = renderedSize(of: image, zoom: zoom)
        let limitX = (size.width - side) / 2
        let limitY = (size.height - side) / 2
        return CGSize(width: min(limitX, max(-limitX, offset.width)),
                      height: min(limitY, max(-limitY, offset.height)))
    }

    static func dataURL(from image: UIImage, zoom: CGFloat, offset: CGSize) -> String? {
        guard image.size.width > 0, image.size.height > 0 else { return nil }
        let size = renderedSize(of: image, zoom: zoom)
        let position = clampedOffset(offset, image: image, zoom: zoom)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: side, height: side), format: format)
        let jpeg = renderer.jpegData(withCompressionQuality: 0.9) { _ in
            image.draw(in: CGRect(x: (side - size.width) / 2 + position.width,
                                  y: (side - size.height) / 2 + position.height,
                                  width: size.width, height: size.height))
        }
        return "data:image/jpeg;base64,\(jpeg.base64EncodedString())"
    }
}
