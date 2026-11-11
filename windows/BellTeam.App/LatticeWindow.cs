using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Animation;
using BellTeam.Core;
using static BellTeam.App.LatticeLook;

namespace BellTeam.App;

/// <summary>
/// The 工程表 window (screen-spec.md; Mac openWindow(id: "lattice")): its own window, one at a time, 一覧 then 工程表. Reads only while shown and not minimized;
/// the list every 10 s, the open chart over its SSE. Saves nothing: closing the window drops the drawing. Mica behind it where Windows offers it.
/// </summary>
public sealed class LatticeWindow : Window
{
    public static LatticeWindow? Current { get; private set; }
    public static LatticeWindow Open(Workspace workspace, Func<string, Task> openChat) => Current ??= new LatticeWindow(workspace, openChat);

    private readonly Workspace workspace;
    private readonly Func<string, Task> openChat;
    private readonly Grid root = new();
    private readonly ContentControl page = new();
    private readonly Border pill;
    private readonly TextBlock pillText = new() { FontSize = 13, Foreground = Brush(Ink), VerticalAlignment = VerticalAlignment.Center };
    internal Func<DateTimeOffset> Now { get; set; } = () => DateTimeOffset.UtcNow;
    internal Func<double>? Clock { get; set; }
    private string origin;
    private LatticeChartList? list;
    private string? listProblem;      // null, OldServer, Reconnecting or LoginRequired
    private bool autoOpened;
    private CancellationTokenSource? listLoop;
    internal LatticeChartPage? Chart { get; private set; }
    // The chart 一覧 was opened from (switcher): back returns to that same page, scroll position included (screen-spec state diagram List --> Chart: back).
    private LatticeChartPage? back;
    internal Task ListRead { get; private set; } = Task.CompletedTask;

    internal LatticeWindow(Workspace workspace, Func<string, Task> openChat)
    {
        this.workspace = workspace; this.openChat = openChat; origin = workspace.Server;
        Title = "工程表"; Width = 1360; Height = 860; MinWidth = 900; MinHeight = 600; UseLayoutRounding = true;
        SetResourceReference(StyleProperty, typeof(Window)); SetResourceReference(BackgroundProperty, "ConversationBackground");
        pill = Glass(Row(Spinner(14), Spaced(pillText, 8)), 99, new Thickness(14, 7, 16, 7), 0xF2);
        pill.HorizontalAlignment = HorizontalAlignment.Center; pill.VerticalAlignment = VerticalAlignment.Bottom; pill.Margin = new Thickness(0, 0, 0, 18); pill.Visibility = Visibility.Collapsed; pill.IsHitTestVisible = false;
        System.Windows.Automation.AutomationProperties.SetAutomationId(pillText, "lattice-list-status");
        root.Children.Add(page); root.Children.Add(pill); Content = root;
        Resources.Add(typeof(System.Windows.Controls.Primitives.ScrollBar), ThinScrollBar);
        ShowList();
        SourceInitialized += (_, _) => UseMica();
        IsVisibleChanged += (_, _) => Sync(); StateChanged += (_, _) => Sync();
        workspace.PropertyChanged += WorkspaceChanged;
        PreviewKeyDown += (_, e) => { if (e.Key == Key.Escape && (Chart?.CloseDetail() == true || (Chart is null && ReturnToChart()))) e.Handled = true; };
        Closed += (_, _) => { workspace.PropertyChanged -= WorkspaceChanged; StopAll(); if (ReferenceEquals(Current, this)) Current = null; };
    }

    private void WorkspaceChanged(object? sender, System.ComponentModel.PropertyChangedEventArgs args)
    {
        if (args.PropertyName != nameof(Workspace.Connected)) return;
        if (Dispatcher.CheckAccess()) Sync(); else Dispatcher.BeginInvoke(Sync);
    }

    internal Func<string, string, Task<System.Windows.Media.Imaging.BitmapSource>> Avatar
        => (id, version) => workspace.AvatarAsync($"{workspace.Server}api/bots/{Uri.EscapeDataString(id)}/avatar?v={Uri.EscapeDataString(version)}");
    internal LatticePerson? Roster(string botId)
        => workspace.Bots.FirstOrDefault(bot => bot.Id == botId) is { } bot ? new LatticePerson(bot.Id, bot.DisplayName, bot.Color, bot.AvatarVersion, true) : null;
    internal string? CoordinatorBotId => list is null ? null : LatticeChart.CoordinatorBotId(list);
    // Render seam: --render-lattice reads without showing the window.
    internal bool Rendering { get; set; }
    internal bool ListSettled => list is not null || listProblem is not null;
    private bool Wanted => (Rendering || IsVisible) && WindowState != WindowState.Minimized && workspace.Connected;

    /// <summary>Starts or stops reading for what is on screen. Another server drops everything drawn and starts at its list.</summary>
    internal void Sync()
    {
        if (origin != workspace.Server) { origin = workspace.Server; list = null; listProblem = null; autoOpened = false; back = null; ShowList(); }
        if (!Wanted) { StopAll(); return; }
        if (Chart is { } chart) { listLoop?.Cancel(); listLoop = null; if (!chart.Running) chart.Run(workspace.Management.Api, workspace.ConnectionToken); }
        else if (listLoop is null) { listLoop = CancellationTokenSource.CreateLinkedTokenSource(workspace.ConnectionToken); ListRead = ReadListAsync(listLoop); }
    }
    private void StopAll() { listLoop?.Cancel(); listLoop = null; Chart?.Stop(); }

    // The reader owns its source: released once it has finished, so hide/show and chart switches leave no registration on the connection token.
    private async Task ReadListAsync(CancellationTokenSource source)
    {
        try { await PollListAsync(source.Token); }
        finally { if (ReferenceEquals(listLoop, source)) listLoop = null; source.Dispose(); }
    }
    private async Task PollListAsync(CancellationToken token)
    {
        while (!token.IsCancellationRequested)
        {
            try
            {
                var next = await workspace.Management.Api.ChartsAsync(token);
                if (token.IsCancellationRequested) return;
                list = next; listProblem = null;
                if (!autoOpened && next.Charts.Length == 1) { autoOpened = true; OpenChart(next.Charts[0].ProjectId); return; }
                autoOpened = true;
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested) { return; }
            catch (BellApiException error) when (error.RequiresLogin) { listProblem = LatticeChart.LoginRequired; }
            catch (BellApiException error) when (error.Status == System.Net.HttpStatusCode.NotFound) { listProblem = LatticeChart.OldServer; list = null; }
            catch (Exception) { listProblem = LatticeChart.Reconnecting; }
            if (Chart is null) RenderList();
            try { await Task.Delay(TimeSpan.FromSeconds(10), token); } catch (OperationCanceledException) { return; }
        }
    }

