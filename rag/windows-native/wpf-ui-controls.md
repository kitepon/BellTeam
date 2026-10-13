# WPFの表示テンプレートとスクロール通知

2026-10-13、Windows版の画面改修で公式資料と非表示の操作確認を照合した。

- ComboBoxの選択済み表示には`SelectionBoxItem`だけでなく、`SelectionBoxItemTemplate`と`ItemTemplateSelector`、文字列の書式をContentPresenterへ渡す。`DisplayMemberPath`が選ぶテンプレートを落とすと、選択肢のラベルがオブジェクトの文字列表現になる。[Microsoftの例](https://learn.microsoft.com/en-us/dotnet/api/system.windows.controls.combobox.selectionboxitemtemplate)、[WPFの標準Fluentテンプレート](https://github.com/dotnet/wpf/blob/main/src/Microsoft.DotNet.Wpf/src/Themes/PresentationFramework.Fluent/Themes/Fluent.xaml)。
- ScrollChangedは内側の本文部品からも届く。会話全体の位置を扱う処理は、そのScrollViewerを通知元とするイベントだけを扱う。本文の小さなスクロール通知を全体の寸法として使うと、途中を読んでいても末尾へ移動する。
- `BellTeam.UiChecks`はWPFの実際の部品を配置し、画面内移動・新着時の読書位置・履歴を追加した時の位置保持を、窓のハンドルを作らず確認する。前面の実操作は別に確認する。
