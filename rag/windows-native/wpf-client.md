# Windowsのネイティブ会話クライアント

出典: MicrosoftのWPF文書、Markdig公式README、BellTeamのFOX実測。取得日: 2026-10-13。確度: 描画モデルは公式仕様、非表示描画と通信は実測。実際の窓での操作は未確認。

WPFのFlowDocumentは段落、見出し、表、リスト、引用に使うSection、リンクなどの部品を持つ。RichTextBoxを読み取り専用にすると本文の範囲選択・コピーを提供できる。BellTeamはMarkdigの構文木をこれらの部品へ変換し、WebViewを使わず日本語の会話を描く。

FOXでWindowの`Show`を呼ばず、Contentに`Measure`・`Arrange`・`UpdateLayout`を行い、`RenderTargetBitmap`へ描けた。人工データと本番の読み取り結果をPNGで確認し、プロセスの終了も確認した。これは部品の配置の確認で、OSの窓・IME・DPI切り替えの確認にはならない。

Markdownでは参照リンクの定義が`LinkReferenceDefinitionGroup`として残る。本文として描く要素ではないため、定義は描画せず、解決済みのLinkInlineを描く。HTMLエンティティと自動リンクにも専用のInline型がある。単体試験でこの3種類と、見出し・引用・コード・表の描画を確認した。

JSONは必須プロパティとnull制約をモデルに付け、欠落した応答を空の一覧として扱わない。SSEはコメントを読み飛ばし、複数の`data:`行を連結し、空行でイベントを確定する。認証・応答形式・接続切断を利用者へ表示する。自動再試行は設けていない。

- [WPF公式原文](raw/flow-document-overview.md)
- [Markdig公式README原文](raw/markdig-readme.md)
- [JSONの必須プロパティ](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/required-properties)
- [実装と確認状況](../../docs/windows-app.md)