    // MARK: 一覧

    internal void ShowList(bool fromChart = false)
    {
        back = fromChart ? Chart : null;
        Chart?.Stop(); Chart = null;
        RenderList(); Sync();
    }
    /// <summary>Back from 一覧 to the chart it was opened from (chevron + chart name, or Esc).</summary>
    internal bool ReturnToChart()
    {
        if (back is null) return false;
        listLoop?.Cancel(); listLoop = null; pill.Visibility = Visibility.Collapsed;
        Chart = back; back = null; page.Content = Chart; Chart.Render();
        Sync();
        return true;
    }
    private void RenderList()
    {
        pill.Visibility = listProblem == LatticeChart.Reconnecting && list is not null ? Visibility.Visible : Visibility.Collapsed; pillText.Text = listProblem ?? "";
        var body = new StackPanel { Margin = new Thickness(40, 30, 40, 40), MaxWidth = 1180 };
        var header = new DockPanel { Margin = new Thickness(0, 0, 0, 22) };
        if (back is not null)
        {
            var backButton = Plain(Glass(Row(Icon("", 12, Muted), Spaced(Text(back.ChartName, 15, Ink, FontWeights.SemiBold), 8)), 14, new Thickness(12, 8, 14, 8), 0xB3), $"{back.ChartName}へ戻る");
            backButton.Margin = new Thickness(0, 0, 18, 0); backButton.Click += (_, _) => ReturnToChart(); DockPanel.SetDock(backButton, Dock.Left);
            System.Windows.Automation.AutomationProperties.SetAutomationId(backButton, "lattice-back"); header.Children.Add(backButton);
        }
        header.Children.Add(Text("工程表", 28, Ink, FontWeights.Bold));
        body.Children.Add(header);
        if (list is null && listProblem is { } problem && problem != LatticeChart.Reconnecting)
        {
            body.Children.Add(Notice(problem, problem == LatticeChart.OldServer ? LatticeChart.OldServerNext : null, problem == LatticeChart.OldServer ? ("閉じる", Close) : null));
        }
        else if (list is null) body.Children.Add(Notice(listProblem ?? "読み込んでいます…", null, null));
        else if (list.Charts.Length == 0) body.Children.Add(Notice(LatticeChart.ListEmpty, null, ("閉じる", Close)));
        else
        {
            var items = LatticeChart.ListItems(list, Roster);
            var pinned = items.Where(item => item.Coordinator).ToList();
            if (pinned.Count > 0) { body.Children.Add(Section("ピン留め")); body.Children.Add(Cards(pinned, true)); }
            body.Children.Add(Section("すべての工程表"));
            var rest = Cards(items.Where(item => !item.Coordinator).ToList(), false);
            rest.Children.Add(NewChartCard()); body.Children.Add(rest);
        }
        page.Content = new ScrollViewer { Content = body, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, PanningMode = PanningMode.VerticalOnly };
    }
    private static TextBlock Section(string title) { var text = Text(title, 13, Muted, FontWeights.SemiBold); text.Margin = new Thickness(4, 6, 0, 10); return text; }
    private WrapPanel Cards(IReadOnlyList<LatticeListItem> items, bool wide)
    {
        var panel = new WrapPanel { Margin = new Thickness(0, 0, 0, 18) };
        foreach (var item in items) panel.Children.Add(ListCard(item, wide));
        return panel;
    }
    private Button ListCard(LatticeListItem item, bool wide)
    {
        var grid = new Grid(); grid.ColumnDefinitions.Add(new ColumnDefinition()); grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var left = new StackPanel();
        if (item.Coordinator) { var badge = CoordinatorBadge(); badge.HorizontalAlignment = HorizontalAlignment.Left; badge.Margin = new Thickness(0, 0, 0, 8); left.Children.Add(badge); }
        var name = Text(item.Name, wide ? 22 : 18, Ink, FontWeights.Bold); left.Children.Add(name);
        if (item.Updated.Length > 0) { var updated = Text(item.Updated + " JST", 12, Muted); updated.Margin = new Thickness(0, 4, 0, 12); left.Children.Add(updated); }
        var faces = new StackPanel { Orientation = Orientation.Horizontal };
        foreach (var (member, index) in item.Members.Select((member, index) => (member, index))) faces.Children.Add(new LatticeAvatar(member, 30, Avatar) { Margin = new Thickness(index == 0 ? 0 : -8, 0, 0, 0) });
        var waiting = Pill(Row(Shape(HourglassGeometry, 10, item.Waiting > 0 ? Violet : Muted), Spaced(Text($"待ち {item.Waiting}", 12, item.Waiting > 0 ? Violet : Muted, FontWeights.SemiBold), 5)), item.Waiting > 0 ? Violet : Muted, 0x1A);
        waiting.Margin = new Thickness(12, 0, 0, 0);
        left.Children.Add(Row(faces, waiting));
        grid.Children.Add(left);
        var ring = new LatticeRing(item.Done, item.Total, wide ? 64 : 52); Grid.SetColumn(ring, 1); ring.Margin = new Thickness(14, 0, 0, 0); grid.Children.Add(ring);
        var glass = Glass(grid, 20, new Thickness(20, 18, 20, 18)); glass.Width = wide ? 560 : 360; glass.Margin = new Thickness(0, 0, 16, 16);
        var button = Plain(glass, item.Label); button.Click += (_, _) => OpenChart(item.ProjectId);
        System.Windows.Automation.AutomationProperties.SetAutomationId(button, "lattice-chart-card");
        return button;
    }
    private static Border NewChartCard()
    {
        var body = new StackPanel();
        body.Children.Add(Row(Icon("", 14, Muted), Spaced(Text("新しい工程表", 16, Muted, FontWeights.SemiBold), 8)));
        var text = Text(LatticeChart.NewChart, 13, Muted, null, TextWrapping.Wrap); text.Margin = new Thickness(0, 8, 0, 0); body.Children.Add(text);
        var dashed = new Grid { Width = 360, Margin = new Thickness(0, 0, 16, 16) };
        dashed.Children.Add(new System.Windows.Shapes.Rectangle { RadiusX = 20, RadiusY = 20, Stroke = Brush(Muted, 0x80), StrokeThickness = 1.3, StrokeDashArray = [5, 4], Fill = Brush(Colors.White, 0x40) });
        dashed.Children.Add(new Border { Child = body, Padding = new Thickness(20, 18, 20, 18) });
        return new Border { Child = dashed };
    }
    /// <summary>An empty or failure view: what happened, what happens next, and the one optional action.</summary>
    internal static FrameworkElement Notice(string text, string? next, (string Label, Action Run)? action, bool bud = false)
    {
        var stack = new StackPanel { HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center, MaxWidth = 460, Margin = new Thickness(24, 60, 24, 24) };
        if (bud) { var image = new LatticeBud { Margin = new Thickness(0, 0, 0, 18) }; stack.Children.Add(image); }
        var main = Text(text, 18, Ink, FontWeights.SemiBold, TextWrapping.Wrap); main.TextAlignment = TextAlignment.Center; stack.Children.Add(main);
        System.Windows.Automation.AutomationProperties.SetAutomationId(main, "lattice-notice");
        if (next is not null) { var after = Text(next, 14, Muted, null, TextWrapping.Wrap); after.TextAlignment = TextAlignment.Center; after.Margin = new Thickness(0, 8, 0, 0); stack.Children.Add(after); }
        if (action is { } act) { var button = Action(act.Label, "", true); button.HorizontalAlignment = HorizontalAlignment.Center; button.Margin = new Thickness(0, 18, 0, 0); button.Click += (_, _) => act.Run(); stack.Children.Add(button); }
        return stack;
    }

