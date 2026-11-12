using System.Diagnostics;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.Documents;
using Avalonia.Input;
using Avalonia.Layout;
using Avalonia.Media;
using Markdig;
using Markdig.Extensions.EmphasisExtras;
using Markdig.Extensions.TaskLists;
using Markdig.Syntax;
using Markdig.Syntax.Inlines;
using MdInline = Markdig.Syntax.Inlines.Inline;
using AvInline = Avalonia.Controls.Documents.Inline;

namespace BellTeam.Linux;

// The Markdown of a message as stacked blocks of selectable text; the same Markdig pipeline and block set as the Windows MarkdownView.
public sealed class MarkdownView : ContentControl
{
    private static readonly MarkdownPipeline Pipeline = new MarkdownPipelineBuilder().UsePipeTables().UseEmphasisExtras(EmphasisExtraOptions.Strikethrough).UseAutoLinks().UseTaskLists().UseSoftlineBreakAsHardlineBreak().DisableHtml().Build();
    private static readonly IBrush LinkBrush = new Avalonia.Media.Immutable.ImmutableSolidColorBrush(Color.FromRgb(118, 97, 171));
    // Where a link that cannot be opened reports to (the main window's action line).
    public static Action<string>? LinkFailed { get; set; }
    private string source = "";
    // Throws NotSupportedException for a Markdown element the view cannot draw; the caller shows that text instead.
    public string Source { get => source; set { if (source == value) return; source = value; Content = Build(value, FontSize); } }
    public MarkdownView() { Foreground = BellTheme.Ink; }
    public void ShowText(string text) { source = text; Content = new TextBlock { Text = text, TextWrapping = TextWrapping.Wrap }; }
    protected override void OnPropertyChanged(AvaloniaPropertyChangedEventArgs change)
    {
        base.OnPropertyChanged(change);
        if (change.Property == FontSizeProperty && source.Length != 0) Content = Build(source, FontSize);
    }
    public static Control Build(string markdown, double fontSize)
    {
        var column = new StackPanel();
        foreach (var block in Markdown.Parse(markdown, Pipeline)) column.Children.Add(Render(block, fontSize));
        return column;
    }
    private static Control Render(Block block, double size)
    {
        switch (block)
        {
            case HeadingBlock heading: return Paragraph(heading, heading.Level <= 2 ? 22 : 19, FontWeight.Bold);
            case ParagraphBlock paragraph: return Paragraph(paragraph, size, FontWeight.Normal);
            case CodeBlock code:
                return new Border { Background = new SolidColorBrush(Color.FromRgb(239, 237, 244)), Padding = new Thickness(10), Margin = new Thickness(0, 5, 0, 9), Child = new SelectableTextBlock { Text = code.Lines.ToString(), FontFamily = BellTheme.Mono, FontSize = 14, TextWrapping = TextWrapping.Wrap } };
            case ListBlock list:
                var rows = new StackPanel { Margin = new Thickness(0, 3, 0, 9) };
                var number = list.IsOrdered && int.TryParse(list.OrderedStart, out var start) ? start : 1;
                foreach (ListItemBlock item in list)
                {
                    var row = new Grid { ColumnDefinitions = new ColumnDefinitions("32,*") };
                    row.Children.Add(new TextBlock { Text = list.IsOrdered ? number++ + "." : "•", FontSize = size, LineHeight = 26, HorizontalAlignment = HorizontalAlignment.Right, Margin = new Thickness(0, 0, 8, 0) });
                    var body = new StackPanel(); Grid.SetColumn(body, 1);
                    foreach (var child in item) body.Children.Add(Render(child, size));
                    row.Children.Add(body); rows.Children.Add(row);
                }
                return rows;
            case QuoteBlock quote:
                var inner = new StackPanel();
                foreach (var child in quote) inner.Children.Add(Render(child, size));
                return new Border { BorderBrush = Brushes.Thistle, BorderThickness = new Thickness(3, 0, 0, 0), Padding = new Thickness(12, 2, 0, 2), Margin = new Thickness(0, 6, 0, 9), Child = inner };
            case Markdig.Extensions.Tables.Table table:
                var grid = new Grid { Margin = new Thickness(0, 6, 0, 9) };
                var rowIndex = 0;
                foreach (Markdig.Extensions.Tables.TableRow row in table)
                {
                    grid.RowDefinitions.Add(new RowDefinition(GridLength.Auto));
                    var columnIndex = 0;
                    foreach (Markdig.Extensions.Tables.TableCell cell in row)
                    {
                        while (grid.ColumnDefinitions.Count <= columnIndex) grid.ColumnDefinitions.Add(new ColumnDefinition(GridLength.Auto));
                        var content = new StackPanel(); foreach (var child in cell) content.Children.Add(Render(child, size));
                        var frame = new Border { Padding = new Thickness(7), BorderBrush = Brushes.LightGray, BorderThickness = new Thickness(1), Child = content };
                        if (row.IsHeader) TextElement.SetFontWeight(frame, FontWeight.Bold);
                        Grid.SetRow(frame, rowIndex); Grid.SetColumn(frame, columnIndex++); grid.Children.Add(frame);
                    }
                    rowIndex++;
                }
                return grid;
            case ThematicBreakBlock: return new TextBlock { Text = "────────────────", Foreground = Brushes.LightGray };
            // A reference link definition is resolved into its links and draws nothing.
            case LinkReferenceDefinitionGroup: return new Panel();
            default: throw new NotSupportedException($"Markdownの表示に未対応の要素があります: {block.GetType().Name}");
        }
    }

