using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Controls.Primitives;
using Avalonia.Input;
using Avalonia.Layout;
using Avalonia.Media;

namespace BellTeam.Linux;

public enum SettingsPage { Profile, Ai, Terminals, Features, Notifications, Connection, Display, Billing, Update, About, Stop }

// Category list content of the Mac SettingsView (SettingsPage enum), copied verbatim from the Windows app.
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
    public static string Glyph(SettingsPage page) => page switch
    {
        SettingsPage.Profile => SettingsIcons.Person, SettingsPage.Ai => Icons.Sparkle, SettingsPage.Terminals => SettingsIcons.Laptop, SettingsPage.Features => SettingsIcons.Sliders, SettingsPage.Notifications => SettingsIcons.Bell, SettingsPage.Connection => SettingsIcons.Globe,
        SettingsPage.Display => SettingsIcons.Display, SettingsPage.Billing => SettingsIcons.Card, SettingsPage.Update => SettingsIcons.Download, SettingsPage.About => SettingsIcons.Info, _ => ""
    };
    public static Color Tint(SettingsPage page) => page switch
    {
        SettingsPage.Profile => Color.FromRgb(0x61, 0x47, 0xD4), SettingsPage.Ai => Color.FromRgb(0xAF, 0x52, 0xDE), SettingsPage.Terminals => Color.FromRgb(0x32, 0xAD, 0xE6), SettingsPage.Features => Color.FromRgb(0xFF, 0x95, 0x00),
        SettingsPage.Notifications => Color.FromRgb(0xFF, 0x3B, 0x30), SettingsPage.Connection => Color.FromRgb(0x00, 0x7A, 0xFF), SettingsPage.Display => Color.FromRgb(0x58, 0x56, 0xD6),
        SettingsPage.Billing => Color.FromRgb(0x34, 0xC7, 0x59), SettingsPage.Update => Color.FromRgb(0x30, 0xB0, 0xC7), SettingsPage.About => Color.FromRgb(0x8E, 0x8E, 0x93), _ => Color.FromRgb(0xFF, 0x3B, 0x30)
    };
}

// Segoe Fluent glyphs do not exist on Linux: the symbols the settings pages need, as stroked vector icons on the 24x24 canvas of Icons.
public static class SettingsIcons
{
    public const string Person = "M12,4 a4,4 0 1 0 0.01,0 Z M4.5,20.5 C4.5,15.5 8,13.5 12,13.5 C16,13.5 19.5,15.5 19.5,20.5";
    public const string Laptop = "M5,6 H19 V16 H5 Z M2.5,19.5 H21.5";
    public const string Sliders = "M4,7 H20 M4,17 H20 M9,4.5 V9.5 M15,14.5 V19.5";
    public const string Bell = "M6,16.5 V11 a6,6 0 0 1 12,0 V16.5 L19.5,18.5 H4.5 Z M10,21 a2,2 0 0 0 4,0";
    public const string Globe = "M12,3 a9,9 0 1 0 0.01,0 Z M3,12 H21 M12,3 C8,7 8,17 12,21 M12,3 C16,7 16,17 12,21";
    public const string Display = "M4,5 H20 V16 H4 Z M9,20 H15 M12,16 V20";
    public const string Card = "M3,6 H21 V18 H3 Z M3,10 H21 M6,15 H10";
    public const string Download = "M12,3 a9,9 0 1 0 0.01,0 Z M12,7.5 V15.5 M8.5,12 L12,15.5 L15.5,12";
    public const string Info = "M12,3 a9,9 0 1 0 0.01,0 Z M12,11 V16.5 M12,7.6 V8";
    public const string Key = "M8,14 a3.5,3.5 0 1 0 0.01,0 Z M10.5,11.5 L20,2.5 M17,5.5 L19.5,8 M14,8.5 L16,10.5";
    public const string Ring = "M12,4 a8,8 0 1 0 0.01,0 Z";
    public const string Waiting = "M12,3 a9,9 0 1 0 0.01,0 Z M12,7 V12 L15.5,14";
    public const string Bolt = "M13.5,3 L5,13.5 H11.5 L10.5,21 L19,10 H12.5 Z";
    public const string Shield = "M12,3 L20,6 V12 C20,16.5 16.5,19.5 12,21 C7.5,19.5 4,16.5 4,12 V6 Z";
    public const string ShieldOk = Shield + " M8.5,12 L11,14.5 L15.5,9.5";
    public const string ShieldWarn = Shield + " M12,8 V13 M12,15.8 V16";
    public const string Remove = "M12,3 a9,9 0 1 0 0.01,0 Z M7.5,12 H16.5";
    public const string Trash = "M4,7 H20 M9,7 V4 H15 V7 M6,7 L7,20 H17 L18,7 M10,11 V16 M14,11 V16";
    public const string SignOut = "M10,4 H5 V20 H10 M14,8 L18,12 L14,16 M18,12 H8";
    public const string List = "M4,6 H8 M11,6 H20 M4,12 H8 M11,12 H20 M4,18 H8 M11,18 H20";
    public const string Refresh = "M4,12 a8,8 0 0 1 14,-5 L20,9 M20,4 V9 H15 M20,12 a8,8 0 0 1 -14,5 L4,15 M4,20 V15 H9";
}

