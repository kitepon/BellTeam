出典: [EnrichedMarkdown公式資料](https://github.com/software-mansion-labs/enriched-markdown-ios)、[保存した一次資料](raw/enriched-markdown-readme.md)
取得日: 2026-10-05
確度: 一次資料、iPhoneシミュレーターの表示・コピー試験とMac Catalystのビルド・画面で確認

# 会話本文のMarkdown表示

`EnrichedMarkdownText`は見出し・GFM表・箇条書き・引用・コードをUIKitの本文へ描画する。範囲選択は`markdownSelectable(true)`で有効にする。コピー時には表をタブで列を区切った文章として取り出せる。ライブラリの標準スタイルを使い、本文とリンクの色・文字サイズ・行間だけ`markdownTheme`で調整できる。

BellTeamでは共通の`MessageText`へ採用し、iPhone・iPad・Mac Catalystで使う。ソフト改行は`Md4cFlags(hardSoftBreaks: true)`で表示する。描画後の文字列は改行にU+2028を使う場合があるため、試験は行区切りとして扱う。採用版とソースのrevisionはXcodeプロジェクトの`Package.resolved`を参照する。

部分選択のコピーと表のコピーは、ホストした実際の本文ビューで確認する。iOSの単体試験では、試験前のクリップボードに別プロセスが書いた内容があると、読取り許可ダイアログで待つ。コピーを確かめる試験は自分の試験用内容を先に初期化する。
