import UIKit
import XCTest
@testable import BellBot

final class AvatarImageTests: XCTestCase {
    func testImageFileLoadsForTheSharedCropAndExportPath() throws {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let source = UIGraphicsImageRenderer(size: CGSize(width: 80, height: 40), format: format).image { context in
            UIColor.green.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 80, height: 40))
        }
        let fileURL = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".png")
        defer { try? FileManager.default.removeItem(at: fileURL) }
        try XCTUnwrap(source.pngData()).write(to: fileURL)

        let image = try AvatarImage.load(from: fileURL)
        XCTAssertEqual(image.size, source.size)
        let dataURL = try XCTUnwrap(AvatarImage.dataURL(from: image, zoom: 1, offset: .zero))
        let data = try XCTUnwrap(Data(base64Encoded: String(dataURL.dropFirst("data:image/jpeg;base64,".count))))
        let cropped = try XCTUnwrap(UIImage(data: data)?.cgImage)
        XCTAssertEqual(cropped.width, 512)
        XCTAssertEqual(cropped.height, 512)
    }

    func testInvalidAndMissingImageFilesFailInsteadOfOpeningTheCropEditor() throws {
        let fileURL = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".png")
        XCTAssertThrowsError(try AvatarImage.load(from: fileURL))
        try Data("画像ではない内容".utf8).write(to: fileURL)
        defer { try? FileManager.default.removeItem(at: fileURL) }
        XCTAssertThrowsError(try AvatarImage.load(from: fileURL)) { error in
            guard case BellAPIError.invalidResponse = error else {
                return XCTFail("画像の復号エラーを返す必要があります: \(error)")
            }
        }
    }

    func testDragClampsToImageEdgeAndExportsSquareJPEG() throws {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let source = UIGraphicsImageRenderer(size: CGSize(width: 200, height: 100), format: format).image { context in
            UIColor.red.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 100, height: 100))
            UIColor.blue.setFill()
            context.fill(CGRect(x: 100, y: 0, width: 100, height: 100))
        }

        let left = AvatarImage.clampedOffset(CGSize(width: 1_000, height: 100), image: source, zoom: 1)
        XCTAssertEqual(left.width, 256)
        XCTAssertEqual(left.height, 0)

        let dataURL = try XCTUnwrap(AvatarImage.dataURL(from: source, zoom: 1, offset: left))
        XCTAssertTrue(dataURL.hasPrefix("data:image/jpeg;base64,"))
        let data = try XCTUnwrap(Data(base64Encoded: String(dataURL.dropFirst("data:image/jpeg;base64,".count))))
        let result = try XCTUnwrap(UIImage(data: data)?.cgImage)
        XCTAssertEqual(result.width, 512)
        XCTAssertEqual(result.height, 512)
        let center = try XCTUnwrap(result.cropping(to: CGRect(x: 256, y: 256, width: 1, height: 1)))
        var pixel = [UInt8](repeating: 0, count: 4)
        let context = try XCTUnwrap(CGContext(data: &pixel, width: 1, height: 1, bitsPerComponent: 8,
                                              bytesPerRow: 4, space: CGColorSpaceCreateDeviceRGB(),
                                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.draw(center, in: CGRect(x: 0, y: 0, width: 1, height: 1))
        XCTAssertGreaterThan(pixel[0], 200)
        XCTAssertLessThan(pixel[2], 50)
    }
}
