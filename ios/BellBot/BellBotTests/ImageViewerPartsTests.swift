import Foundation
import UniformTypeIdentifiers
import XCTest
@testable import BellBot

final class ImageViewerPartsTests: XCTestCase {
    func testNameIsTheLastPathSegmentWithoutQuery() {
        XCTAssertEqual(ImageFileInfo.name(forPath: "/api/message-images/owner/abc123.png"), "abc123.png")
        XCTAssertEqual(ImageFileInfo.name(forPath: "/api/message-images/owner/abc123.jpg?download=1"), "abc123.jpg")
        XCTAssertEqual(ImageFileInfo.name(forPath: ""), "image.jpg")
    }

    func testContentTypeFollowsTheExtension() {
        XCTAssertEqual(ImageFileInfo.contentType(forName: "a.png"), .png)
        XCTAssertEqual(ImageFileInfo.contentType(forName: "a.JPG"), .jpeg)
        XCTAssertTrue(ImageFileInfo.contentType(forName: "a.webp").conforms(to: .image))
        XCTAssertTrue(ImageFileInfo.contentType(forName: "a.gif").conforms(to: .gif))
        // 画像でない拡張子や拡張子なしはjpegとして扱う（契約は png/jpg/webp/gif だけ）。
        XCTAssertEqual(ImageFileInfo.contentType(forName: "a.txt"), .jpeg)
        XCTAssertEqual(ImageFileInfo.contentType(forName: "pr3-one"), .jpeg)
    }

    func testTemporaryFileKeepsTheSavedName() throws {
        let data = Data([1, 2, 3])
        let url = try ImageViewerActions.temporaryFile(data: data, name: "abc.png")
        XCTAssertEqual(url.lastPathComponent, "abc.png")
        XCTAssertEqual(try Data(contentsOf: url), data)
    }
}
