using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Markup;
using System.Windows.Media;
using System.Windows.Media.Effects;

namespace BellTeam.App;

public enum SettingsPage { Profile, Ai, Terminals, Features, Notifications, Connection, Display, Billing, Update, About, Stop }

// Category list content of the Mac SettingsView (SettingsPage enum), copied verbatim.
public static class SettingsPageInfo
{
    public static readonly SettingsPage[][] Groups =
    [
        [SettingsPage.Ai, SettingsPage.Terminals, SettingsPage.Features, SettingsPage.Notifications],
        [SettingsPage.Connection, SettingsPage.Display],
        [SettingsPage.Billing, SettingsPage.Update, SettingsPage.About],
        [SettingsPage.Stop]
    ];
    public static string Title(SettingsPage page) => page switch
    {
        SettingsPage.Profile => "プロフィール", SettingsPage.Ai => "AIの設定", SettingsPage.Terminals => "端末", SettingsPage.Features => "追加機能", SettingsPage.Notifications => "通知", SettingsPage.Connection => "接続",
        SettingsPage.Display => "表示", SettingsPage.Billing => "利用と課金", SettingsPage.Update => "アップデート", SettingsPage.About => "このアプリについて", _ => "全体停止"
    };
    public static string Detail(SettingsPage page) => page switch
    {
        SettingsPage.Profile => "名前・写真・紹介文と、チームが守るあなたの決まり", SettingsPage.Ai => "AIのアカウントと、仕事の要約を書くAI", SettingsPage.Terminals => "メンバーの席を動かす端末と、その鍵", SettingsPage.Features => "通知の送信などを使うための設定",
        SettingsPage.Notifications => "メンバーからの連絡をこの端末に届ける", SettingsPage.Connection => "つないでいるサーバーとログイン方法", SettingsPage.Display => "会話を開く時の動き",
        SettingsPage.Billing => "料金と、サーバーとAIの契約", SettingsPage.Update => "サーバーの部品を最新にする", SettingsPage.About => "アプリの版と接続先", _ => "全員のAIの動作をまとめて止める"
    };
    // Segoe Fluent Icons code points standing in for the Mac SF Symbols.
    public static string Glyph(SettingsPage page) => page switch
    {
        SettingsPage.Profile => "", SettingsPage.Ai => "✦", SettingsPage.Terminals => "", SettingsPage.Features => "", SettingsPage.Notifications => "", SettingsPage.Connection => "",
        SettingsPage.Display => "", SettingsPage.Billing => "", SettingsPage.Update => "", SettingsPage.About => "", _ => ""
    };
    public static Color Tint(SettingsPage page) => page switch
    {
        SettingsPage.Profile => Color.FromRgb(0x61, 0x47, 0xD4), SettingsPage.Ai => Color.FromRgb(0xAF, 0x52, 0xDE), SettingsPage.Terminals => Color.FromRgb(0x32, 0xAD, 0xE6), SettingsPage.Features => Color.FromRgb(0xFF, 0x95, 0x00),
        SettingsPage.Notifications => Color.FromRgb(0xFF, 0x3B, 0x30), SettingsPage.Connection => Color.FromRgb(0x00, 0x7A, 0xFF), SettingsPage.Display => Color.FromRgb(0x58, 0x56, 0xD6),
        SettingsPage.Billing => Color.FromRgb(0x34, 0xC7, 0x59), SettingsPage.Update => Color.FromRgb(0x30, 0xB0, 0xC7), SettingsPage.About => Color.FromRgb(0x8E, 0x8E, 0x93), _ => Color.FromRgb(0xFF, 0x3B, 0x30)
    };
}

// Building blocks of the Mac-style settings pages: icon tiles, grouped cards, rows and buttons.
internal static class SettingsUi
{
    private static SolidColorBrush Solid(string hex) { var brush = new SolidColorBrush((Color)ColorConverter.ConvertFromString(hex)); brush.Freeze(); return brush; }
    public static readonly Brush Ink = Solid("#21293D"), Muted = Solid("#787D91"), Secondary = Solid("#8A8A8E"), Violet = Solid("#6147D4"), Red = Solid("#FF3B30"), Green = Solid("#34C759"), Orange = Solid("#FF9500");
    public static readonly Brush Canvas = Solid("#F2F2F7"), Hairline = Solid("#E6E6EB"), Fill = Solid("#F0F0F4");
    public static readonly FontFamily Icons = new("Segoe Fluent Icons, Segoe MDL2 Assets");

