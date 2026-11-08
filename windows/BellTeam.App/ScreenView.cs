using System.ComponentModel;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Shapes;
using BellTeam.Core;

namespace BellTeam.App;

// Mac DesktopInspector screen header + BotScreenView (black terminal, status line) + ScreenKeyBar (keys, digits row, approval banner, notice).
public sealed class ScreenView : Grid
{
    public static readonly DependencyProperty WorkspaceProperty = DependencyProperty.Register(nameof(Workspace), typeof(Workspace), typeof(ScreenView), new PropertyMetadata(null, WorkspaceChanged));
    public Workspace? Workspace { get => (Workspace?)GetValue(WorkspaceProperty); set => SetValue(WorkspaceProperty, value); }
    private static readonly Brush Black = Frozen(Colors.Black), BarBackground = Frozen(Color.FromRgb(0x17, 0x17, 0x17)), KeyTint = Frozen(Color.FromArgb(0x24, 255, 255, 255)), Deny = Frozen(Color.FromArgb(0x29, 255, 255, 255)),
        Hairline = Frozen(Color.FromArgb(0x1F, 255, 255, 255)), Destructive = Frozen(Color.FromRgb(0xDB, 0x3B, 0x38)), Amber = Frozen(BellColors.Accent("amber")), AmberFill = Frozen(Color.FromArgb(0x2E, 232, 158, 71)),
        AmberLine = Frozen(Color.FromArgb(0xB3, 232, 158, 71)), NoticeRed = Frozen(Color.FromRgb(0xFF, 0x45, 0x3A));
    private static Brush Frozen(Color color) { var brush = new SolidColorBrush(color); brush.Freeze(); return brush; }
    private static readonly FontFamily Symbols = new("Segoe Fluent Icons, Segoe MDL2 Assets");

    private readonly TextBox terminal = new();
    private readonly Border bar = new() { Background = BarBackground, Visibility = Visibility.Collapsed };
    private readonly Border statusLine = new() { Background = Black, Padding = new Thickness(10) };
    private readonly TextBlock title = new() { FontSize = 17, FontWeight = FontWeights.SemiBold, TextTrimming = TextTrimming.CharacterEllipsis, VerticalAlignment = VerticalAlignment.Center, Foreground = InspectorUi.Ink };
    private ScreenInputModel? input;
    private string? barState;
    private bool showDigits;

