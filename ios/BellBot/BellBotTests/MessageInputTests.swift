import UIKit
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