    public static TextBlock Text(string text, double size = 13, Brush? color = null, FontWeight? weight = null, Thickness? margin = null)
        => new() { Text = text, FontSize = size, Foreground = color ?? Ink, FontWeight = weight ?? FontWeights.Normal, TextWrapping = TextWrapping.Wrap, Margin = margin ?? new Thickness(0) };
    public static TextBlock Glyph(string glyph, double size, Brush? color = null) => new() { Text = glyph, FontFamily = Icons, FontSize = size, Foreground = color ?? Ink, VerticalAlignment = VerticalAlignment.Center };

    public static FrameworkElement Tile(SettingsPage page, double side)
    {
        var tint = SettingsPageInfo.Tint(page);
        var light = Color.FromRgb((byte)(tint.R + (255 - tint.R) * .2), (byte)(tint.G + (255 - tint.G) * .2), (byte)(tint.B + (255 - tint.B) * .2));
        var grid = new Grid { Width = side, Height = side };
        grid.Children.Add(new Border { CornerRadius = new CornerRadius(side * .24), Background = new LinearGradientBrush(light, tint, 90) });
        if (page == SettingsPage.Stop)
        {
            // stop.circle.fill: white disc with a tinted square.
            grid.Children.Add(new System.Windows.Shapes.Ellipse { Width = side * .62, Height = side * .62, Fill = Brushes.White });
            grid.Children.Add(new Border { Width = side * .24, Height = side * .24, CornerRadius = new CornerRadius(side * .04), Background = new SolidColorBrush(tint) });
        }
        else
        {
            var glyph = new TextBlock { Text = SettingsPageInfo.Glyph(page), FontSize = side * .52, Foreground = Brushes.White, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
            glyph.FontFamily = page == SettingsPage.Ai ? new FontFamily("Segoe UI Symbol") : Icons;
            grid.Children.Add(glyph);
        }
        return grid;
    }

    // SettingsPageHeader: 56pt tile, title2 bold, one-line detail.
    public static StackPanel Header(SettingsPage page)
    {
        var stack = new StackPanel { HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 6, 0, 10) };
        var tile = Tile(page, 56); tile.HorizontalAlignment = HorizontalAlignment.Center; stack.Children.Add(tile);
        var title = Text(SettingsPageInfo.Title(page), 22, Ink, FontWeights.Bold, new Thickness(0, 8, 0, 0)); title.HorizontalAlignment = HorizontalAlignment.Center; stack.Children.Add(title);
        var detail = Text(SettingsPageInfo.Detail(page), 14, Secondary, null, new Thickness(0, 8, 0, 0)); detail.TextAlignment = TextAlignment.Center; detail.HorizontalAlignment = HorizontalAlignment.Center; stack.Children.Add(detail);
        return stack;
    }

    // bellCard(): the white rounded card of the card-style pages.
    public static Border Card(UIElement content) => new()
    {
        Child = content, Background = new SolidColorBrush(Color.FromArgb(0xE8, 255, 255, 255)), CornerRadius = new CornerRadius(24), Padding = new Thickness(20),
        BorderBrush = new SolidColorBrush(Color.FromArgb(0xA6, 0xE5, 0xE3, 0xF0)), BorderThickness = new Thickness(1),
        Effect = new DropShadowEffect { Color = Color.FromRgb(0x21, 0x29, 0x3D), Opacity = .05, BlurRadius = 16, ShadowDepth = 8, Direction = 270 }
    };

    // Form-style section: small caption, a white group, a footer.
    public static StackPanel FormSection(string? header, UIElement group, string? footer = null)
    {
        var section = new StackPanel { Margin = new Thickness(0, 14, 0, 0) };
        if (header is not null) section.Children.Add(Text(header, 13, Secondary, FontWeights.SemiBold, new Thickness(20, 0, 0, 7)));
        section.Children.Add(group);
        if (footer is not null) section.Children.Add(Text(footer, 14, Secondary, null, new Thickness(20, 8, 20, 0)));
        return section;
    }