    // MARK: 工程表

    internal void OpenChart(string projectId)
    {
        listLoop?.Cancel(); listLoop = null; pill.Visibility = Visibility.Collapsed;
        Chart?.Stop(); back = null;
        Chart = new LatticeChartPage(this, projectId, list?.Charts.FirstOrDefault(chart => chart.ProjectId == projectId));
        page.Content = Chart;
        Sync();
    }
    internal async Task OpenChatAsync(string botId)
    {
        try { await openChat(botId); }
        catch (Exception) { Chart?.Say("会話を開けませんでした。本体の窓からもう一度お試しください。"); }
    }

    // Fluent-style thin scroll bars: a rounded thumb on a clear track, no arrow buttons.
    private static readonly Style ThinScrollBar = (Style)System.Windows.Markup.XamlReader.Parse("""
        <Style xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" TargetType="ScrollBar">
          <Setter Property="Width" Value="10"/><Setter Property="MinWidth" Value="10"/><Setter Property="Background" Value="Transparent"/>
          <Setter Property="Template"><Setter.Value><ControlTemplate TargetType="ScrollBar"><Grid Background="Transparent"><Track x:Name="PART_Track" IsDirectionReversed="True"><Track.Thumb><Thumb><Thumb.Template><ControlTemplate TargetType="Thumb"><Border CornerRadius="3" Background="#40212938" Margin="2"/></ControlTemplate></Thumb.Template></Thumb></Track.Thumb></Track></Grid></ControlTemplate></Setter.Value></Setter>
          <Style.Triggers><Trigger Property="Orientation" Value="Horizontal"><Setter Property="Width" Value="Auto"/><Setter Property="MinWidth" Value="0"/><Setter Property="Height" Value="10"/><Setter Property="MinHeight" Value="10"/>
            <Setter Property="Template"><Setter.Value><ControlTemplate TargetType="ScrollBar"><Grid Background="Transparent"><Track x:Name="PART_Track" IsDirectionReversed="False"><Track.Thumb><Thumb><Thumb.Template><ControlTemplate TargetType="Thumb"><Border CornerRadius="3" Background="#40212938" Margin="2"/></ControlTemplate></Thumb.Template></Thumb></Track.Thumb></Track></Grid></ControlTemplate></Setter.Value></Setter></Trigger></Style.Triggers>
        </Style>
        """);

    // MARK: Mica

    [DllImport("dwmapi.dll")] private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);
    [DllImport("dwmapi.dll")] private static extern int DwmExtendFrameIntoClientArea(IntPtr hwnd, ref Margins margins);
    [StructLayout(LayoutKind.Sequential)] private struct Margins { public int Left, Right, Top, Bottom; }
    // Windows 11 22H2+ draws Mica behind the window; elsewhere the window keeps its own gradient (the same look, without the desktop tint).
    private void UseMica()
    {
        if (Environment.OSVersion.Version.Build < 22621) return;
        var handle = new WindowInteropHelper(this).Handle; var backdrop = 2; var margins = new Margins { Left = -1, Right = -1, Top = -1, Bottom = -1 };
        if (DwmExtendFrameIntoClientArea(handle, ref margins) != 0 || DwmSetWindowAttribute(handle, 38, ref backdrop, sizeof(int)) != 0) return;
        HwndSource.FromHwnd(handle).CompositionTarget.BackgroundColor = Colors.Transparent;
        Background = Brushes.Transparent;
        root.Background = new LinearGradientBrush(Color.FromArgb(0x99, 0xF1, 0xEC, 0xFF), Color.FromArgb(0x66, 0xFF, 0xFF, 0xFF), 45);
    }
}

