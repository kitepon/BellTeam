import UIKit

struct AvatarCropRect: Codable, Equatable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

enum AvatarCropVariant: String, Identifiable {
    case small, large

    var id: Self { self }

    var canvas: CGSize {
        switch self {
        case .small: CGSize(width: 512, height: 512)
        case .large: CGSize(width: 1024, height: 1024)
        }
    }
}

struct AvatarCropSelection {
    let render: String
    let source: String
    let crop: AvatarCropRect
}

enum AvatarImage {
    static let side: CGFloat = 512
    static let zoomRange: ClosedRange<Double> = 1...3

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
        renderedSize(of: image, zoom: zoom, canvas: CGSize(width: side, height: side))
    }

    static func renderedSize(of image: UIImage, zoom: CGFloat, canvas: CGSize) -> CGSize {
        let scale = max(canvas.width / image.size.width, canvas.height / image.size.height) * zoom
        return CGSize(width: image.size.width * scale, height: image.size.height * scale)
    }

    static func clampedOffset(_ offset: CGSize, image: UIImage, zoom: CGFloat) -> CGSize {
        clampedOffset(offset, image: image, zoom: zoom, canvas: CGSize(width: side, height: side))
    }

    static func clampedOffset(_ offset: CGSize, image: UIImage, zoom: CGFloat, canvas: CGSize) -> CGSize {
        let size = renderedSize(of: image, zoom: zoom, canvas: canvas)
        let limitX = (size.width - canvas.width) / 2
        let limitY = (size.height - canvas.height) / 2
        return CGSize(width: min(limitX, max(-limitX, offset.width)),
                      height: min(limitY, max(-limitY, offset.height)))
    }

    static func dataURL(from image: UIImage, zoom: CGFloat, offset: CGSize) -> String? {
        dataURL(from: image, zoom: zoom, offset: offset, canvas: CGSize(width: side, height: side))
    }

    static func dataURL(from image: UIImage, zoom: CGFloat, offset: CGSize, canvas: CGSize) -> String? {
        guard image.size.width > 0, image.size.height > 0 else { return nil }
        let size = renderedSize(of: image, zoom: zoom, canvas: canvas)
        let position = clampedOffset(offset, image: image, zoom: zoom, canvas: canvas)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let renderer = UIGraphicsImageRenderer(size: canvas, format: format)
        let jpeg = renderer.jpegData(withCompressionQuality: 0.9) { _ in
            image.draw(in: CGRect(x: (canvas.width - size.width) / 2 + position.width,
                                  y: (canvas.height - size.height) / 2 + position.height,
                                  width: size.width, height: size.height))
        }
        return "data:image/jpeg;base64,\(jpeg.base64EncodedString())"
    }

    static func cropRect(from image: UIImage, zoom: CGFloat, offset: CGSize, canvas: CGSize) -> AvatarCropRect? {
        guard image.size.width > 0, image.size.height > 0 else { return nil }
        let size = renderedSize(of: image, zoom: zoom, canvas: canvas)
        let position = clampedOffset(offset, image: image, zoom: zoom, canvas: canvas)
        return AvatarCropRect(x: Double(((size.width - canvas.width) / 2 - position.width) / size.width),
                              y: Double(((size.height - canvas.height) / 2 - position.height) / size.height),
                              width: Double(canvas.width / size.width),
                              height: Double(canvas.height / size.height))
    }

    static func placement(of crop: AvatarCropRect, image: UIImage, canvas: CGSize) -> (zoom: Double, offset: CGSize)? {
        guard image.size.width > 0, image.size.height > 0, crop.width > 0, crop.height > 0,
              crop.x >= 0, crop.y >= 0, crop.x + crop.width <= 1.000001,
              crop.y + crop.height <= 1.000001 else { return nil }
        let base = max(canvas.width / image.size.width, canvas.height / image.size.height)
        let scale = max(base,
                        canvas.width / (CGFloat(crop.width) * image.size.width),
                        canvas.height / (CGFloat(crop.height) * image.size.height))
        let zoom = min(zoomRange.upperBound, max(zoomRange.lowerBound, Double(scale / base)))
        let size = renderedSize(of: image, zoom: CGFloat(zoom), canvas: canvas)
        let offset = CGSize(width: (0.5 - CGFloat(crop.x + crop.width / 2)) * size.width,
                            height: (0.5 - CGFloat(crop.y + crop.height / 2)) * size.height)
        return (zoom, clampedOffset(offset, image: image, zoom: CGFloat(zoom), canvas: canvas))
    }

    static func sourceDataURL(from image: UIImage) -> String? {
        guard image.size.width > 0, image.size.height > 0 else { return nil }
        let ratio = min(1, 1600 / max(image.size.width, image.size.height))
        let size = CGSize(width: round(image.size.width * ratio), height: round(image.size.height * ratio))
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let jpeg = UIGraphicsImageRenderer(size: size, format: format)
            .jpegData(withCompressionQuality: 0.8) { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
        let source = "data:image/jpeg;base64,\(jpeg.base64EncodedString())"
        return source.count <= 3_000_000 ? source : nil
    }
}
