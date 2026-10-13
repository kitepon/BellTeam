using System.Diagnostics;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Documents;
using System.Windows.Media;
using Markdig;
using Markdig.Syntax;
using Markdig.Syntax.Inlines;
using Markdig.Extensions.Tables;
using Markdig.Extensions.TaskLists;
using Markdig.Extensions.EmphasisExtras;
using WpfBlock = System.Windows.Documents.Block;
using WpfInline = System.Windows.Documents.Inline;
using WpfTable = System.Windows.Documents.Table;

namespace BellTeam.App;

public sealed class MarkdownView : RichTextBox
{
    private static readonly MarkdownPipeline Pipeline = new MarkdownPipelineBuilder().UsePipeTables().UseEmphasisExtras(EmphasisExtraOptions.Strikethrough).UseAutoLinks().UseTaskLists().UseSoftlineBreakAsHardlineBreak().DisableHtml().Build();
    public static readonly DependencyProperty SourceProperty = DependencyProperty.Register(nameof(Source), typeof(string), typeof(MarkdownView), new PropertyMetadata("", SourceChanged));
    public string Source { get => (string)GetValue(SourceProperty); set => SetValue(SourceProperty, value); }
    public MarkdownView()
    {
        IsReadOnly = true; IsDocumentEnabled = true; BorderThickness = new Thickness(0); Background = Brushes.Transparent; Padding = new Thickness(0);
        VerticalScrollBarVisibility = ScrollBarVisibility.Disabled; HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled;
    }
    private static void SourceChanged(DependencyObject target, DependencyPropertyChangedEventArgs args)
    {
        var view = (MarkdownView)target;
        var document = new FlowDocument { FontFamily = new FontFamily("Yu Gothic UI"), FontSize = view.FontSize, LineHeight = view.FontSize * 1.5, Foreground = new SolidColorBrush(Color.FromRgb(33, 41, 61)), PagePadding = new Thickness(0) };
        foreach (var block in Markdown.Parse((string?)args.NewValue ?? "", Pipeline)) document.Blocks.Add(Render(block));
        view.Document = document;
    }
    public static FlowDocument Parse(string source)
    {
        var document = new FlowDocument();
        foreach (var block in Markdown.Parse(source, Pipeline)) document.Blocks.Add(Render(block));
        return document;
    }
    private static WpfBlock Render(Markdig.Syntax.Block block)
    {
        switch (block)
        {
            case HeadingBlock heading:
                var title = Paragraph(heading); title.FontWeight = FontWeights.Bold; title.FontSize = heading.Level <= 2 ? 22 : 19; return title;
            case ParagraphBlock paragraph: return Paragraph(paragraph);
            case CodeBlock code:
                return new Paragraph(new Run(code.Lines.ToString())) { FontFamily = new FontFamily("Cascadia Mono, Consolas"), FontSize = 14, Background = new SolidColorBrush(Color.FromRgb(239, 237, 244)), Padding = new Thickness(10), Margin = new Thickness(0, 5, 0, 9) };
            case ListBlock list:
                var output = new System.Windows.Documents.List { MarkerStyle = list.IsOrdered ? TextMarkerStyle.Decimal : TextMarkerStyle.Disc, Margin = new Thickness(0, 3, 0, 9), Padding = new Thickness(24, 0, 0, 0) };
                if (list.IsOrdered && int.TryParse(list.OrderedStart, out var start)) output.StartIndex = start;
                foreach (ListItemBlock item in list)
                {
                    var element = new System.Windows.Documents.ListItem();
                    foreach (var child in item) element.Blocks.Add(Render(child));
                    output.ListItems.Add(element);
                }
                return output;
            case QuoteBlock quote:
                var section = new Section { BorderBrush = Brushes.Thistle, BorderThickness = new Thickness(3, 0, 0, 0), Padding = new Thickness(12, 2, 0, 2), Margin = new Thickness(0, 6, 0, 9) };
                foreach (var child in quote) section.Blocks.Add(Render(child)); return section;
            case Markdig.Extensions.Tables.Table table:
                var grid = new WpfTable { CellSpacing = 0, Margin = new Thickness(0, 6, 0, 9) };
                var group = new TableRowGroup(); grid.RowGroups.Add(group);
                foreach (Markdig.Extensions.Tables.TableRow row in table)
                {
                    var nativeRow = new System.Windows.Documents.TableRow(); group.Rows.Add(nativeRow);
                    foreach (Markdig.Extensions.Tables.TableCell cell in row)
                    {
                        var nativeCell = new System.Windows.Documents.TableCell { Padding = new Thickness(7), BorderBrush = Brushes.LightGray, BorderThickness = new Thickness(0.5), FontWeight = row.IsHeader ? FontWeights.Bold : FontWeights.Normal };
                        foreach (var child in cell) nativeCell.Blocks.Add(Render(child));
                        nativeRow.Cells.Add(nativeCell);
                    }
                }
                return grid;
            case ThematicBreakBlock: return new Paragraph(new Run("────────────────")) { Foreground = Brushes.LightGray };
            // 参照リンクの定義はリンクへ解決済みで、本文としては描かない。
            case LinkReferenceDefinitionGroup: return new Section { Margin = new Thickness(0) };
            default: throw new NotSupportedException($"Markdownの表示に未対応の要素があります: {block.GetType().Name}");
        }
    }
    private static Paragraph Paragraph(LeafBlock block)
    {
        var paragraph = new Paragraph { Margin = new Thickness(0, 0, 0, 9), LineHeight = 26 };
        if (block.Inline is { } inline) foreach (var child in inline) paragraph.Inlines.Add(RenderInline(child));
        return paragraph;
    }
    private static WpfInline RenderInline(Markdig.Syntax.Inlines.Inline inline)
    {
        switch (inline)
        {
            case LiteralInline literal: return new Run(literal.Content.ToString());
            case HtmlEntityInline entity: return new Run(entity.Transcoded.ToString());
            case AutolinkInline autoLink:
                return RenderLink(autoLink.IsEmail ? "mailto:" + autoLink.Url : autoLink.Url, new Span(new Run(autoLink.Url)));
            case CodeInline code: return new Run(code.Content) { FontFamily = new FontFamily("Consolas"), Background = Brushes.Lavender };
            case LineBreakInline: return new LineBreak();
            case TaskList task: return new Run(task.Checked ? "☑ " : "☐ ");
            case EmphasisInline emphasis:
                var span = Children(emphasis);
                if (emphasis.DelimiterChar == '~') span.TextDecorations = TextDecorations.Strikethrough;
                else
                {
                    if (emphasis.DelimiterCount >= 2) span.FontWeight = FontWeights.Bold;
                    if (emphasis.DelimiterCount % 2 != 0) span.FontStyle = FontStyles.Italic;
                }
                return span;
            case LinkInline link:
                var content = Children(link);
                if (link.IsImage) content.Inlines.Add(new Run("（画像）"));
                return RenderLink(link.Url, content);
            case ContainerInline container: return Children(container);
            default: throw new NotSupportedException($"Markdownの表示に未対応の要素があります: {inline.GetType().Name}");
        }
    }
    private static Span Children(ContainerInline container)
    {
        var span = new Span(); foreach (var child in container) span.Inlines.Add(RenderInline(child)); return span;
    }
    private static Span RenderLink(string? address, Span content)
    {
        if (!Uri.TryCreate(address, UriKind.Absolute, out var uri) || uri.Scheme is not ("https" or "http" or "mailto")) return content;
        var hyperlink = new Hyperlink(content) { NavigateUri = uri, Foreground = new SolidColorBrush(Color.FromRgb(118, 97, 171)) };
        hyperlink.RequestNavigate += (_, args) =>
        {
            try { Process.Start(new ProcessStartInfo(args.Uri.AbsoluteUri) { UseShellExecute = true }); }
            catch (Exception error) { MessageBox.Show("リンクを開けませんでした。" + error.Message, "BellTeam"); }
            args.Handled = true;
        };
        return hyperlink;
    }
}
