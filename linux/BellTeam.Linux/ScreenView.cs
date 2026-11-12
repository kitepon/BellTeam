using System.ComponentModel;
using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Controls.Primitives;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Threading;
using BellTeam.Core;
using Shapes = Avalonia.Controls.Shapes;

namespace BellTeam.Linux;

// Mac DesktopInspector screen header + BotScreenView (black terminal, status line) + ScreenKeyBar (keys, digits row, approval banner, notice).
public sealed class ScreenView : Grid
{
    private static IBrush Solid(Color color) => new Avalonia.Media.Immutable.ImmutableSolidColorBrush(color);
    private static readonly IBrush Black = Solid(Colors.Black), BarBackground = Solid(Color.FromRgb(0x17, 0x17, 0x17)), KeyTint = Solid(Color.FromArgb(0x24, 255, 255, 255)), Deny = Solid(Color.FromArgb(0x29, 255, 255, 255)),
        Hairline = Solid(Color.FromArgb(0x1F, 255, 255, 255)), Destructive = Solid(Color.FromRgb(0xDB, 0x3B, 0x38)), Amber = Solid(BellColors.Accent("amber")), AmberFill = Solid(Color.FromArgb(0x2E, 232, 158, 71)),
        AmberLine = Solid(Color.FromArgb(0xB3, 232, 158, 71)), NoticeRed = Solid(Color.FromRgb(0xFF, 0x45, 0x3A));

    private readonly LinuxWorkspace workspace;
    // Selectable and read-only, in a scroller of its own so the view can follow the bottom the way the Mac text view does.
    private readonly SelectableTextBlock terminal = new() { Foreground = Brushes.White, FontFamily = BellTheme.Mono, FontSize = 12, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(16) };
    private readonly ScrollViewer scroller = new() { VerticalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled };
    private readonly Border bar = new() { Background = BarBackground, IsVisible = false };
    private readonly Border statusLine = new() { Background = Black, Padding = new Thickness(10) };
    private readonly TextBlock title = new() { FontSize = 17, FontWeight = FontWeight.SemiBold, TextTrimming = TextTrimming.CharacterEllipsis, VerticalAlignment = VerticalAlignment.Center, Foreground = BellTheme.Ink, HorizontalAlignment = HorizontalAlignment.Right };
    private ScreenInputModel? input;
    private string? barState;
    private bool showDigits;

    public ScreenView(LinuxWorkspace workspace)
    {
        this.workspace = workspace;
        RowDefinitions = new RowDefinitions("Auto,*,Auto,Auto");
        var back = InspectorUi.Bordered("プロフィールに戻る", InspectorIcons.Left, size: 14); back.HorizontalAlignment = HorizontalAlignment.Left; back.Margin = new Thickness(0, 0, 12, 0); back.Click += (_, _) => workspace.ReturnToProfile();
        var header = new DockPanel { Margin = new Thickness(16) }; DockPanel.SetDock(back, Dock.Left); header.Children.Add(back); header.Children.Add(title);
        AutomationProperties.SetName(terminal, "Botの画面");
        scroller.Content = terminal;
        var body = new Border { Background = Black, Child = scroller };
        SetRow(header, 0); SetRow(body, 1); SetRow(bar, 2); SetRow(statusLine, 3);
        Children.Add(header); Children.Add(body); Children.Add(bar); Children.Add(statusLine);
        workspace.PropertyChanged += Updated;
        Refresh();
    }

    private void Updated(object? sender, PropertyChangedEventArgs args)
    {
        if (args.PropertyName is not (nameof(LinuxWorkspace.Screen) or nameof(LinuxWorkspace.ScreenStatus) or nameof(LinuxWorkspace.ScreenOnline) or nameof(LinuxWorkspace.ScreenInput) or nameof(LinuxWorkspace.ScreenVisible) or nameof(LinuxWorkspace.Selected))) return;
        if (Dispatcher.UIThread.CheckAccess()) Refresh(); else Dispatcher.UIThread.Post(Refresh);
    }