/// <summary>One open chart: toolbar, banner, member rail, the tree or the swimlanes, 待ちの流れ and the detail sheet. Owns the feed while it is on screen.</summary>
internal sealed class LatticeChartPage : Grid
{
    private readonly LatticeWindow window;
    private readonly string projectId;
    private readonly LatticeChartSummary? summary;
    internal LatticeChartFeed Feed { get; } = new();
    private CancellationTokenSource? run;
    internal LatticeBoard Board { get; }
    internal LatticeTreeView Tree { get; }
    // ツリー / 担当: ツリー by default, remembered while the app is open (screen-spec "ツリー").
    internal static bool ShowTree { get; set; } = true;
    private readonly ScrollViewer scroller;
    private readonly Grid stage = new();
    private readonly StackPanel toolbar = new() { Orientation = Orientation.Horizontal };
    private readonly Border bannerHost = new();
    private readonly StackPanel rail = new() { Margin = new Thickness(0, 6, 0, 0) };
    private readonly StackPanel waits = new();
    private ScrollViewer? waitScroller;
    internal void ScrollWaitsToEnd() { waitScroller?.UpdateLayout(); waitScroller?.ScrollToEnd(); }
    private readonly Border waitPanel;
    private readonly Grid board = new();
    private readonly Grid overlay = new();
    private readonly StackPanel pills = new() { HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Top, Margin = new Thickness(0, 10, 0, 0) };
    // A short fade at the board's right edge: the next column reads as "more to the right", not as a cut card. Stops short of the vertical scroll bar.
    private readonly System.Windows.Shapes.Rectangle fade = new() { Width = 36, HorizontalAlignment = HorizontalAlignment.Right, Margin = new Thickness(0, 0, 10, 10), IsHitTestVisible = false,
        Fill = new LinearGradientBrush(Color.FromArgb(0, 0xF7, 0xF5, 0xFC), Color.FromArgb(0xF2, 0xF7, 0xF5, 0xFC), 0) };
    private readonly ContentControl detailHost = new() { HorizontalAlignment = HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Stretch, Margin = new Thickness(0, 12, 12, 12) };
    private string? said;
    internal string? SelectedCard { get; private set; }
    internal string? HighlightedMember { get; private set; }
    public bool Running { get; private set; }