    private sealed class LinkMap { public int Length; public readonly List<(int Start, int End, Uri Uri)> Links = []; }
    private static SelectableTextBlock Paragraph(LeafBlock block, double size, FontWeight weight)
    {
        var map = new LinkMap();
        var text = new SelectableTextBlock { FontSize = size, FontWeight = weight, LineHeight = size == 18 ? 26 : size * 1.45, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 0, 0, 9) };
        if (block.Inline is { } inline) foreach (var child in inline) text.Inlines!.Add(RenderInline(child, map));
        // A click that selects nothing and lands on a link opens it (the TextBlock has no hyperlink inline).
        if (map.Links.Count != 0)
            text.PointerReleased += (_, args) =>
            {
                if (args.InitialPressMouseButton != MouseButton.Left || text.SelectionStart != text.SelectionEnd) return;
                var index = text.TextLayout.HitTestPoint(args.GetPosition(text)).TextPosition;
                foreach (var (start, end, uri) in map.Links) if (index >= start && index < end) { Open(uri); return; }
            };
        return text;
    }
    private static AvInline RenderInline(MdInline inline, LinkMap map)
    {
        switch (inline)
        {
            case LiteralInline literal: map.Length += literal.Content.Length; return new Run(literal.Content.ToString());
            case HtmlEntityInline entity: map.Length += entity.Transcoded.Length; return new Run(entity.Transcoded.ToString());
            case AutolinkInline auto: return Link(auto.IsEmail ? "mailto:" + auto.Url : auto.Url, map, () => { map.Length += auto.Url.Length; return new Span { Inlines = { new Run(auto.Url) } }; });
            case CodeInline code: map.Length += code.Content.Length; return new Run(code.Content) { FontFamily = BellTheme.Mono, Background = Brushes.Lavender };
            // A line break counts as one character, like the "\n" the text block lays out for it.
            case LineBreakInline: map.Length++; return new LineBreak();
            case TaskList task: map.Length += 2; return new Run(task.Checked ? "☑ " : "☐ ");
            case EmphasisInline emphasis:
                var span = Children(emphasis, map);
                if (emphasis.DelimiterChar == '~') span.TextDecorations = TextDecorations.Strikethrough;
                else
                {
                    if (emphasis.DelimiterCount >= 2) span.FontWeight = FontWeight.Bold;
                    if (emphasis.DelimiterCount % 2 != 0) span.FontStyle = FontStyle.Italic;
                }
                return span;
            case LinkInline link:
                return Link(link.Url, map, () => { var content = Children(link, map); if (link.IsImage) { content.Inlines.Add(new Run("（画像）")); map.Length += 4; } return content; });
            case ContainerInline container: return Children(container, map);
            default: throw new NotSupportedException($"Markdownの表示に未対応の要素があります: {inline.GetType().Name}");
        }
    }
    private static Span Children(ContainerInline container, LinkMap map)
    {
        var span = new Span(); foreach (var child in container) span.Inlines.Add(RenderInline(child, map)); return span;
    }
    private static AvInline Link(string? address, LinkMap map, Func<Span> content)
    {
        var start = map.Length; var span = content();
        if (!Uri.TryCreate(address, UriKind.Absolute, out var uri) || uri.Scheme is not ("https" or "http" or "mailto")) return span;
        span.Foreground = LinkBrush; span.TextDecorations = TextDecorations.Underline; map.Links.Add((start, map.Length, uri));
        return span;
    }
    private static void Open(Uri uri)
    {
        try { Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true }); }
        catch (Exception error) { LinkFailed?.Invoke("リンクを開けませんでした。" + error.Message); }
    }
}
