# WPFの入力改行とBellTeamへの送信

2026-10-13、FOXの.NET 10のWPFで確認。

- [EditingCommands.EnterParagraphBreak](https://learn.microsoft.com/en-us/dotnet/api/system.windows.documents.editingcommands.enterparagraphbreak)はEnterに対応する。
- [TextEditorTypingの実装](https://source.dot.net/PresentationFramework/System/windows/Documents/TextEditorTyping.cs.html)は、フォーカスのある入力に対し、通常テキストの改行処理を呼ぶ。
- `NewlineTests`では窓を表示せず、WPFの通常テキスト用Enter処理`HandleEnterBreakForPlainText`を直接呼び、`TextBox.Text`がCRLFになることを確認した。選択位置へのCRLF挿入も保持される。フォーカスを奪わず試すため、内部メソッドへの参照は試験内だけに置く。実際のキー入力・クリップボード操作は未確認。
- BellTeamは通常の文と複数行の設定値を送信時にLFへそろえる。編集前後もLFで比較し、改行形式だけの違いでは変更欄を増やさない。秘密の値は変換しない。