    public LatticeChartPage(LatticeWindow window, string projectId, LatticeChartSummary? summary)
    {
        this.window = window; this.projectId = projectId; this.summary = summary;
        RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto }); RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto }); RowDefinitions.Add(new RowDefinition());
        var bar = new Border { Child = toolbar, Padding = new Thickness(18, 14, 18, 10) }; Children.Add(bar);
        SetRow(bannerHost, 1); Children.Add(bannerHost);
        Board = new LatticeBoard(window.Avatar);
        if (window.Clock is { } clock) Board.Clock = clock;
        Board.CardOpened += id => OpenDetail(id);
        Tree = new LatticeTreeView(window.Avatar);
        Tree.CardOpened += id => OpenDetail(id);
        scroller = new ScrollViewer { Content = ShowTree ? Tree : Board, HorizontalScrollBarVisibility = ScrollBarVisibility.Auto, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, PanningMode = PanningMode.Both, Padding = new Thickness(0, 4, 0, 0) };
        scroller.ScrollChanged += (_, e) => Board.ScrolledTo(e.HorizontalOffset);
        // A click on empty canvas clears the member highlight (screen-spec user path).
        scroller.PreviewMouseLeftButtonDown += (_, e) => { if (e.OriginalSource is ScrollViewer or LatticeBoard or LatticeTreeView or ScrollContentPresenter && HighlightedMember is not null) Highlight(null); };
        board.Children.Add(scroller); board.Children.Add(fade);
        stage.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(92) }); stage.ColumnDefinitions.Add(new ColumnDefinition()); stage.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(360) });
        var railGlass = Glass(new ScrollViewer { Content = rail, VerticalScrollBarVisibility = ScrollBarVisibility.Hidden }, 22, new Thickness(8, 12, 8, 12)); railGlass.Margin = new Thickness(14, 4, 4, 16); railGlass.VerticalAlignment = VerticalAlignment.Top;
        stage.Children.Add(railGlass);
        SetColumn(board, 1); board.Margin = new Thickness(4, 4, 6, 16); stage.Children.Add(board);
        var waitScroll = waitScroller = new ScrollViewer { Content = waits, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
        var waitBody = new DockPanel(); var heading = Row(Shape(HourglassGeometry, 13, Violet), Spaced(Text("待ちの流れ", 16, Ink, FontWeights.Bold), 8)); heading.Margin = new Thickness(4, 0, 0, 12); DockPanel.SetDock(heading, Dock.Top);
        waitBody.Children.Add(heading); waitBody.Children.Add(waitScroll);
        waitPanel = Glass(waitBody, 22, new Thickness(14, 16, 14, 12), 0xC7); waitPanel.Margin = new Thickness(6, 4, 16, 16);
        SetColumn(waitPanel, 2); stage.Children.Add(waitPanel);
        overlay.Children.Add(stage); overlay.Children.Add(pills);
        SetColumnSpan(detailHost, 1); board.Children.Add(detailHost);
        SetRow(overlay, 2); Children.Add(overlay);
        Feed.Changed += Render;
        Render();
    }

    public void Run(BellApi api, CancellationToken connection)
    {
        Running = true; run = CancellationTokenSource.CreateLinkedTokenSource(connection);
        _ = FollowAsync(api, run);
    }
    // A feed that ended on its own (not found, sign-in) stays "running" until Stop, as before; only its token source is released.
    private async Task FollowAsync(BellApi api, CancellationTokenSource source)
    {
        try { await Feed.RunAsync((onActivity, cancel) => api.LatticeEventsAsync(projectId, onActivity, cancel), source.Token); }
        finally { if (ReferenceEquals(run, source)) run = null; source.Dispose(); }
    }
    public void Stop() { Running = false; run?.Cancel(); run = null; }
    internal void Say(string text) { said = text; RenderPills(); }

    internal string ChartName => LatticeChart.ChartName(Feed.Snapshot?.Name ?? summary?.Name, Feed.Snapshot?.CreatedBy ?? summary?.CreatedBy, id => window.Roster(id)?.Name);
    private bool Coordinator => Feed.Snapshot?.Coordinator ?? summary?.Coordinator ?? false;
    private string? CoordinatorBotId => window.CoordinatorBotId ?? (Feed.Snapshot is { Coordinator: true, CreatedBy: { } creator } ? creator : null);

    internal void Render()
    {
        var snapshot = Feed.Snapshot; var now = window.Now();
        RenderToolbar(snapshot);
        bannerHost.Child = null;
        // Views that replace the chart: not found, not on this server, sign-in, not readable yet.
        FrameworkElement? replaced = Feed.Connection switch
        {
            LatticeConnection.NotFound => LatticeWindow.Notice(LatticeChart.NotFound, null, ("一覧へ戻る", () => window.ShowList())),
            LatticeConnection.Unsupported => LatticeWindow.Notice(LatticeChart.OldServer, LatticeChart.OldServerNext, ("閉じる", window.Close)),
            LatticeConnection.Login when snapshot is null => LatticeWindow.Notice(LatticeChart.LoginRequired, null, null),
            _ when snapshot is { State: "unavailable" } => LatticeWindow.Notice(LatticeChart.Unavailable, LatticeChart.UnavailableNext, ("一覧へ戻る", () => window.ShowList()), bud: true),
            _ when snapshot is null => LatticeWindow.Notice(Feed.Connection == LatticeConnection.Reconnecting ? LatticeChart.Reconnecting : "読み込んでいます…", null, null),
            _ => null
        };
        if (replaced is not null) { overlay.Children.Clear(); overlay.Children.Add(replaced); overlay.Children.Add(pills); RenderPills(); return; }
        if (!overlay.Children.Contains(stage)) { overlay.Children.Clear(); overlay.Children.Add(stage); overlay.Children.Add(pills); }
        if (LatticeChart.Banner(snapshot!) is { } banner) bannerHost.Child = Banner(banner);
        if (snapshot!.Cards.Length == 0) { board.Children.Clear(); board.Children.Add(LatticeWindow.Notice(LatticeChart.NoCards, null, null)); }
        else
        {
            if (!board.Children.Contains(scroller)) { board.Children.Clear(); board.Children.Add(scroller); board.Children.Add(fade); board.Children.Add(detailHost); }
            // The lanes are laid out in both views: the rail reads its members from them.
            Board.Show(snapshot, Feed.LastDiff, now); Board.Highlight(HighlightedMember); Board.Select(SelectedCard);
            if (ShowTree) { Tree.Show(snapshot, ChartName); Tree.Highlight(HighlightedMember); Tree.Select(SelectedCard); }
            scroller.Content = ShowTree ? Tree : Board;
        }
        var live = Feed.Connection == LatticeConnection.Live;
        Board.Flowing = live;
        // Reconnecting keeps the last drawing, dimmed; last_verified is a little dimmed too.
        stage.Opacity = !live ? .5 : LatticeChart.Banner(snapshot) is { Dim: true } ? .78 : 1;
        RenderRail(snapshot); RenderWaits(snapshot, now);
        if (SelectedCard is { } selected) { if (LatticeChart.Detail(snapshot, selected, now) is null) CloseDetail(); else ShowDetail(selected, false); }
        RenderPills();
    }

    private void RenderPills()
    {
        pills.Children.Clear();
        var texts = new List<(string Text, bool Spin)>();
        if (Feed.Snapshot is not null && Feed.Connection is LatticeConnection.Reconnecting or LatticeConnection.Connecting) texts.Add((LatticeChart.Reconnecting, true));
        if (Feed.Snapshot is not null && Feed.Connection == LatticeConnection.Login) texts.Add((LatticeChart.LoginRequired, false));
        if (Feed.Snapshot is { } snapshot) texts.AddRange(LatticeChart.DegradedPills(snapshot).Select(text => (text, true)));
        if (said is { } message) texts.Add((message, false));
        foreach (var (text, spin) in texts)
        {
            var label = Text(text, 13, Ink); System.Windows.Automation.AutomationProperties.SetAutomationId(label, "lattice-status");
            var glass = Glass(spin ? Row(Spinner(14), Spaced(label, 8)) : label, 99, new Thickness(14, 7, 16, 7), 0xF2); glass.Margin = new Thickness(0, 0, 0, 8); glass.HorizontalAlignment = HorizontalAlignment.Center;
            pills.Children.Add(glass);
        }
    }

    private void RenderToolbar(LatticeSnapshot? snapshot)
    {
        toolbar.Children.Clear();
        var switcherContent = new StackPanel { Orientation = Orientation.Horizontal };
        switcherContent.Children.Add(Icon("", 13, Muted));
        switcherContent.Children.Add(Spaced(Text(ChartName, 20, Ink, FontWeights.Bold), 10));
        if (Coordinator) switcherContent.Children.Add(Spaced(CoordinatorBadge(), 10));
        switcherContent.Children.Add(Spaced(Icon("", 11, Muted), 10));
        var switcher = Plain(Glass(switcherContent, 14, new Thickness(12, 8, 14, 8), 0xB3), $"{ChartName}{(Coordinator ? "、統括の工程表" : "")}。一覧へ戻る");
        switcher.Click += (_, _) => window.ShowList(fromChart: true);
        System.Windows.Automation.AutomationProperties.SetAutomationId(switcher, "lattice-switcher");
        toolbar.Children.Add(switcher);
        var live = Feed.Connection == LatticeConnection.Live;
        var dot = new System.Windows.Shapes.Ellipse { Width = 8, Height = 8, Fill = Brush(live ? Color.FromRgb(0x2E, 0xB3, 0x9E) : Muted) };
        if (live && Motion) dot.BeginAnimation(OpacityProperty, new DoubleAnimation(1, .35, TimeSpan.FromSeconds(1.2)) { AutoReverse = true, RepeatBehavior = RepeatBehavior.Forever });
        var livePill = Pill(Row(dot, Spaced(Text(live ? "ライブ" : "再接続中", 12, live ? Color.FromRgb(0x1F, 0x86, 0x76) : Muted, FontWeights.SemiBold), 6)), live ? Color.FromRgb(0x2E, 0xB3, 0x9E) : Muted, 0x1F);
        livePill.Margin = new Thickness(14, 0, 0, 0); toolbar.Children.Add(livePill);
        if (snapshot is null or { State: "unavailable" }) return;
        toolbar.Children.Add(ViewSwitch());
        var counts = LatticeChart.Counts(snapshot);
        var ring = new LatticeRing(counts.Done, counts.Total, 40) { Margin = new Thickness(26, 0, 0, 0) }; toolbar.Children.Add(ring);
        toolbar.Children.Add(Spaced(new StackPanel { Children = { Text("完了", 11, Muted), Text($"{counts.Done} / {counts.Total}", 14, Ink, FontWeights.SemiBold) }, VerticalAlignment = VerticalAlignment.Center }, 8));
        toolbar.Children.Add(Counter(Arc(14, Violet, 1.8), "作業中", counts.Working, Violet, 22));
        toolbar.Children.Add(Counter(Shape(HourglassGeometry, 11, Violet), "待ち", counts.Waiting, Violet, 8));
        toolbar.Children.Add(Counter(Shape(OctagonGeometry, 13, Red), "止まり", counts.Blocked, Red, 8));
    }
    /// <summary>The segmented control ツリー / 担当.</summary>
    private Border ViewSwitch()
    {
        Button Segment(string label, bool tree)
        {
            var on = ShowTree == tree;
            var face = new Border { Child = Text(label, 12.5, on ? Ink : Muted, on ? FontWeights.SemiBold : FontWeights.Normal), CornerRadius = new CornerRadius(8), Padding = new Thickness(14, 5, 14, 5), Background = on ? Brush(Colors.White) : Brushes.Transparent };
            if (on) face.Effect = new System.Windows.Media.Effects.DropShadowEffect { Color = Ink, Opacity = .08, BlurRadius = 6, ShadowDepth = 1, Direction = 270 };
            var button = Plain(face, label + (on ? "、表示中" : "で表示"));
            System.Windows.Automation.AutomationProperties.SetAutomationId(button, tree ? "lattice-view-tree" : "lattice-view-lanes");
            button.Click += (_, _) => SetView(tree);
            return button;
        }
        var segments = new Border { Child = Row(Segment("ツリー", true), Segment("担当", false)), CornerRadius = new CornerRadius(10), Padding = new Thickness(3), Background = Brush(Muted, 0x1F), Margin = new Thickness(14, 0, 0, 0), VerticalAlignment = VerticalAlignment.Center };
        return segments;
    }
    /// <summary>Switches the center between the tree and the lanes; 詳細, highlight and the selected card's scroll position carry over.</summary>
    internal void SetView(bool tree)
    {
        if (ShowTree == tree) return;
        ShowTree = tree; Render();
        if (SelectedCard is { } selected) { scroller.UpdateLayout(); ScrollToCard(selected); }
    }

    private static Border Counter(UIElement glyph, string label, int count, Color color, double left)
    {
        var pill = Pill(Row(glyph, Spaced(Text(label, 12.5, Ink), 6), Spaced(Text(count.ToString(), 14, color, FontWeights.Bold), 6)), Colors.White, 0xB3, new Thickness(12, 6, 13, 6));
        pill.BorderBrush = Brush(Colors.White); pill.BorderThickness = new Thickness(1); pill.Margin = new Thickness(left, 0, 0, 0);
        System.Windows.Automation.AutomationProperties.SetName(pill, $"{label} {count}");
        return pill;
    }

    private Border Banner(LatticeBanner banner)
    {
        var amber = banner.Tone == "amber"; var color = amber ? Amber : Slate;
        var text = new StackPanel { VerticalAlignment = VerticalAlignment.Center };
        text.Children.Add(Text(banner.Text, 14, Ink, FontWeights.SemiBold, TextWrapping.Wrap)); text.Children.Add(Text(banner.Next, 12.5, Muted, null, TextWrapping.Wrap));
        var dock = new DockPanel();
        var talk = Action("統括と話す", ""); talk.Margin = new Thickness(12, 0, 0, 0); DockPanel.SetDock(talk, Dock.Right);
        talk.IsEnabled = CoordinatorBotId is not null; talk.Click += (_, _) => { if (CoordinatorBotId is { } coordinator) _ = window.OpenChatAsync(coordinator); };
        dock.Children.Add(talk);
        var glyph = Icon(amber ? "" : "", 18, color); glyph.Margin = new Thickness(0, 0, 12, 0); DockPanel.SetDock(glyph, Dock.Left); dock.Children.Add(glyph);
        dock.Children.Add(text);
        var border = new Border { Child = dock, CornerRadius = new CornerRadius(14), Padding = new Thickness(16, 10, 12, 10), Margin = new Thickness(18, 0, 18, 10), Background = Brush(amber ? Color.FromRgb(0xFF, 0xF1, 0xD6) : Color.FromRgb(0xE6, 0xEC, 0xF3), 0xF0), BorderBrush = Brush(color, 0x55), BorderThickness = new Thickness(1) };
        System.Windows.Automation.AutomationProperties.SetAutomationId(border, "lattice-banner");
        return border;
    }

    private void RenderRail(LatticeSnapshot snapshot)
    {
        rail.Children.Clear();
        foreach (var item in LatticeChart.Rail(snapshot, Board.Layout))
        {
            var face = new Grid { Width = 50, Height = 50, Margin = new Thickness(0, 0, 0, 10) };
            var ring = new Border { CornerRadius = new CornerRadius(16), BorderThickness = new Thickness(2.4), BorderBrush = HighlightedMember == item.BotId ? Brush(Violet) : Brushes.Transparent };
            face.Children.Add(ring);
            face.Children.Add(new LatticeAvatar(item.Member, 40, window.Avatar) { HorizontalAlignment = HorizontalAlignment.Center });
            if (item.Working) face.Children.Add(Arc(50, Accent(item.Member.Color), 2.2));
            if (item.Blocked) face.Children.Add(new System.Windows.Shapes.Ellipse { Width = 12, Height = 12, Fill = Brush(Red), Stroke = Brushes.White, StrokeThickness = 2, HorizontalAlignment = HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Top });
            if (item.Waiting > 0)
            {
                var badge = Pill(Row(Shape(HourglassGeometry, 8, Colors.White), Spaced(Text(item.Waiting.ToString(), 10, Colors.White, FontWeights.Bold), 3)), Violet, 0xFF, new Thickness(5, 1, 6, 1));
                badge.HorizontalAlignment = HorizontalAlignment.Right; badge.VerticalAlignment = VerticalAlignment.Bottom; badge.Margin = new Thickness(0, 0, -4, -2); face.Children.Add(badge);
            }
            var state = string.Join("、", new[] { item.Working ? "作業中" : null, item.Blocked ? "止まりあり" : null, item.Waiting > 0 ? $"待ち {item.Waiting}" : null }.OfType<string>());
            var button = Plain(face, $"{item.Member.Name}{(state.Length > 0 ? "、" + state : "")}。押すとこのメンバーの工程だけを強調します");
            button.ToolTip = item.Member.Name; var id = item.BotId; button.Click += (_, _) => Highlight(HighlightedMember == id ? null : id);
            rail.Children.Add(button);
        }
    }
    internal void Highlight(string? botId) { HighlightedMember = botId; Board.Highlight(botId); Tree.Highlight(botId); if (Feed.Snapshot is { } snapshot) { RenderRail(snapshot); RenderWaits(snapshot, window.Now()); } }

    private void RenderWaits(LatticeSnapshot snapshot, DateTimeOffset now)
    {
        waits.Children.Clear();
        var rows = LatticeChart.WaitRows(snapshot, now);
        var on = HighlightedMember is { } member ? LatticeChart.Highlight(snapshot, member).Waits : null;
        if (rows.Count == 0) { var none = Text("いま待っている工程はありません。", 13, Muted, null, TextWrapping.Wrap); none.Margin = new Thickness(4); waits.Children.Add(none); return; }
        foreach (var row in rows)
        {
            var body = new StackPanel();
            // Reads on its own: the waiting card + owner, then 「この工程が終わるのを待っています」 over the awaited card, then who makes it.
            var head = new DockPanel();
            var length = Text($"待ち {row.Length}", 12, Muted); length.Margin = new Thickness(8, 0, 0, 0); DockPanel.SetDock(length, Dock.Right); head.Children.Add(length);
            var face = new LatticeAvatar(row.Waiter, 24, window.Avatar); DockPanel.SetDock(face, Dock.Left); head.Children.Add(face);
            head.Children.Add(Spaced(Text(row.Headline, 14, Ink, FontWeights.Bold, TextWrapping.Wrap), 8));
            body.Children.Add(head);
            var owner = Text(row.OwnerText, 12, Muted); owner.Margin = new Thickness(32, 2, 0, 0); body.Children.Add(owner);
            var marker = Text("この工程が終わるのを待っています", 12, Muted); marker.Margin = new Thickness(0, 10, 0, 4); body.Children.Add(marker);
            var awaited = new DockPanel(); var awaitedGlyph = StateGlyph(row.Info.Tone switch { "working" => "in-progress", "blocked" => "blocked", "ready" => "ready", "done" => "done", "retired" => "retired", _ => "pending" }, 13, Violet);
            awaitedGlyph.Margin = new Thickness(0, 0, 8, 0); DockPanel.SetDock(awaitedGlyph, Dock.Left); awaited.Children.Add(awaitedGlyph); awaited.Children.Add(Text(row.Title, 13.5, Ink, FontWeights.SemiBold, TextWrapping.Wrap));
            var title = new Border { Child = awaited, CornerRadius = new CornerRadius(12), Padding = new Thickness(10, 7, 10, 7), Margin = new Thickness(0, 0, 0, 8), Background = Brush(Muted, 0x12), BorderBrush = Brush(LatticeLook.Line), BorderThickness = new Thickness(1) };
            body.Children.Add(title);
            var producerLine = Row(Text("つくっている", 11.5, Muted), Spaced(new LatticeAvatar(row.Producer, 20, window.Avatar), 8), Spaced(Text(LatticeChart.NameOf(row.Producer), 13, row.Producer is { Known: true } ? Ink : Muted, FontWeights.SemiBold), 6));
            body.Children.Add(producerLine);
            var stateLine = Row(StateGlyph(row.Info.Tone switch { "working" => "in-progress", "blocked" => "blocked", "ready" => "ready", "done" => "done", "retired" => "retired", _ => "pending" }, 13, Violet), Spaced(Text(row.StateText, 12.5, row.Emphasized ? Red : Muted, row.Emphasized ? FontWeights.SemiBold : FontWeights.Normal, TextWrapping.Wrap), 6));
            stateLine.Margin = new Thickness(0, 6, 0, 10); body.Children.Add(stateLine);
            var chat = Action("会話を開く", ""); chat.IsEnabled = row.CanChat; var producerId = row.Producer?.BotId;
            chat.Click += (_, _) => { if (producerId is not null) _ = window.OpenChatAsync(producerId); };
            if (!row.CanChat) chat.ToolTip = "名簿にないメンバーとは会話を開けません。";
            var go = Action("工程へ移動", ""); var target = row.ForCard; go.Click += (_, _) => GoTo(target);
            body.Children.Add(Row(chat, go));
            var card = new Border { Child = body, CornerRadius = new CornerRadius(16), Padding = new Thickness(14, 12, 12, 12), Margin = new Thickness(0, 0, 0, 10),
                Background = Brush(row.Emphasized ? Color.FromRgb(0xFF, 0xEC, 0xE8) : Colors.White, row.Emphasized ? (byte)0xF2 : (byte)0xCC), BorderBrush = Brush(row.Emphasized ? Red : Colors.White, row.Emphasized ? (byte)0x80 : (byte)0xFF), BorderThickness = new Thickness(row.Emphasized ? 1.4 : 1) };
            card.Opacity = on is not null && !on.Contains(row.Key) ? .35 : 1;
            System.Windows.Automation.AutomationProperties.SetName(card, row.Label); System.Windows.Automation.AutomationProperties.SetAutomationId(card, "lattice-wait");
            waits.Children.Add(card);
        }
    }

    /// <summary>工程へ移動: the board scrolls to the awaited card and opens its detail.</summary>
    internal void GoTo(string cardId)
    {
        if (!ScrollToCard(cardId)) return;
        OpenDetail(cardId);
    }
    private Rect CardRect(string id) => ShowTree ? Tree.CardRect(id) : Board.CardRect(id);
    private FrameworkElement? CardElement(string id) => ShowTree ? Tree.CardElement(id) : Board.CardElement(id);
    private bool ScrollToCard(string cardId)
    {
        var rect = CardRect(cardId); if (rect.IsEmpty) return false;
        // The lanes keep their names at the left edge; the tree has none.
        if (ShowTree) { scroller.ScrollToHorizontalOffset(Math.Max(0, rect.X - 40)); scroller.ScrollToVerticalOffset(Math.Max(0, rect.Y - 60)); scroller.UpdateLayout(); }
        else ScrollBoard(rect.X, rect.Y);
        return true;
    }
    /// <summary>Brings a board point near the top left, clear of the lane names.</summary>
    internal void ScrollBoard(double x, double y) { scroller.ScrollToHorizontalOffset(Math.Max(0, x - LatticeChart.LabelWidth - 40)); scroller.ScrollToVerticalOffset(Math.Max(0, y - 60)); scroller.UpdateLayout(); }

    internal void OpenDetail(string cardId, bool morph = true) { SelectedCard = cardId; Board.Select(cardId); Tree.Select(cardId); ShowDetail(cardId, morph); }
    internal bool CloseDetail()
    {
        if (SelectedCard is null) return false;
        var card = SelectedCard; SelectedCard = null; detailHost.Content = null; Board.Select(null); Tree.Select(null);
        CardElement(card)?.Focus();
        return true;
    }
    private void ShowDetail(string cardId, bool morph)
    {
        if (Feed.Snapshot is not { } snapshot || LatticeChart.Detail(snapshot, cardId, window.Now()) is not { } detail) return;
        var accent = detail.Producer is { Known: true } ? Accent(detail.Producer.Color) : Violet;
        var body = new StackPanel();
        var head = new DockPanel();
        var close = Action("", ""); close.Padding = new Thickness(8); close.Margin = new Thickness(8, 0, 0, 0); DockPanel.SetDock(close, Dock.Right); close.Click += (_, _) => CloseDetail();
        System.Windows.Automation.AutomationProperties.SetName(close, "詳細を閉じる"); head.Children.Add(close);
        head.Children.Add(Row(StateGlyph(detail.Card.State, 18, accent), Spaced(Text(detail.Info.Badge, 13, detail.Card.State == "blocked" ? Red : accent, FontWeights.SemiBold), 7)));
        body.Children.Add(head);
        var title = Text(LatticeChart.Title(detail.Card), 21, Ink, FontWeights.Bold, TextWrapping.Wrap); title.Margin = new Thickness(0, 10, 0, 10); body.Children.Add(title);
        body.Children.Add(Row(new LatticeAvatar(detail.Producer, 26, window.Avatar), Spaced(Text(LatticeChart.NameOf(detail.Producer), 14, Ink, FontWeights.SemiBold), 8), Spaced(Text(detail.StateText, 13, detail.Card.State == "blocked" ? Red : Muted, null, TextWrapping.Wrap), 10)));
        var started = Text(detail.StartedText, 12.5, Muted); started.Margin = new Thickness(0, 8, 0, 0); body.Children.Add(started);
        Section(body, "設計メモ", detail.Card.DesignMemo);
        Section(body, "終了条件", detail.Card.DoneCondition);
        Links(body, "前の工程", detail.Previous);
        Links(body, "次の工程", detail.Next);
        var panel = Glass(new ScrollViewer { Content = body, VerticalScrollBarVisibility = ScrollBarVisibility.Auto }, 22, new Thickness(20, 16, 18, 18), 0xFA);
        panel.Width = 400; panel.VerticalAlignment = VerticalAlignment.Top; panel.MaxHeight = 4000;
        System.Windows.Automation.AutomationProperties.SetAutomationId(panel, "lattice-detail"); System.Windows.Automation.AutomationProperties.SetName(panel, LatticeChart.CardLabel(detail.Card, detail.Producer));
        detailHost.Content = panel;
        if (!morph || !Motion) return;
        // card -> 詳細: the sheet grows out of the card (FLIP: start at the card's place and size, settle on the spring curve).
        var source = CardElement(cardId);
        detailHost.UpdateLayout();
        if (source is null || !source.IsVisible || panel.ActualWidth == 0) return;
        var from = source.TranslatePoint(new Point(), panel);
        var scale = new ScaleTransform(source.ActualWidth / panel.ActualWidth, source.ActualHeight / Math.Max(1, panel.ActualHeight)); var move = new TranslateTransform(from.X, from.Y);
        var group = new TransformGroup(); group.Children.Add(scale); group.Children.Add(move); panel.RenderTransform = group;
        var time = TimeSpan.FromMilliseconds(380);
        scale.BeginAnimation(ScaleTransform.ScaleXProperty, new DoubleAnimation(1, time) { EasingFunction = Spring }); scale.BeginAnimation(ScaleTransform.ScaleYProperty, new DoubleAnimation(1, time) { EasingFunction = Spring });
        move.BeginAnimation(TranslateTransform.XProperty, new DoubleAnimation(0, time) { EasingFunction = Spring }); move.BeginAnimation(TranslateTransform.YProperty, new DoubleAnimation(0, time) { EasingFunction = Spring });
        panel.BeginAnimation(OpacityProperty, new DoubleAnimation(.4, 1, TimeSpan.FromMilliseconds(220)));
    }
    private static void Section(StackPanel body, string heading, string? text)
    {
        if (text is not { Length: > 0 }) return;
        var label = Text(heading, 12, Muted, FontWeights.SemiBold); label.Margin = new Thickness(0, 18, 0, 6); body.Children.Add(label);
        // Markdown shown as plain text (screen-spec: designMemo as plain text).
        body.Children.Add(new TextBox { Text = text, Style = Application.Current?.TryFindResource("SelectableBody") as Style, FontSize = 14, Foreground = Brush(Ink), TextWrapping = TextWrapping.Wrap, IsReadOnly = true, BorderThickness = new Thickness(0), Background = Brushes.Transparent });
    }
    private void Links(StackPanel body, string heading, IReadOnlyList<LatticeLink> links)
    {
        var label = Text(heading, 12, Muted, FontWeights.SemiBold); label.Margin = new Thickness(0, 18, 0, 6); body.Children.Add(label);
        if (links.Count == 0) { body.Children.Add(Text("なし", 13, Muted)); return; }
        foreach (var link in links)
        {
            var row = new DockPanel();
            var glyph = StateGlyph(link.State, 15, link.Producer is { Known: true } ? Accent(link.Producer.Color) : Violet); glyph.Margin = new Thickness(0, 0, 10, 0); DockPanel.SetDock(glyph, Dock.Left); row.Children.Add(glyph);
            var arrow = Icon("", 11, Muted); DockPanel.SetDock(arrow, Dock.Right); row.Children.Add(arrow);
            row.Children.Add(new StackPanel { Children = { Text(link.Title, 13.5, Ink, FontWeights.SemiBold), Text($"{LatticeChart.NameOf(link.Producer)}・{link.StateText}", 11.5, Muted) } });
            var frame = new Border { Child = row, CornerRadius = new CornerRadius(12), Padding = new Thickness(10, 8, 10, 8), Margin = new Thickness(0, 0, 0, 6), Background = Brush(Colors.White, 0xB0), BorderBrush = Brush(Line), BorderThickness = new Thickness(1) };
            var button = Plain(frame, $"{link.Title}、{LatticeChart.StateInfo(link.State).Badge}、つくっている {LatticeChart.NameOf(link.Producer)}");
            var id = link.Id; button.Click += (_, _) => GoTo(id);
            body.Children.Add(button);
        }
    }
}