    public static TextBlock Banner(string message)
    {
        var line = new TextBlock { TextWrapping = TextWrapping.Wrap, Foreground = Red, FontSize = 14, Margin = new Thickness(0, 6, 0, 0) };
        line.Inlines.Add(new System.Windows.Documents.Run(" ") { FontFamily = Icons }); line.Inlines.Add(message); return line;
    }

    public static Border Row(UIElement content, double minHeight = 46)
    {
        if (content is FrameworkElement element && element.VerticalAlignment == VerticalAlignment.Stretch) element.VerticalAlignment = VerticalAlignment.Center;
        return new() { Child = content, MinHeight = minHeight, Padding = new Thickness(20, 8, 20, 8) };
    }
    public static Grid LabeledRow(string label, string value, Brush? valueColor = null)
    {
        var grid = new Grid { VerticalAlignment = VerticalAlignment.Center };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto }); grid.ColumnDefinitions.Add(new ColumnDefinition());
        grid.Children.Add(Text(label, 13));
        var text = Text(value, 13, valueColor ?? Secondary); text.HorizontalAlignment = HorizontalAlignment.Right; text.TextAlignment = TextAlignment.Right; text.Margin = new Thickness(16, 0, 0, 0); Grid.SetColumn(text, 1); grid.Children.Add(text);
        return grid;
    }
    public static Grid IconButtonRow(string glyph, string label, Brush color, Action? click)
    {
        var grid = new Grid { Background = Brushes.Transparent, Cursor = click is null ? null : System.Windows.Input.Cursors.Hand, VerticalAlignment = VerticalAlignment.Center, Opacity = click is null ? .45 : 1 };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(30) }); grid.ColumnDefinitions.Add(new ColumnDefinition());
        grid.Children.Add(Glyph(glyph, 14, color)); var text = Text(label, 13, color, null); text.VerticalAlignment = VerticalAlignment.Center; Grid.SetColumn(text, 1); grid.Children.Add(text);
        if (click is not null) grid.MouseLeftButtonUp += (_, _) => click();
        System.Windows.Automation.AutomationProperties.SetName(grid, label);
        return grid;
    }

    public static Button Capsule(string label, Brush background, Brush foreground, double radius = 16, double fontSize = 13, Thickness? padding = null)
    {
        var template = (ControlTemplate)XamlReader.Parse(
            $"<ControlTemplate xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\" TargetType=\"Button\"><Border x:Name=\"Chrome\" xmlns:x=\"http://schemas.microsoft.com/winfx/2006/xaml\" Background=\"{{TemplateBinding Background}}\" CornerRadius=\"{radius}\" Padding=\"{{TemplateBinding Padding}}\"><ContentPresenter HorizontalAlignment=\"Center\" VerticalAlignment=\"Center\"/></Border><ControlTemplate.Triggers><Trigger Property=\"IsMouseOver\" Value=\"True\"><Setter TargetName=\"Chrome\" Property=\"Opacity\" Value=\"0.8\"/></Trigger><Trigger Property=\"IsEnabled\" Value=\"False\"><Setter TargetName=\"Chrome\" Property=\"Opacity\" Value=\"0.4\"/></Trigger></ControlTemplate.Triggers></ControlTemplate>");
        return new Button { Content = label, Template = template, Background = background, Foreground = foreground, FontSize = fontSize, FontWeight = FontWeights.SemiBold, Padding = padding ?? new Thickness(12, 5, 12, 5), Margin = new Thickness(0), Cursor = System.Windows.Input.Cursors.Hand };
    }

    public static ToggleButton Switch(string onColor)
    {
        var template = (ControlTemplate)XamlReader.Parse(
            $"<ControlTemplate xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\" xmlns:x=\"http://schemas.microsoft.com/winfx/2006/xaml\" TargetType=\"ToggleButton\"><Grid x:Name=\"Root\" Width=\"42\" Height=\"26\"><Border x:Name=\"Track\" CornerRadius=\"13\" Background=\"#E5E5EA\"/><Ellipse x:Name=\"Knob\" Width=\"22\" Height=\"22\" Fill=\"White\" HorizontalAlignment=\"Left\" Margin=\"2,0,0,0\"><Ellipse.Effect><DropShadowEffect Opacity=\"0.25\" BlurRadius=\"3\" ShadowDepth=\"1\"/></Ellipse.Effect></Ellipse></Grid><ControlTemplate.Triggers><Trigger Property=\"IsChecked\" Value=\"True\"><Setter TargetName=\"Track\" Property=\"Background\" Value=\"{onColor}\"/><Setter TargetName=\"Knob\" Property=\"HorizontalAlignment\" Value=\"Right\"/><Setter TargetName=\"Knob\" Property=\"Margin\" Value=\"0,0,2,0\"/></Trigger><Trigger Property=\"IsEnabled\" Value=\"False\"><Setter TargetName=\"Root\" Property=\"Opacity\" Value=\"0.5\"/></Trigger></ControlTemplate.Triggers></ControlTemplate>");
        return new ToggleButton { Template = template, Cursor = System.Windows.Input.Cursors.Hand, Margin = new Thickness(0), VerticalAlignment = VerticalAlignment.Center };
    }

    // Borderless text box whose hint is the field label, as in a Mac Form TextField.
    public static (Grid Element, TextBox Box) Field(string hint, string value, bool multiline = false, double minHeight = 0)
    {
        var box = new TextBox
        {
            Style = null, Text = value, FontSize = 13, Foreground = Ink, Background = Brushes.Transparent, BorderThickness = new Thickness(0), Padding = new Thickness(0), CaretBrush = Ink,
            AcceptsReturn = multiline, TextWrapping = multiline ? TextWrapping.Wrap : TextWrapping.NoWrap, MinHeight = minHeight, VerticalContentAlignment = VerticalAlignment.Top, VerticalAlignment = VerticalAlignment.Center
        };
        if (multiline) box.VerticalScrollBarVisibility = ScrollBarVisibility.Auto;
        System.Windows.Automation.AutomationProperties.SetName(box, hint);
        var grid = new Grid(); grid.Children.Add(box);
        var placeholder = new TextBlock { Text = hint, FontSize = 13, Foreground = Secondary, IsHitTestVisible = false, VerticalAlignment = box.VerticalAlignment };
        void Sync() => placeholder.Visibility = box.Text.Length == 0 ? Visibility.Visible : Visibility.Collapsed;
        box.TextChanged += (_, _) => Sync(); Sync(); grid.Children.Add(placeholder);
        return (grid, box);
    }
}

