import UIKit
import UniformTypeIdentifiers
import XCTest
@testable import BellBot

@MainActor
final class MessageInputTests: XCTestCase {
    func testTabletReturnSendsAndModifiersInsertNewlines() throws {
        #if !targetEnvironment(macCatalyst)
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .pad, "iPadの外付けキーボード処理の試験です。")
        #endif
        let input = MessageTextView()
        let recorder = TextRecorder()
        input.delegate = recorder
        input.text = "最初の行"
        input.selectedRange = NSRange(location: input.text.utf16.count, length: 0)
        var sends = 0
        input.onSend = { sends += 1 }
        let commands = try XCTUnwrap(input.keyCommands)
        let shift = try XCTUnwrap(commands.first { $0.modifierFlags == .shift })
        input.perform(shift.action, with: shift)
        XCTAssertEqual(input.text, "最初の行\n")
        XCTAssertEqual(recorder.text, input.text)
        let option = try XCTUnwrap(commands.first { $0.modifierFlags == .alternate })
        input.perform(option.action, with: option)
        XCTAssertEqual(input.text, "最初の行\n\n")
        XCTAssertEqual(recorder.text, input.text)
        XCTAssertEqual(sends, 0)
        let enter = try XCTUnwrap(commands.first { $0.modifierFlags.isEmpty })
        input.perform(enter.action, with: enter)
        XCTAssertEqual(sends, 1)
        XCTAssertEqual(input.text, "最初の行\n\n")
    }

    func testCopiedImageFileIsAttachedBeforeItsIconAndOtherFilesFail() throws {
        let pasteboard = try XCTUnwrap(UIPasteboard(name: UIPasteboard.Name("bellteam-paste-\(UUID().uuidString)"), create: true))
        defer { UIPasteboard.remove(withName: pasteboard.name) }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 4, height: 4))
        let png = renderer.pngData { $0.cgContext.fill(CGRect(x: 0, y: 0, width: 4, height: 4)) }
        let imageFile = directory.appendingPathComponent("写真.png"), textFile = directory.appendingPathComponent("メモ.txt")
        try png.write(to: imageFile)
        try Data("画像ではない".utf8).write(to: textFile)
        let icon = renderer.image { $0.cgContext.fill(CGRect(x: 0, y: 0, width: 1, height: 1)) }

        let input = MessageTextView()
        input.pasteboard = pasteboard
        var pasted: [PendingImage] = [], failures: [String] = []
        input.onPasteImages = { pasted += $0 }
        input.onPasteFailure = { failures.append($0) }

        // Finderでファイルをコピーすると、ファイルのURLとアイコン画像が一緒に載る。
        pasteboard.setItems([[UTType.fileURL.identifier: imageFile, UTType.png.identifier: icon.pngData()!]])
        XCTAssertTrue(input.canPerformAction(#selector(UIResponder.paste(_:)), withSender: nil))
        input.paste(nil)
        XCTAssertEqual(pasted.count, 1)
        XCTAssertEqual(pasted.first?.data, PendingImage(data: png)?.data, "アイコンではなく、ファイル本体を添付する")
        XCTAssertTrue(failures.isEmpty)

        pasteboard.urls = [textFile]
        input.paste(nil)
        XCTAssertEqual(pasted.count, 1, "画像ではないファイルは添付しない")
        XCTAssertEqual(failures.count, 1)
        XCTAssertTrue(failures[0].contains("メモ.txt"))
    }

    #if !targetEnvironment(macCatalyst)
    func testPhoneReturnUsesSystemKeyboardBehavior() throws {
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .phone, "iPhoneのキーボード処理の試験です。")
        let input = MessageTextView()
        let hasCustomCommand = input.keyCommands?.contains(where: {
            $0.action == NSSelectorFromString("sendWithReturn:")
        }) ?? false
        XCTAssertFalse(hasCustomCommand)
    }
    #endif

    private final class TextRecorder: NSObject, UITextViewDelegate {
        var text = ""
        func textViewDidChange(_ textView: UITextView) { text = textView.text }
    }
}