// Building blocks of the Mac-style settings pages: icon tiles, grouped cards, rows and buttons (Windows SettingsUi).
internal static class SettingsUi
{
    private static IBrush Solid(string hex) => new Avalonia.Media.Immutable.ImmutableSolidColorBrush(Color.Parse(hex));
    public static readonly IBrush Ink = BellTheme.Ink, Muted = BellTheme.Muted, Secondary = BellTheme.Secondary, Violet = BellTheme.Violet, Red = BellTheme.Red, Green = Solid("#34C759"), Orange = Solid("#FF9500");
    public static readonly IBrush Canvas = Solid("#F2F2F7"), Hairline = Solid("#E6E6EB"), Fill = Solid("#F0F0F4");
    public static readonly Cursor Hand = new(StandardCursorType.Hand);

    // The default browser (xdg-open through the shell execute of .NET on Linux); a failure is said by the caller.
    public static void OpenExternal(string url, Action<string> failed)
    {
        try { System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(url) { UseShellExecute = true }); }
        catch (Exception error) { failed("ページを開けませんでした。" + error.Message); }
    }

    public static TextBlock Text(string text, double size = 13, IBrush? color = null, FontWeight? weight = null, Thickness? margin = null)
        => new() { Text = text, FontSize = size, Foreground = color ?? Ink, FontWeight = weight ?? FontWeight.Normal, TextWrapping = TextWrapping.Wrap, Margin = margin ?? default };
    public static Control Glyph(string path, double size, IBrush? color = null, bool filled = false) => Icons.Draw(path, size, color ?? Ink, filled, 1.7);

    public static Control Tile(SettingsPage page, double side)
    {
        var tint = SettingsPageInfo.Tint(page);
        var light = Color.FromRgb((byte)(tint.R + (255 - tint.R) * .2), (byte)(tint.G + (255 - tint.G) * .2), (byte)(tint.B + (255 - tint.B) * .2));
        var grid = new Grid { Width = side, Height = side };
        grid.Children.Add(new Border { CornerRadius = new CornerRadius(side * .24), Background = new LinearGradientBrush { StartPoint = new RelativePoint(.5, 0, RelativeUnit.Relative), EndPoint = new RelativePoint(.5, 1, RelativeUnit.Relative), GradientStops = [new GradientStop(light, 0), new GradientStop(tint, 1)] } });
        if (page == SettingsPage.Stop)
        {
            // stop.circle.fill: white disc with a tinted square.
            grid.Children.Add(new Avalonia.Controls.Shapes.Ellipse { Width = side * .62, Height = side * .62, Fill = Brushes.White });
            grid.Children.Add(new Border { Width = side * .24, Height = side * .24, CornerRadius = new CornerRadius(side * .04), Background = new SolidColorBrush(tint) });
        }
        else
        {
            var glyph = Icons.Draw(SettingsPageInfo.Glyph(page), side * .56, Brushes.White, page == SettingsPage.Ai, page == SettingsPage.Ai ? 0 : 1.7);
            glyph.HorizontalAlignment = HorizontalAlignment.Center; grid.Children.Add(glyph);
        }
        return grid;
    }

    // SettingsPageHeader: 56pt tile, title2 bold, one-line detail.
    public static StackPanel Header(SettingsPage page)
    {
        var stack = new StackPanel { HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 6, 0, 10) };
        var tile = Tile(page, 56); tile.HorizontalAlignment = HorizontalAlignment.Center; stack.Children.Add(tile);
        var title = Text(SettingsPageInfo.Title(page), 22, Ink, FontWeight.Bold, new Thickness(0, 8, 0, 0)); title.HorizontalAlignment = HorizontalAlignment.Center; stack.Children.Add(title);
        var detail = Text(SettingsPageInfo.Detail(page), 14, Secondary, null, new Thickness(0, 8, 0, 0)); detail.TextAlignment = TextAlignment.Center; detail.HorizontalAlignment = HorizontalAlignment.Center; stack.Children.Add(detail);
        return stack;
    }

    // bellCard(): the white rounded card of the card-style pages.
    public static Border Card(Control content) => new()
    {
        Child = content, Background = new SolidColorBrush(Color.FromArgb(0xE8, 255, 255, 255)), CornerRadius = new CornerRadius(24), Padding = new Thickness(20),
        BorderBrush = new SolidColorBrush(Color.FromArgb(0xA6, 0xE5, 0xE3, 0xF0)), BorderThickness = new Thickness(1), BoxShadow = BoxShadows.Parse("0 8 16 0 #0D21293D")
    };

    // Form-style section: small caption, a white group, a footer.
    public static StackPanel FormSection(string? header, Control group, string? footer = null)
    {
        var section = new StackPanel { Margin = new Thickness(0, 14, 0, 0) };
        if (header is not null) section.Children.Add(Text(header, 13, Secondary, FontWeight.SemiBold, new Thickness(20, 0, 0, 7)));
        section.Children.Add(group);
        if (footer is not null) section.Children.Add(Text(footer, 14, Secondary, null, new Thickness(20, 8, 20, 0)));
        return section;
    }

    public static Control Banner(string message)
    {
        var icon = Icons.Draw(Icons.Warning, 14, Red, thickness: 1.7); icon.VerticalAlignment = VerticalAlignment.Top; icon.Margin = new Thickness(0, 2, 6, 0);
        var line = new DockPanel { Margin = new Thickness(0, 6, 0, 0) };
        DockPanel.SetDock(icon, Dock.Left); line.Children.Add(icon); line.Children.Add(Text(message, 14, Red));
        return line;
    }

    public static Border Row(Control content, double minHeight = 46)
    {
        if (content.VerticalAlignment == VerticalAlignment.Stretch) content.VerticalAlignment = VerticalAlignment.Center;
        return new() { Child = content, MinHeight = minHeight, Padding = new Thickness(20, 8) };
    }
    public static Grid LabeledRow(string label, string value, IBrush? valueColor = null)
    {
        var grid = new Grid { VerticalAlignment = VerticalAlignment.Center, ColumnDefinitions = new ColumnDefinitions("Auto,*") };
        grid.Children.Add(Text(label, 13));
        var text = Text(value, 13, valueColor ?? Secondary); text.HorizontalAlignment = HorizontalAlignment.Right; text.TextAlignment = TextAlignment.Right; text.Margin = new Thickness(16, 0, 0, 0); Grid.SetColumn(text, 1); grid.Children.Add(text);
        return grid;
    }
    public static Grid IconButtonRow(string glyph, string label, IBrush color, Action? click)
    {
        var grid = new Grid { Background = Brushes.Transparent, Cursor = click is null ? null : Hand, VerticalAlignment = VerticalAlignment.Center, Opacity = click is null ? .45 : 1, ColumnDefinitions = new ColumnDefinitions("30,*") };
        var icon = Glyph(glyph, 16, color); icon.HorizontalAlignment = HorizontalAlignment.Left; grid.Children.Add(icon);
        var text = Text(label, 13, color); text.VerticalAlignment = VerticalAlignment.Center; Grid.SetColumn(text, 1); grid.Children.Add(text);
        if (click is not null) grid.PointerReleased += (_, args) => { if (args.InitialPressMouseButton == MouseButton.Left) click(); };
        AutomationProperties.SetName(grid, label);
        return grid;
    }

    public static Button Capsule(string label, IBrush background, IBrush foreground, double radius = 16, double fontSize = 13, Thickness? padding = null)
    {
        var button = new Button { Classes = { "plain" }, Content = label, Background = background, Foreground = foreground, FontSize = fontSize, FontWeight = FontWeight.SemiBold, CornerRadius = new CornerRadius(radius), Padding = padding ?? new Thickness(12, 5), Margin = default, HorizontalContentAlignment = HorizontalAlignment.Center, VerticalContentAlignment = VerticalAlignment.Center };
        AutomationProperties.SetName(button, label); return button;
    }

    // Fluent paints a checked CheckBox or RadioButton in the system accent; the Mac app uses the brand violet.
    public static T Violeted<T>(T control) where T : Control
    {
        foreach (var key in new[] { "CheckBoxCheckBackgroundFillChecked", "CheckBoxCheckBackgroundFillCheckedPointerOver", "CheckBoxCheckBackgroundFillCheckedPressed", "CheckBoxCheckBackgroundStrokeChecked", "CheckBoxCheckBackgroundStrokeCheckedPointerOver", "CheckBoxCheckBackgroundStrokeCheckedPressed",
            "RadioButtonOuterEllipseCheckedFill", "RadioButtonOuterEllipseCheckedFillPointerOver", "RadioButtonOuterEllipseCheckedFillPressed", "RadioButtonOuterEllipseCheckedStroke", "RadioButtonOuterEllipseCheckedStrokePointerOver", "RadioButtonOuterEllipseCheckedStrokePressed" })
            control.Resources[key] = Violet;
        return control;
    }

    public static SwitchToggle Switch(string onColor) => new(Color.Parse(onColor));

    // Borderless text box whose hint is the field label, as in a Mac Form TextField.
    public static (Grid Element, TextBox Box) Field(string hint, string value, bool multiline = false, double minHeight = 0)
    {
        var box = new TextBox
        {
            Classes = { "bare" }, Text = value, FontSize = 13, PlaceholderText = hint, PlaceholderForeground = Secondary, CaretBrush = Ink, AcceptsReturn = multiline, TextWrapping = multiline ? TextWrapping.Wrap : TextWrapping.NoWrap,
            MinHeight = minHeight, VerticalContentAlignment = multiline ? VerticalAlignment.Top : VerticalAlignment.Center, VerticalAlignment = VerticalAlignment.Center
        };
        AutomationProperties.SetName(box, hint);
        return (new Grid { Children = { box } }, box);
    }
    // A secret field: the typed characters are masked and never revealed.
    public static TextBox SecretBox(string name) { var box = new TextBox { Classes = { "bare" }, PasswordChar = '•', FontSize = 13, VerticalAlignment = VerticalAlignment.Center, CaretBrush = Ink }; AutomationProperties.SetName(box, name); return box; }
}

