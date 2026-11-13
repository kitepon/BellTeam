using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Markup;
using System.Windows.Media;
using System.Windows.Media.Effects;

namespace BellTeam.App;

// The settings items live in Core (SettingsPages: titles, calm lines, groups); this adds the Windows icon and tint (Mac symbol / tint).
public static class SettingsPageInfo
{
    public static IReadOnlyList<SettingsPage[]> Groups => SettingsPages.Groups;
    public static string Title(SettingsPage page) => SettingsPages.Title(page);
    // Windows sells nothing in the app (the Mac line is about the App Store subscription), so 利用と課金 keeps the Windows line.
    public static string Detail(SettingsPage page) => page == SettingsPage.Billing ? "料金と、サーバーとAIの契約" : SettingsPages.Detail(page);
    // Segoe Fluent Icons code points standing in for the Mac SF Symbols.
    public static string Glyph(SettingsPage page) => page switch
    {
        SettingsPage.Profile => "\uE77B", SettingsPage.Ai => "\u2726", SettingsPage.Summary => "\uE8FD", SettingsPage.Terminals => "\uE7F4", SettingsPage.Exclusions => "\uE769", SettingsPage.OnePassword => "\uE8D7",
        SettingsPage.Notifications => "\uEA8F", SettingsPage.Rules => "\uE8A4", SettingsPage.Features => "\uEA86", SettingsPage.Connection => "\uE774",
        SettingsPage.Display => "\uE81E", SettingsPage.Billing => "\uE8C7", SettingsPage.Update => "\uE896", SettingsPage.About => "\uE946", _ => ""
    };
    public static Color Tint(SettingsPage page) => page switch
    {
        SettingsPage.Profile => Color.FromRgb(0x61, 0x47, 0xD4), SettingsPage.Ai => Color.FromRgb(0xAF, 0x52, 0xDE), SettingsPage.Summary => Color.FromRgb(0xFF, 0x2D, 0x55), SettingsPage.Terminals => Color.FromRgb(0x32, 0xAD, 0xE6), SettingsPage.Exclusions => Color.FromRgb(0x00, 0xC7, 0xBE),
        SettingsPage.OnePassword => Color.FromRgb(0x00, 0x7A, 0xFF), SettingsPage.Notifications => Color.FromRgb(0xFF, 0x3B, 0x30), SettingsPage.Rules => Color.FromRgb(0xA2, 0x84, 0x5E), SettingsPage.Features => Color.FromRgb(0xFF, 0x95, 0x00),
        SettingsPage.Connection => Color.FromRgb(0x00, 0x7A, 0xFF), SettingsPage.Display => Color.FromRgb(0x58, 0x56, 0xD6),
        SettingsPage.Billing => Color.FromRgb(0x34, 0xC7, 0x59), SettingsPage.Update => Color.FromRgb(0x30, 0xB0, 0xC7), SettingsPage.About => Color.FromRgb(0x8E, 0x8E, 0x93), _ => Color.FromRgb(0xFF, 0x3B, 0x30)
    };
}

// Building blocks of the Mac-style settings pages: icon tiles, grouped cards, rows and buttons.
internal static class SettingsUi
{
    private static SolidColorBrush Solid(string hex) { var brush = new SolidColorBrush((Color)ColorConverter.ConvertFromString(hex)); brush.Freeze(); return brush; }
    public static readonly Brush Ink = Solid("#21293D"), Muted = Solid("#787D91"), Secondary = Solid("#8A8A8E"), Violet = Solid("#6147D4"), Red = Solid("#FF3B30"), Green = Solid("#34C759"), Orange = Solid("#FF9500");
    public static readonly Brush Canvas = Solid("#F2F2F7"), Hairline = Solid("#E6E6EB"), Fill = Solid("#F0F0F4"), Selection = Solid("#E3E3E8");
    public static readonly FontFamily Icons = new("Segoe Fluent Icons, Segoe MDL2 Assets");

    public static TextBlock Text(string text, double size = 13, Brush? color = null, FontWeight? weight = null, Thickness? margin = null)
        => new() { Text = text, FontSize = size, Foreground = color ?? Ink, FontWeight = weight ?? FontWeights.Normal, TextWrapping = TextWrapping.Wrap, Margin = margin ?? new Thickness(0) };
    public static TextBlock Glyph(string glyph, double size, Brush? color = null) => new() { Text = glyph, FontFamily = Icons, FontSize = size, Foreground = color ?? Ink, VerticalAlignment = VerticalAlignment.Center };