    // Render seam: the digits row opened (Mac ScreenKeyBar(digitsOpen:)).
    public void OpenDigitsForRender() { showDigits = true; RenderBar(); }
    // Render seam: a state a GET-only mock cannot reach (a key just sent: the check mark).
    public void ShowSentForRender(string key) { if (input is not null) { input.MarkSentForRender(key); Refresh(); } }
    public void FollowBottomForRender() { scroller.UpdateLayout(); scroller.ScrollToEnd(); }

    private void Refresh()
    {
        if (!ReferenceEquals(input, workspace.ScreenInput))
        {
            if (input is not null) input.Changed -= RenderBarOnUi;
            input = workspace.ScreenInput; barState = null; showDigits = false;
            if (input is not null) input.Changed += RenderBarOnUi;
        }
        title.Text = (workspace.Selected?.Name ?? "") + "の画面";
        ShowText(workspace.Screen);
        var line = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Center };
        line.Children.Add(new Shapes.Ellipse { Width = 7, Height = 7, Fill = workspace.ScreenOnline ? BellTheme.Mint : BellTheme.Muted, Margin = new Thickness(0, 0, 7, 0), VerticalAlignment = VerticalAlignment.Center });
        line.Children.Add(new TextBlock { Text = workspace.ScreenStatus, FontSize = 13, Foreground = workspace.ScreenError is null ? Brushes.White : BellTheme.Red, TextWrapping = TextWrapping.Wrap, VerticalAlignment = VerticalAlignment.Center });
        statusLine.Child = line;
        RenderBar();
    }
    private void RenderBarOnUi() { if (Dispatcher.UIThread.CheckAccess()) RenderBar(); else Dispatcher.UIThread.Post(RenderBar); }

    // Mac BotTerminalTextView.show: follow the bottom unless the owner scrolled up; an unchanged text leaves selection and scroll alone.
    private void ShowText(string value)
    {
        if (terminal.Text == value) return;
        var oldOffset = scroller.Offset.Y;
        var follow = scroller.Extent.Height <= scroller.Viewport.Height || oldOffset + scroller.Viewport.Height >= scroller.Extent.Height - 28;
        terminal.Text = value;
        scroller.UpdateLayout();
        var end = Math.Max(0, scroller.Extent.Height - scroller.Viewport.Height);
        scroller.Offset = new Vector(0, follow ? end : Math.Min(oldOffset, end));
    }

    private void RenderBar()
    {
        if (input is not { Available: true } model) { bar.IsVisible = false; barState = null; return; }
        // The bar is rebuilt only when something it shows changed: a build every second would swallow a click between press and release.
        var state = string.Join('\u0003', model.SendingKey, model.SentKey, model.Notice, model.Banner?.Key, showDigits);
        if (state == barState) return;
        barState = state;
        var column = new StackPanel { Margin = new Thickness(12) };
        if (model.Banner is { IsRequired: true } approval) column.Children.Add(Spaced(Banner(model, approval)));
        if (model.Notice is { } notice) column.Children.Add(Spaced(Notice(notice)));
        column.Children.Add(Spaced(Row(8, Key(model, "Escape", "取消", Symbol(Icons.Close), KeyTint, false), Key(model, "Tab", "Tab", TabIcon(), KeyTint, false), Key(model, "Enter", "決定", EnterIcon(), BellTheme.Violet, false), Key(model, "C-c", "中断", StopIcon(), Destructive, false))));
        var toggle = Plain(ToggleCap(showDigits), "数字"); toggle.Click += (_, _) => { showDigits = !showDigits; barState = null; RenderBar(); };
        column.Children.Add(Spaced(Row(8, Key(model, "Left", "左", Symbol(InspectorIcons.Left), KeyTint, true), Key(model, "Up", "上", Symbol(InspectorIcons.Up), KeyTint, true), Key(model, "Down", "下", Symbol(InspectorIcons.Down), KeyTint, true), Key(model, "Right", "右", Symbol(InspectorIcons.Right), KeyTint, true), toggle)));
        if (showDigits) column.Children.Add(Spaced(Row(5, Enumerable.Range(0, 10).Select(digit => Digit(model, digit.ToString())).ToArray())));
        column.Children[0].Margin = new Thickness(0);
        // The hairline is a row of its own: a translucent border would show the window behind it.
        var frame = new StackPanel(); frame.Children.Add(new Border { Height = 1, Background = Hairline }); frame.Children.Add(column);
        bar.Child = frame; bar.IsVisible = true;
    }
    private static Control Spaced(Control item) { item.Margin = new Thickness(0, 10, 0, 0); return item; }
    private static Grid Row(double gap, params Control[] items)
    {
        var row = new Grid();
        for (var index = 0; index < items.Length; index++)
        {
            if (index != 0) row.ColumnDefinitions.Add(new ColumnDefinition(new GridLength(gap)));
            row.ColumnDefinitions.Add(new ColumnDefinition(GridLength.Star));
            SetColumn(items[index], index * 2); row.Children.Add(items[index]);
        }
        return row;
    }
    private static Button Plain(Control content, string name) => InspectorUi.Plain(content, name);
    private static Control Symbol(string data, double size = 17) { var icon = Icons.Draw(data, size, Brushes.White, thickness: 2.2); icon.HorizontalAlignment = HorizontalAlignment.Center; return icon; }
    private static Shapes.Path Stroke(string data, double width, double height) => new() { Data = StreamGeometry.Parse(data), Stroke = Brushes.White, StrokeThickness = 2, StrokeLineCap = PenLineCap.Round, StrokeJoin = PenLineJoin.Round, Width = width, Height = height, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
    private static Control TabIcon() => Stroke("M1,8 H15 M11,4 L15,8 L11,12 M19,3 V13", 20, 17);
    private static Control EnterIcon() => Stroke("M17,2 V9 H3 M7,5 L3,9 L7,13", 20, 17);
    private static Control StopIcon() => new Border { Width = 15, Height = 15, CornerRadius = new CornerRadius(2.5), Background = Brushes.White, HorizontalAlignment = HorizontalAlignment.Center };

    // Mac KeyCapStyle: 52 pt tall (44 compact), 10 pt corners; KeyCapLabelStyle: icon over a caption2 label.
    private static Border CapOf(Control content, IBrush tint, bool compact) => new() { Background = tint, CornerRadius = new CornerRadius(10), MinHeight = compact ? 44 : 52, Child = content };
    private Button Key(ScreenInputModel model, string id, string label, Control icon, IBrush tint, bool compact)
    {
        var caption = new StackPanel { VerticalAlignment = VerticalAlignment.Center, Opacity = model.SendingKey == id ? 0 : 1 };
        caption.Children.Add(model.SentKey == id ? Symbol(Icons.Check) : icon);
        caption.Children.Add(new TextBlock { Text = label, FontSize = 11, FontWeight = FontWeight.Medium, Foreground = Brushes.White, HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 3, 0, 0) });
        var content = new Grid(); content.Children.Add(caption);
        if (model.SendingKey == id) content.Children.Add(new Spinner(Brushes.White, 16) { HorizontalAlignment = HorizontalAlignment.Center });
        var button = Plain(CapOf(content, tint, compact), label); button.IsEnabled = model.SendingKey is null;
        button.Click += async (_, _) => await model.SendKeyAsync(id);
        return button;
    }
    private static Control ToggleCap(bool open)
    {
        var content = new StackPanel { VerticalAlignment = VerticalAlignment.Center };
        // Mac: "number" while closed, "chevron.down" while the digits row is open.
        content.Children.Add(open ? Symbol(Icons.ChevronDown) : new TextBlock { Text = "#", FontSize = 20, FontWeight = FontWeight.Bold, Foreground = Brushes.White, HorizontalAlignment = HorizontalAlignment.Center, LineHeight = 17 });
        content.Children.Add(new TextBlock { Text = "数字", FontSize = 11, FontWeight = FontWeight.Medium, Foreground = Brushes.White, HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 3, 0, 0) });
        return CapOf(content, KeyTint, true);
    }
    private Button Digit(ScreenInputModel model, string id)
    {
        var content = new Grid { VerticalAlignment = VerticalAlignment.Center };
        content.Children.Add(new TextBlock { Text = id, FontSize = 17, FontWeight = FontWeight.SemiBold, Foreground = Brushes.White, HorizontalAlignment = HorizontalAlignment.Center, Opacity = model.SendingKey == id ? 0 : 1 });
        if (model.SendingKey == id) content.Children.Add(new Spinner(Brushes.White, 16) { HorizontalAlignment = HorizontalAlignment.Center });
        var button = Plain(CapOf(content, KeyTint, true), "数字" + id); button.IsEnabled = model.SendingKey is null;
        button.Click += async (_, _) => await model.SendKeyAsync(id);
        return button;
    }
    private static Control Notice(string text)
    {
        var line = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
        line.Children.Add(Icons.Draw(Icons.Warning, 15, NoticeRed, thickness: 2));
        line.Children.Add(new TextBlock { Text = text, FontSize = 13, Foreground = NoticeRed, TextWrapping = TextWrapping.Wrap, VerticalAlignment = VerticalAlignment.Center });
        AutomationProperties.SetName(line, text); return line;
    }
    private Control Banner(ScreenInputModel model, ScreenApproval approval)
    {
        var column = new StackPanel();
        var head = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
        head.Children.Add(Icons.Draw(InspectorIcons.Hand, 16, Amber, filled: true, thickness: 0));
        head.Children.Add(new TextBlock { Text = "許可を求められています", FontSize = 15, FontWeight = FontWeight.SemiBold, Foreground = Amber, VerticalAlignment = VerticalAlignment.Center });
        column.Children.Add(head);
        var buttons = Row(8, approval.Choices!.Select(choice => Choice(model, choice)).ToArray()); buttons.Margin = new Thickness(0, 10, 0, 0); column.Children.Add(buttons);
        return new Border { Background = AmberFill, BorderBrush = AmberLine, BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(14), Padding = new Thickness(12), Child = column };
    }
    private Button Choice(ScreenInputModel model, ScreenApprovalChoice choice)
    {
        var approve = choice.Decision == "approve_once"; var id = "approval:" + choice.Decision;
        var line = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
        if (model.SendingKey == id) line.Children.Add(new Spinner(Brushes.White, 16) { Margin = new Thickness(0, 0, 6, 0) });
        else line.Children.Add(Disc(approve, model.SentKey == id));
        line.Children.Add(new TextBlock { Text = choice.Label, FontSize = 16, FontWeight = FontWeight.SemiBold, Foreground = Brushes.White, TextWrapping = TextWrapping.Wrap, TextAlignment = TextAlignment.Center, VerticalAlignment = VerticalAlignment.Center, MaxWidth = 220 });
        var chip = new Border { Background = approve ? BellTheme.Mint : Deny, CornerRadius = new CornerRadius(12), MinHeight = 44, Padding = new Thickness(8, 0), Child = line };
        var button = Plain(chip, choice.Label); button.IsEnabled = model.SendingKey is null;
        button.Click += async (_, _) => await model.RespondAsync(choice.Decision);
        return button;
    }
    // check.circle.fill / xmark.circle.fill: a white disc with the mark cut out in the button colour; the sent check is a bare mark.
    private static Control Disc(bool approve, bool bare)
    {
        if (bare) { var mark = Icons.Draw(Icons.Check, 15, Brushes.White, thickness: 3); mark.Margin = new Thickness(0, 0, 6, 0); return mark; }
        var grid = new Grid { Width = 19, Height = 19, Margin = new Thickness(0, 0, 8, 0), VerticalAlignment = VerticalAlignment.Center };
        grid.Children.Add(new Shapes.Ellipse { Fill = Brushes.White });
        grid.Children.Add(Icons.Draw(approve ? Icons.Check : Icons.Close, 10, approve ? BellTheme.Mint : new SolidColorBrush(Color.FromRgb(0x4A, 0x44, 0x40)), thickness: 3.2));
        return grid;
    }
}