// The Mac Toggle(.switch): a 42x26 track with a white knob.
internal sealed class SwitchToggle : Control
{
    private readonly Color on;
    public SwitchToggle(Color on) { this.on = on; Width = 42; Height = 26; Focusable = true; Cursor = SettingsUi.Hand; VerticalAlignment = VerticalAlignment.Center; HorizontalAlignment = HorizontalAlignment.Right; }
    public static readonly StyledProperty<bool> IsCheckedProperty = AvaloniaProperty.Register<SwitchToggle, bool>(nameof(IsChecked));
    public bool IsChecked { get => GetValue(IsCheckedProperty); set => SetValue(IsCheckedProperty, value); }
    public event EventHandler? Click;
    static SwitchToggle()
    {
        AffectsRender<SwitchToggle>(IsCheckedProperty, IsEnabledProperty);
        IsEnabledProperty.Changed.AddClassHandler<SwitchToggle>((toggle, _) => toggle.Opacity = toggle.IsEnabled ? 1 : .5);
    }
    public override void Render(DrawingContext context)
    {
        context.DrawRectangle(new SolidColorBrush(IsChecked ? on : Color.Parse("#E5E5EA")), null, new RoundedRect(new Rect(0, 0, 42, 26), 13));
        context.DrawEllipse(Brushes.White, new Pen(new SolidColorBrush(Color.FromArgb(40, 0, 0, 0)), 1), new Point(IsChecked ? 29 : 13, 13), 11, 11);
    }
    private void Toggle() { if (!IsEnabled) return; IsChecked = !IsChecked; Click?.Invoke(this, EventArgs.Empty); }
    protected override void OnPointerReleased(PointerReleasedEventArgs e) { base.OnPointerReleased(e); if (e.InitialPressMouseButton == MouseButton.Left && new Rect(Bounds.Size).Contains(e.GetPosition(this))) Toggle(); }
    protected override void OnKeyDown(KeyEventArgs e) { base.OnKeyDown(e); if (e.Key is Key.Space or Key.Enter) { Toggle(); e.Handled = true; } }
}