    public static FrameworkElement Tile(SettingsPage page, double side) => Tile(page == SettingsPage.Stop ? null : SettingsPageInfo.Glyph(page), SettingsPageInfo.Tint(page), side, page == SettingsPage.Ai);
    // SettingsIconTile: a tinted rounded square with a white glyph; null glyph draws stop.circle.fill. symbol: the glyph is a Segoe UI Symbol character, not an icon-font one.
    public static FrameworkElement Tile(string? glyphText, Color tint, double side, bool symbol = false)
    {
        var light = Color.FromRgb((byte)(tint.R + (255 - tint.R) * .2), (byte)(tint.G + (255 - tint.G) * .2), (byte)(tint.B + (255 - tint.B) * .2));
        var grid = new Grid { Width = side, Height = side };
        grid.Children.Add(new Border { CornerRadius = new CornerRadius(side * .24), Background = new LinearGradientBrush(light, tint, 90) });
        if (glyphText is null)
        {
            // stop.circle.fill: white disc with a tinted square.
            grid.Children.Add(new System.Windows.Shapes.Ellipse { Width = side * .62, Height = side * .62, Fill = Brushes.White });
            grid.Children.Add(new Border { Width = side * .24, Height = side * .24, CornerRadius = new CornerRadius(side * .04), Background = new SolidColorBrush(tint) });
        }
        else
        {
            var glyph = new TextBlock { Text = glyphText, FontSize = side * .52, Foreground = Brushes.White, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
            glyph.FontFamily = symbol ? new FontFamily("Segoe UI Symbol") : Icons;
            grid.Children.Add(glyph);
        }
        return grid;
    }

    // SettingsPageHeader: 36pt tile, title, the state badge on the right, the item's live line under it.
    public static StackPanel Header(SettingsPage page, SettingsStatus? status = null)
    {
        status ??= new SettingsStatus(SettingsPageInfo.Detail(page));
        var stack = new StackPanel { Margin = new Thickness(0, 0, 0, 10) };
        var top = new Grid(); top.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto }); top.ColumnDefinitions.Add(new ColumnDefinition()); top.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        top.Children.Add(Tile(page, 36));
        var title = Text(SettingsPageInfo.Title(page), 20, Ink, FontWeights.Bold, new Thickness(12, 0, 8, 0)); title.VerticalAlignment = VerticalAlignment.Center; Grid.SetColumn(title, 1); top.Children.Add(title);
        if (status.Badge is { } text) { var badge = Badge(text, status.Tone); Grid.SetColumn(badge, 2); top.Children.Add(badge); }
        stack.Children.Add(top);
        var line = Text(status.Line, 14, Secondary, null, new Thickness(0, 10, 0, 0)); System.Windows.Automation.AutomationProperties.SetAutomationId(line, "settings-page-state"); stack.Children.Add(line);
        return stack;
    }

    public static Brush ToneBrush(SettingsTone tone) => tone switch { SettingsTone.Green => Green, SettingsTone.Violet => Violet, SettingsTone.Orange => Orange, _ => Muted };
    // BellBadge: the one state badge of the settings, a tinted capsule; a state word is never a bare coloured word.
    public static Border Badge(string text, SettingsTone tone, string? glyph = null)
    {
        var color = ((SolidColorBrush)ToneBrush(tone)).Color;
        var label = new TextBlock { FontSize = 11, FontWeight = FontWeights.SemiBold, Foreground = ToneBrush(tone), TextWrapping = TextWrapping.NoWrap };
        if (glyph is not null) label.Inlines.Add(new System.Windows.Documents.Run(glyph + " ") { FontFamily = Icons });
        label.Inlines.Add(text);
        var badge = new Border { Child = label, Background = new SolidColorBrush(Color.FromArgb(0x21, color.R, color.G, color.B)), CornerRadius = new CornerRadius(9), Padding = new Thickness(9, 3, 9, 3), VerticalAlignment = VerticalAlignment.Center };
        System.Windows.Automation.AutomationProperties.SetName(badge, text);
        return badge;
    }

    // SettingsMainButton: the one primary button of a page, filled violet with white text; while working its own label says so.
    public static Button MainButton(string label)
    {
        var button = Capsule(label, Violet, Brushes.White, 10, 14, new Thickness(18, 9, 18, 9)); button.HorizontalAlignment = HorizontalAlignment.Stretch; button.Margin = new Thickness(0, 12, 0, 0);
        return button;
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

    // A labeled switch row, as the other settings toggles (全体停止): the label on the left, the switch on the right.
    public static (Grid Row, ToggleButton Switch) SwitchRow(string label)
    {
        var toggle = Switch("#34C759"); System.Windows.Automation.AutomationProperties.SetName(toggle, label);
        var row = new Grid { VerticalAlignment = VerticalAlignment.Center }; row.ColumnDefinitions.Add(new ColumnDefinition()); row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var text = Text(label, 13); text.VerticalAlignment = VerticalAlignment.Center; row.Children.Add(text); Grid.SetColumn(toggle, 1); row.Children.Add(toggle);
        return (row, toggle);
    }

    // Borderless text box whose hint is the field label, as in a Mac Form TextField.
    public static (Grid Element, TextBox Box) Field(string hint, string value, bool multiline = false, double minHeight = 0, string? placeholder = null)
    {
        var box = new TextBox
        {
            Style = null, Text = value, FontSize = 13, Foreground = Ink, Background = Brushes.Transparent, BorderThickness = new Thickness(0), Padding = new Thickness(0), CaretBrush = Ink,
            AcceptsReturn = multiline, TextWrapping = multiline ? TextWrapping.Wrap : TextWrapping.NoWrap, MinHeight = minHeight, VerticalContentAlignment = VerticalAlignment.Top, VerticalAlignment = VerticalAlignment.Center
        };
        if (multiline) box.VerticalScrollBarVisibility = ScrollBarVisibility.Auto;
        System.Windows.Automation.AutomationProperties.SetName(box, hint);
        var grid = new Grid(); grid.Children.Add(box);
        var hintText = new TextBlock { Text = placeholder ?? hint, FontSize = 13, Foreground = Secondary, IsHitTestVisible = false, VerticalAlignment = multiline ? VerticalAlignment.Top : box.VerticalAlignment };
        void Sync() => hintText.Visibility = box.Text.Length == 0 ? Visibility.Visible : Visibility.Collapsed;
        box.TextChanged += (_, _) => Sync(); Sync(); grid.Children.Add(hintText);
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