    public ScreenView()
    {
        RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto }); RowDefinitions.Add(new RowDefinition()); RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto }); RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        var back = InspectorUi.Bordered("プロフィールに戻る", "", size: 14); back.HorizontalAlignment = HorizontalAlignment.Left; back.Margin = new Thickness(0, 0, 12, 0); back.Click += (_, _) => Workspace?.ReturnToProfile();
        var header = new DockPanel { Margin = new Thickness(16) }; DockPanel.SetDock(back, Dock.Left); header.Children.Add(back); header.Children.Add(title);
        title.HorizontalAlignment = HorizontalAlignment.Right;
        terminal.Background = Brushes.Transparent; terminal.Foreground = Brushes.White; terminal.FontFamily = new FontFamily("Cascadia Mono, Consolas"); terminal.FontSize = 12; terminal.IsReadOnly = true; terminal.AcceptsReturn = true;
        terminal.TextWrapping = TextWrapping.Wrap; terminal.BorderThickness = new Thickness(0); terminal.Padding = new Thickness(16); terminal.VerticalScrollBarVisibility = ScrollBarVisibility.Auto; terminal.HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled;
        terminal.IsInactiveSelectionHighlightEnabled = true;
        System.Windows.Automation.AutomationProperties.SetName(terminal, "Botの画面");
        var body = new Border { Background = Black, Child = terminal };
        SetRow(header, 0); SetRow(body, 1); SetRow(bar, 2); SetRow(statusLine, 3);
        Children.Add(header); Children.Add(body); Children.Add(bar); Children.Add(statusLine);
    }

    private static void WorkspaceChanged(DependencyObject target, DependencyPropertyChangedEventArgs args)
    {
        var view = (ScreenView)target;
        if (args.OldValue is Workspace old) old.PropertyChanged -= view.Updated;
        if (args.NewValue is Workspace next) next.PropertyChanged += view.Updated;
        view.Refresh();
    }
    private void Updated(object? sender, PropertyChangedEventArgs args)
    {
        if (args.PropertyName is nameof(BellTeam.App.Workspace.Screen) or nameof(BellTeam.App.Workspace.ScreenStatus) or nameof(BellTeam.App.Workspace.ScreenOnline) or nameof(BellTeam.App.Workspace.ScreenInput) or nameof(BellTeam.App.Workspace.ScreenVisible) or nameof(BellTeam.App.Workspace.Selected)) Refresh();
    }

    // Render seam: the digits row opened (Mac ScreenKeyBar(digitsOpen:)).
    public void OpenDigitsForRender() { showDigits = true; RenderBar(); }
    // Render seam: a state a GET-only mock cannot reach (a key just sent: the check mark).
    public void ShowSentForRender(string key) { if (input is not null) { input.MarkSentForRender(key); Refresh(); } }
    public void FollowBottomForRender() { terminal.ApplyTemplate(); terminal.UpdateLayout(); terminal.ScrollToEnd(); }

    private void Refresh()
    {
        if (Workspace is not { } workspace) return;
        if (!ReferenceEquals(input, workspace.ScreenInput))
        {
            if (input is not null) input.Changed -= RenderBar;
            input = workspace.ScreenInput; barState = null; showDigits = false;
            if (input is not null) input.Changed += RenderBar;
        }
        title.Text = (workspace.Selected?.Name ?? "") + "の画面";
        ShowText(workspace.Screen);
        var line = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Center };
        line.Children.Add(new Ellipse { Width = 7, Height = 7, Fill = workspace.ScreenOnline ? InspectorUi.Mint : InspectorUi.Muted, Margin = new Thickness(0, 0, 7, 0), VerticalAlignment = VerticalAlignment.Center });
        line.Children.Add(new TextBlock { Text = workspace.ScreenStatus, FontSize = 13, Foreground = workspace.ScreenError is null ? Brushes.White : InspectorUi.Red, TextWrapping = TextWrapping.Wrap, VerticalAlignment = VerticalAlignment.Center });
        statusLine.Child = line;
        RenderBar();
    }

    // Mac BotTerminalTextView.show: follow the bottom unless the owner scrolled up; an unchanged text leaves selection and scroll alone.
    private void ShowText(string value)
    {
        if (terminal.Text == value) return;
        terminal.ApplyTemplate();
        var host = terminal.Template.FindName("PART_ContentHost", terminal) as ScrollViewer;
        var oldOffset = host?.VerticalOffset ?? 0;
        var follow = host is null || host.ExtentHeight <= host.ViewportHeight || oldOffset + host.ViewportHeight >= host.ExtentHeight - 28;
        terminal.Text = value;
        if (host is null) return;
        terminal.UpdateLayout();
        host.ScrollToVerticalOffset(follow ? host.ScrollableHeight : Math.Min(oldOffset, host.ScrollableHeight));
    }

    private void RenderBar()
    {
        if (input is not { Available: true } model) { bar.Visibility = Visibility.Collapsed; barState = null; return; }
        // The bar is rebuilt only when something it shows changed: a build every second would swallow a click between press and release.
        var state = string.Join('\u0003', model.SendingKey, model.SentKey, model.Notice, model.Banner?.Key, showDigits);
        if (state == barState) return;
        barState = state;
        var column = new StackPanel { Margin = new Thickness(12) };
        if (model.Banner is { IsRequired: true } approval) column.Children.Add(Spaced(Banner(model, approval)));
        if (model.Notice is { } notice) column.Children.Add(Spaced(Notice(notice)));
        column.Children.Add(Spaced(Row(8, Key(model, "Escape", "取消", Glyph(""), KeyTint, false), Key(model, "Tab", "Tab", TabIcon(), KeyTint, false), Key(model, "Enter", "決定", EnterIcon(), InspectorUi.Violet, false), Key(model, "C-c", "中断", StopIcon(), Destructive, false))));
        var toggle = Plain(ToggleCap(showDigits), "数字"); toggle.Click += (_, _) => { showDigits = !showDigits; barState = null; RenderBar(); };
        column.Children.Add(Spaced(Row(8, Key(model, "Left", "左", Glyph(""), KeyTint, true), Key(model, "Up", "上", Glyph(""), KeyTint, true), Key(model, "Down", "下", Glyph(""), KeyTint, true), Key(model, "Right", "右", Glyph(""), KeyTint, true), toggle)));
        if (showDigits) column.Children.Add(Spaced(Row(5, Enumerable.Range(0, 10).Select(digit => Digit(model, digit.ToString())).ToArray())));
        column.Children[0].SetValue(MarginProperty, new Thickness(0));
        // The hairline is a row of its own: a translucent border would show the window behind it.
        var frame = new StackPanel(); frame.Children.Add(new Rectangle { Height = 1, Fill = Hairline }); frame.Children.Add(column);
        bar.Child = frame; bar.Visibility = Visibility.Visible;
    }
    private static UIElement Spaced(UIElement item) { if (item is FrameworkElement element) element.Margin = new Thickness(0, 10, 0, 0); return item; }
    private static Grid Row(double gap, params UIElement[] items)
    {
        var row = new Grid();
        for (var index = 0; index < items.Length; index++)
        {
            if (index != 0) row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(gap) });
            row.ColumnDefinitions.Add(new ColumnDefinition());
            SetColumn(items[index], index * 2); row.Children.Add(items[index]);
        }
        return row;
    }
    private static Button Plain(UIElement content, string name) => InspectorUi.Plain(content, name);
    private static TextBlock Glyph(string glyph, double size = 17) => new() { Text = glyph, FontFamily = Symbols, FontSize = size, FontWeight = FontWeights.SemiBold, Foreground = Brushes.White, HorizontalAlignment = HorizontalAlignment.Center };
    private static Path Stroke(string data, double width, double height) => new() { Data = Geometry.Parse(data), Stroke = Brushes.White, StrokeThickness = 2, StrokeStartLineCap = PenLineCap.Round, StrokeEndLineCap = PenLineCap.Round, StrokeLineJoin = PenLineJoin.Round, Width = width, Height = height, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
    private static UIElement TabIcon() => Stroke("M1,8 H15 M11,4 L15,8 L11,12 M19,3 V13", 20, 17);
    private static UIElement EnterIcon() => Stroke("M17,2 V9 H3 M7,5 L3,9 L7,13", 20, 17);
    private static UIElement StopIcon() => new Border { Width = 15, Height = 15, CornerRadius = new CornerRadius(2.5), Background = Brushes.White, HorizontalAlignment = HorizontalAlignment.Center };

    // Mac KeyCapStyle: 52 pt tall (44 compact), 10 pt corners; KeyCapLabelStyle: icon over a caption2 label.
    private static Border CapOf(UIElement content, Brush tint, bool compact) => new() { Background = tint, CornerRadius = new CornerRadius(10), MinHeight = compact ? 44 : 52, Child = content };
    private Button Key(ScreenInputModel model, string id, string label, UIElement icon, Brush tint, bool compact)
    {
        var caption = new StackPanel { VerticalAlignment = VerticalAlignment.Center, Opacity = model.SendingKey == id ? 0 : 1 };
        caption.Children.Add(model.SentKey == id ? Glyph("") : icon);
        caption.Children.Add(new TextBlock { Text = label, FontSize = 11, FontWeight = FontWeights.Medium, Foreground = Brushes.White, HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 3, 0, 0) });
        var content = new Grid(); content.Children.Add(caption);
        if (model.SendingKey == id) content.Children.Add(new Spinner { Stroke = Brushes.White, Width = 16, Height = 16, HorizontalAlignment = HorizontalAlignment.Center });
        var button = Plain(CapOf(content, tint, compact), label); button.IsEnabled = model.SendingKey is null;
        button.Click += async (_, _) => await model.SendKeyAsync(id);
        return button;
    }
    private static UIElement ToggleCap(bool open)
    {
        var content = new StackPanel { VerticalAlignment = VerticalAlignment.Center };
        // Mac: "number" while closed, "chevron.down" while the digits row is open.
        content.Children.Add(open ? Glyph("") : new TextBlock { Text = "#", FontSize = 20, FontWeight = FontWeights.Bold, Foreground = Brushes.White, HorizontalAlignment = HorizontalAlignment.Center, LineHeight = 17, LineStackingStrategy = LineStackingStrategy.BlockLineHeight });
        content.Children.Add(new TextBlock { Text = "数字", FontSize = 11, FontWeight = FontWeights.Medium, Foreground = Brushes.White, HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 3, 0, 0) });
        return CapOf(content, KeyTint, true);
    }
    private Button Digit(ScreenInputModel model, string id)
    {
        var content = new Grid { VerticalAlignment = VerticalAlignment.Center };
        content.Children.Add(new TextBlock { Text = id, FontSize = 17, FontWeight = FontWeights.SemiBold, Foreground = Brushes.White, HorizontalAlignment = HorizontalAlignment.Center, Opacity = model.SendingKey == id ? 0 : 1 });
        if (model.SendingKey == id) content.Children.Add(new Spinner { Stroke = Brushes.White, Width = 16, Height = 16, HorizontalAlignment = HorizontalAlignment.Center });
        var button = Plain(CapOf(content, KeyTint, true), "数字" + id); button.IsEnabled = model.SendingKey is null;
        button.Click += async (_, _) => await model.SendKeyAsync(id);
        return button;
    }
    private static UIElement Notice(string text)
    {
        var line = new StackPanel { Orientation = Orientation.Horizontal };
        line.Children.Add(new TextBlock { Text = "", FontFamily = Symbols, FontSize = 14, Foreground = NoticeRed, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, 0, 8, 0) });
        line.Children.Add(new TextBlock { Text = text, FontSize = 13, Foreground = NoticeRed, TextWrapping = TextWrapping.Wrap, VerticalAlignment = VerticalAlignment.Center });
        System.Windows.Automation.AutomationProperties.SetName(line, text); return line;
    }
    private UIElement Banner(ScreenInputModel model, ScreenApproval approval)
    {
        var column = new StackPanel();
        var head = new StackPanel { Orientation = Orientation.Horizontal };
        head.Children.Add(new TextBlock { Text = "✋", FontFamily = new FontFamily("Segoe UI Symbol"), FontSize = 15, Foreground = Amber, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, 0, 8, 0) });
        head.Children.Add(new TextBlock { Text = "許可を求められています", FontSize = 15, FontWeight = FontWeights.SemiBold, Foreground = Amber, VerticalAlignment = VerticalAlignment.Center });
        column.Children.Add(head);
        var buttons = Row(8, approval.Choices!.Select(choice => Choice(model, choice)).ToArray()); buttons.Margin = new Thickness(0, 10, 0, 0); column.Children.Add(buttons);
        return new Border { Background = AmberFill, BorderBrush = AmberLine, BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(14), Padding = new Thickness(12), Child = column };
    }
    private Button Choice(ScreenInputModel model, ScreenApprovalChoice choice)
    {
        var approve = choice.Decision == "approve_once"; var id = "approval:" + choice.Decision;
        var line = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
        if (model.SendingKey == id) line.Children.Add(new Spinner { Stroke = Brushes.White, Width = 16, Height = 16, Margin = new Thickness(0, 0, 6, 0) });
        else line.Children.Add(Disc(model.SentKey == id ? "" : approve ? "" : "", approve, model.SentKey == id));
        line.Children.Add(new TextBlock { Text = choice.Label, FontSize = 16, FontWeight = FontWeights.SemiBold, Foreground = Brushes.White, TextWrapping = TextWrapping.Wrap, TextAlignment = TextAlignment.Center, VerticalAlignment = VerticalAlignment.Center, MaxWidth = 220 });
        var chip = new Border { Background = approve ? InspectorUi.Mint : Deny, CornerRadius = new CornerRadius(12), MinHeight = 44, Padding = new Thickness(8, 0, 8, 0), Child = line };
        var button = Plain(chip, choice.Label); button.IsEnabled = model.SendingKey is null;
        button.Click += async (_, _) => await model.RespondAsync(choice.Decision);
        return button;
    }
    // check.circle.fill / xmark.circle.fill: a white disc with the mark cut out in the button colour; the sent check is a bare mark.
    private static UIElement Disc(string glyph, bool approve, bool bare)
    {
        if (bare) return new TextBlock { Text = glyph, FontFamily = Symbols, FontSize = 15, FontWeight = FontWeights.Bold, Foreground = Brushes.White, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, 0, 6, 0) };
        var grid = new Grid { Width = 19, Height = 19, Margin = new Thickness(0, 0, 8, 0), VerticalAlignment = VerticalAlignment.Center };
        grid.Children.Add(new Ellipse { Fill = Brushes.White });
        grid.Children.Add(new TextBlock { Text = glyph, FontFamily = Symbols, FontSize = 10, FontWeight = FontWeights.Bold, Foreground = approve ? InspectorUi.Mint : new SolidColorBrush(Color.FromRgb(0x4A, 0x44, 0x40)), HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center });
        return grid;
    }
}