// White rounded group whose rows are separated by hairlines; rows can be added, hidden and removed after creation.
internal sealed class GroupCard : Border
{
    private readonly StackPanel rows = new();
    private readonly List<(UIElement Row, StackPanel Holder, Border Line)> items = [];
    public GroupCard() { Background = Brushes.White; CornerRadius = new CornerRadius(10); Child = rows; }
    public GroupCard(params UIElement[] initial) : this() { foreach (var row in initial) Add(row); }
    public void Add(UIElement row) => Insert(items.Count, row);
    public int Count => items.Count;
    public void Insert(int index, UIElement row)
    {
        var line = new Border { Height = 1, Background = SettingsUi.Hairline, Margin = new Thickness(20, 0, 0, 0) };
        var holder = new StackPanel(); holder.Children.Add(line); holder.Children.Add(row);
        rows.Children.Insert(index, holder); items.Insert(index, (row, holder, line)); Refresh();
    }
    public void Remove(UIElement row)
    {
        var index = items.FindIndex(item => item.Row == row); if (index < 0) return;
        rows.Children.RemoveAt(index); items.RemoveAt(index); Refresh();
    }
    public void Clear() { rows.Children.Clear(); items.Clear(); }
    // A hidden row takes its separator with it; the first row shown never has one.
    public void SetVisible(UIElement row, bool visible)
    {
        var index = items.FindIndex(item => item.Row == row); if (index < 0) return;
        items[index].Holder.Visibility = visible ? Visibility.Visible : Visibility.Collapsed; Refresh();
    }
    private void Refresh()
    {
        var first = true;
        foreach (var item in items)
        {
            if (item.Holder.Visibility != Visibility.Visible) continue;
            item.Line.Visibility = first ? Visibility.Collapsed : Visibility.Visible; first = false;
        }
    }
}