// White rounded group whose rows are separated by hairlines; rows can be added, hidden and removed after creation.
internal sealed class GroupCard : Border
{
    private readonly StackPanel rows = new();
    private readonly List<(Control Row, StackPanel Holder, Border Line)> items = [];
    public GroupCard() { Background = Brushes.White; CornerRadius = new CornerRadius(10); Child = rows; }
    public GroupCard(params Control[] initial) : this() { foreach (var row in initial) Add(row); }
    public void Add(Control row) => Insert(items.Count, row);
    public int Count => items.Count;
    public void Insert(int index, Control row)
    {
        var line = new Border { Height = 1, Background = SettingsUi.Hairline, Margin = new Thickness(20, 0, 0, 0) };
        var holder = new StackPanel { Children = { line, row } };
        rows.Children.Insert(index, holder); items.Insert(index, (row, holder, line)); Refresh();
    }
    public void Remove(Control row)
    {
        var index = items.FindIndex(item => item.Row == row); if (index < 0) return;
        rows.Children.RemoveAt(index); items.RemoveAt(index); Refresh();
    }
    public void Clear() { rows.Children.Clear(); items.Clear(); }
    // A hidden row takes its separator with it; the first row shown never has one.
    public void SetVisible(Control row, bool visible)
    {
        var index = items.FindIndex(item => item.Row == row); if (index < 0) return;
        items[index].Holder.IsVisible = visible; Refresh();
    }
    private void Refresh()
    {
        var first = true;
        foreach (var item in items)
        {
            if (!item.Holder.IsVisible) continue;
            item.Line.IsVisible = !first; first = false;
        }
    }
}
