using System.ComponentModel;
using Avalonia;
using Avalonia.Animation;
using Avalonia.Animation.Easings;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Controls.Presenters;
using Avalonia.Controls.Primitives;
using Avalonia.Controls.Shapes;
using Path = Avalonia.Controls.Shapes.Path;
using Avalonia.Input;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Media.Imaging;
using Avalonia.Styling;
using Avalonia.Threading;
using BellTeam.Core;
using static BellTeam.Linux.LatticeLook;

namespace BellTeam.Linux;

/// <summary>
/// The 工程表 window (screen-spec.md; Mac openWindow(id: "lattice")): its own window, one at a time, 一覧 then 工程表. Reads only while shown and not minimized;
/// the list every 10 s, the open chart over its SSE. Saves nothing: closing the window drops the drawing. Mica is Windows-only: this window keeps its own gradient.
/// </summary>
public sealed class LatticeWindow : Window
{
    public static LatticeWindow? Current { get; private set; }
    public static LatticeWindow Open(LinuxWorkspace workspace, Func<string, Task> openChat) => Current ??= new LatticeWindow(workspace, openChat);

    private readonly LinuxWorkspace workspace;
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

    internal LatticeWindow(LinuxWorkspace workspace, Func<string, Task> openChat)
    {
        this.workspace = workspace; this.openChat = openChat; origin = workspace.Server;
        Title = "工程表"; Width = 1360; Height = 860; MinWidth = 900; MinHeight = 600; UseLayoutRounding = true; Background = BellTheme.ConversationBackground;
        pill = Glass(Row(Spinner(14), Spaced(pillText, 8)), 99, new Thickness(14, 7, 16, 7), 0xF2);
        pill.HorizontalAlignment = HorizontalAlignment.Center; pill.VerticalAlignment = VerticalAlignment.Bottom; pill.Margin = new Thickness(0, 0, 0, 18); pill.IsVisible = false; pill.IsHitTestVisible = false;
        AutomationProperties.SetAutomationId(pillText, "lattice-list-status");
        root.Children.Add(page); root.Children.Add(pill); Content = root;
        ShowList();
        PropertyChanged += (_, e) => { if (e.Property == IsVisibleProperty || e.Property == WindowStateProperty) Sync(); };
        workspace.PropertyChanged += WorkspaceChanged;
        AddHandler(KeyDownEvent, (_, e) => { if (e.Key == Key.Escape && (Chart?.CloseDetail() == true || (Chart is null && ReturnToChart()))) e.Handled = true; }, Avalonia.Interactivity.RoutingStrategies.Tunnel);
        Closed += (_, _) => { workspace.PropertyChanged -= WorkspaceChanged; StopAll(); if (ReferenceEquals(Current, this)) Current = null; };
    }

    private void WorkspaceChanged(object? sender, PropertyChangedEventArgs args)
    {
        if (args.PropertyName != nameof(LinuxWorkspace.Connected)) return;
        if (Dispatcher.UIThread.CheckAccess()) Sync(); else Dispatcher.UIThread.Post(Sync);
    }

    internal Func<string, string, Task<Bitmap>> Avatar
        => (id, version) => workspace.AvatarAsync(id == LatticeChart.OwnerId ? $"{workspace.Server}api/owner/avatar?v={Uri.EscapeDataString(version)}" : $"{workspace.Server}api/bots/{Uri.EscapeDataString(id)}/avatar?v={Uri.EscapeDataString(version)}");
    internal (string? Name, string AvatarVersion) OwnerProfile => (workspace.Owner?.Name, workspace.Owner?.AvatarVersion ?? "");
    internal LatticePerson? Roster(string botId)
        => workspace.Bots.FirstOrDefault(bot => bot.Id == botId) is { } bot ? new LatticePerson(bot.Id, bot.DisplayName, bot.Color, bot.AvatarVersion, true) : null;
    internal string? CoordinatorBotId => list is null ? null : LatticeChart.CoordinatorBotId(list);
    internal bool ListSettled => list is not null || listProblem is not null;
    private bool Wanted => IsVisible && WindowState != WindowState.Minimized && workspace.Connected;

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
        listLoop?.Cancel(); listLoop = null; pill.IsVisible = false;
        Chart = back; back = null; page.Content = Chart; Chart.Render();
        Sync();
        return true;
    }
    private void RenderList()
    {
        pill.IsVisible = listProblem == LatticeChart.Reconnecting && list is not null; pillText.Text = listProblem ?? "";
        var body = new StackPanel { Margin = new Thickness(40, 30, 40, 40), MaxWidth = 1180 };
        var header = new DockPanel { Margin = new Thickness(0, 0, 0, 22) };
        if (back is not null)
        {
            var backButton = Plain(Glass(Row(BackIcon(12, Muted), Spaced(Text(back.ChartName, 15, Ink, FontWeight.SemiBold), 8)), 14, new Thickness(12, 8, 14, 8), 0xB3), $"{back.ChartName}へ戻る");
            backButton.Margin = new Thickness(0, 0, 18, 0); backButton.Click += (_, _) => ReturnToChart(); DockPanel.SetDock(backButton, Dock.Left);
            AutomationProperties.SetAutomationId(backButton, "lattice-back"); header.Children.Add(backButton);
        }
        header.Children.Add(Text("工程表", 28, Ink, FontWeight.Bold));
        body.Children.Add(header);
        if (list is null && listProblem is { } problem && problem != LatticeChart.Reconnecting)
        {
            body.Children.Add(Notice(problem, problem == LatticeChart.OldServer ? LatticeChart.OldServerNext : null, problem == LatticeChart.OldServer ? ("閉じる", () => Close()) : null));
        }
        else if (list is null) body.Children.Add(Notice(listProblem ?? "読み込んでいます…", null, null));
        else if (list.Charts.Length == 0) body.Children.Add(Notice(LatticeChart.ListEmpty, null, ("閉じる", () => Close())));
        else
        {
            var items = LatticeChart.ListItems(list, Roster);
            var pinned = items.Where(item => item.Coordinator).ToList();
            if (pinned.Count > 0) { body.Children.Add(Section("ピン留め")); body.Children.Add(Cards(pinned, true)); }
            body.Children.Add(Section("すべての工程表"));
            var rest = Cards(items.Where(item => !item.Coordinator).ToList(), false);
            rest.Children.Add(NewChartCard()); body.Children.Add(rest);
        }
        page.Content = new ScrollViewer { Content = body, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled };
    }
    // Render seam: the 一覧 scrolled to its last chart.
    internal void ScrollListToEnd() { if (page.Content is ScrollViewer list) { list.UpdateLayout(); list.ScrollToEnd(); } }
    private static TextBlock Section(string title) { var text = Text(title, 13, Muted, FontWeight.SemiBold); text.Margin = new Thickness(4, 6, 0, 10); return text; }
    private WrapPanel Cards(IReadOnlyList<LatticeListItem> items, bool wide)
    {
        var panel = new WrapPanel { Margin = new Thickness(0, 0, 0, 18) };
        foreach (var item in items) panel.Children.Add(ListCard(item, wide));
        return panel;
    }
    private Button ListCard(LatticeListItem item, bool wide)
    {
        var grid = new Grid { ColumnDefinitions = new ColumnDefinitions("*,Auto") };
        var left = new StackPanel();
        if (item.Coordinator) { var badge = CoordinatorBadge(); badge.HorizontalAlignment = HorizontalAlignment.Left; badge.Margin = new Thickness(0, 0, 0, 8); left.Children.Add(badge); }
        var name = Text(item.Name, wide ? 22 : 18, Ink, FontWeight.Bold); left.Children.Add(name);
        if (item.Updated.Length > 0) { var updated = Text(item.Updated + " JST", 12, Muted); updated.Margin = new Thickness(0, 4, 0, 12); left.Children.Add(updated); }
        var faces = new StackPanel { Orientation = Orientation.Horizontal };
        foreach (var (member, index) in item.Members.Select((member, index) => (member, index))) faces.Children.Add(new LatticeAvatar(member, 30, Avatar) { Margin = new Thickness(index == 0 ? 0 : -8, 0, 0, 0) });
        var waiting = Pill(Row(Shape(HourglassGeometry, 10, item.Waiting > 0 ? Violet : Muted), Spaced(Text($"待ち {item.Waiting}", 12, item.Waiting > 0 ? Violet : Muted, FontWeight.SemiBold), 5)), item.Waiting > 0 ? Violet : Muted, 0x1A);
        waiting.Margin = new Thickness(12, 0, 0, 0);
        left.Children.Add(Row(faces, waiting));
        grid.Children.Add(left);
        var ring = new LatticeRing(item.Done, item.Total, wide ? 64 : 52); Grid.SetColumn(ring, 1); ring.Margin = new Thickness(14, 0, 0, 0); grid.Children.Add(ring);
        var glass = Glass(grid, 20, new Thickness(20, 18, 20, 18)); glass.Width = wide ? 560 : 360; glass.Margin = new Thickness(0, 0, 16, 16);
        var button = Plain(glass, item.Label); button.Click += (_, _) => OpenChart(item.ProjectId);
        AutomationProperties.SetAutomationId(button, "lattice-chart-card");
        return button;
    }
    private static Border NewChartCard()
    {
        var body = new StackPanel();
        body.Children.Add(Row(PlusIcon(14, Muted), Spaced(Text("新しい工程表", 16, Muted, FontWeight.SemiBold), 8)));
        var text = Text(LatticeChart.NewChart, 13, Muted, wrap: true); text.Margin = new Thickness(0, 8, 0, 0); body.Children.Add(text);
        var dashed = new Grid { Width = 360, Margin = new Thickness(0, 0, 16, 16) };
        dashed.Children.Add(new Rectangle { RadiusX = 20, RadiusY = 20, Stroke = Brush(Muted, 0x80), StrokeThickness = 1.3, StrokeDashArray = [5, 4], Fill = Brush(Colors.White, 0x40) });
        dashed.Children.Add(new Border { Child = body, Padding = new Thickness(20, 18, 20, 18) });
        return new Border { Child = dashed };
    }
    /// <summary>An empty or failure view: what happened, what happens next, and the one optional action.</summary>
    internal static Control Notice(string text, string? next, (string Label, Action Run)? action, bool bud = false)
    {
        var stack = new StackPanel { HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center, MaxWidth = 460, Margin = new Thickness(24, 60, 24, 24) };
        if (bud) { var image = new LatticeBud { Margin = new Thickness(0, 0, 0, 18) }; stack.Children.Add(image); }
        var main = Text(text, 18, Ink, FontWeight.SemiBold, wrap: true); main.TextAlignment = TextAlignment.Center; stack.Children.Add(main);
        AutomationProperties.SetAutomationId(main, "lattice-notice");
        if (next is not null) { var after = Text(next, 14, Muted, wrap: true); after.TextAlignment = TextAlignment.Center; after.Margin = new Thickness(0, 8, 0, 0); stack.Children.Add(after); }
        if (action is { } act) { var button = Action(act.Label, null, true); button.HorizontalAlignment = HorizontalAlignment.Center; button.Margin = new Thickness(0, 18, 0, 0); button.Click += (_, _) => act.Run(); stack.Children.Add(button); }
        return stack;
    }

    // MARK: 工程表

    internal void OpenChart(string projectId)
    {
        listLoop?.Cancel(); listLoop = null; pill.IsVisible = false;
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
    // ツリー / 担当 / 過去ログ ("tree" / "lanes" / "history"): ツリー by default, remembered while the app is open (screen-spec "ツリー").
    internal static string View { get; set; } = "tree";
    // 待ちの流れ: closed to a right-edge handle by default, open/closed remembered while the app is open (screen-spec, Owner 2026-11-14, as Mac).
    internal static bool WaitsOpen { get; set; }
    private readonly StackPanel history = new() { Margin = new Thickness(20, 14, 20, 24), Width = 680, HorizontalAlignment = HorizontalAlignment.Left, Background = Brushes.Transparent };
    private readonly Dictionary<string, Control> historyRows = [];
    private readonly Dictionary<string, Border> historyFrames = [];
    private readonly ScrollViewer scroller;
    private readonly Grid stage = new();
    // Two groups (switcher + view switch, then progress + counters); a narrow window wraps the second to its own row instead of cutting it off.
    private readonly WrapPanel toolbar = new() { ItemSpacing = 26, LineSpacing = 10 };
    private readonly Border bannerHost = new();
    private readonly StackPanel rail = new() { Margin = new Thickness(0, 6, 0, 0) };
    private readonly StackPanel waits = new();
    private ScrollViewer? waitScroller;
    internal void ScrollWaitsToEnd() { waitScroller?.UpdateLayout(); waitScroller?.ScrollToEnd(); }
    private readonly Border waitPanel;
    private readonly TextBlock waitCount = Text("", 12, Violet, FontWeight.SemiBold);
    private readonly ContentControl waitColumn = new();
    private readonly Grid board = new();
    private readonly Grid overlay = new();
    private readonly StackPanel pills = new() { HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Top, Margin = new Thickness(0, 10, 0, 0), IsHitTestVisible = false };
    // A short fade at the board's right edge: the next column reads as "more to the right", not as a cut card. Stops short of the vertical scroll bar.
    private readonly Rectangle fade = new()
    {
        Width = 36, HorizontalAlignment = HorizontalAlignment.Right, Margin = new Thickness(0, 0, 10, 10), IsHitTestVisible = false,
        Fill = new LinearGradientBrush { StartPoint = new RelativePoint(0, 0, RelativeUnit.Relative), EndPoint = new RelativePoint(1, 0, RelativeUnit.Relative), GradientStops = [new GradientStop(Color.FromArgb(0, 0xF7, 0xF5, 0xFC), 0), new GradientStop(Color.FromArgb(0xF2, 0xF7, 0xF5, 0xFC), 1)] }
    };
    private readonly ContentControl detailHost = new() { HorizontalAlignment = HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Stretch, Margin = new Thickness(0, 12, 12, 12) };
    private string? said;
    internal string? SelectedCard { get; private set; }
    internal string? HighlightedMember { get; private set; }
    public bool Running { get; private set; }

    public LatticeChartPage(LatticeWindow window, string projectId, LatticeChartSummary? summary)
    {
        this.window = window; this.projectId = projectId; this.summary = summary;
        RowDefinitions = new RowDefinitions("Auto,Auto,*");
        var bar = new Border { Child = toolbar, Padding = new Thickness(18, 14, 18, 10) }; Children.Add(bar);
        SetRow(bannerHost, 1); Children.Add(bannerHost);
        Board = new LatticeBoard(window.Avatar) { Background = Brushes.Transparent };
        if (window.Clock is { } clock) Board.Clock = clock;
        Board.CardOpened += id => OpenDetail(id);
        Tree = new LatticeTreeView(window.Avatar) { Background = Brushes.Transparent };
        Tree.CardOpened += id => OpenDetail(id);
        scroller = new ScrollViewer { Content = View == "tree" ? Tree : Board, HorizontalScrollBarVisibility = ScrollBarVisibility.Auto, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, Padding = new Thickness(0, 4, 0, 0) };
        scroller.ScrollChanged += (_, _) => Board.ScrolledTo(scroller.Offset.X);
        // A click on empty canvas clears the member highlight (screen-spec user path).
        scroller.AddHandler(PointerPressedEvent, (_, e) => { if (e.Source is ScrollViewer or LatticeBoard or LatticeTreeView or ScrollContentPresenter && HighlightedMember is not null) Highlight(null); }, Avalonia.Interactivity.RoutingStrategies.Tunnel);
        board.Children.Add(scroller); board.Children.Add(fade);
        stage.ColumnDefinitions = new ColumnDefinitions("92,*,Auto");
        var railGlass = Glass(new ScrollViewer { Content = rail, VerticalScrollBarVisibility = ScrollBarVisibility.Hidden, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled }, 22, new Thickness(8, 12, 8, 12)); railGlass.Margin = new Thickness(14, 4, 4, 16); railGlass.VerticalAlignment = VerticalAlignment.Top;
        stage.Children.Add(railGlass);
        SetColumn(board, 1); board.Margin = new Thickness(4, 4, 6, 16); stage.Children.Add(board);
        var waitScroll = waitScroller = new ScrollViewer { Content = waits, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled };
        var waitBody = new DockPanel(); var heading = new DockPanel { Margin = new Thickness(4, 0, 0, 12) }; DockPanel.SetDock(heading, Dock.Top);
        var fold = Plain(Row(RightIcon(12, Muted), RightIcon(12, Muted)), "待ちの流れを閉じる"); fold.Width = 30; fold.Height = 30; fold.HorizontalContentAlignment = HorizontalAlignment.Center; fold.VerticalContentAlignment = VerticalAlignment.Center;
        fold.Click += (_, _) => ToggleWaits(); ToolTip.SetTip(fold, "待ちの流れを閉じる"); AutomationProperties.SetAutomationId(fold, "lattice-waits-close"); DockPanel.SetDock(fold, Dock.Right); heading.Children.Add(fold);
        var countPill = Pill(waitCount, Violet, 0x1F, new Thickness(9, 3, 9, 3)); countPill.Margin = new Thickness(0, 0, 4, 0); DockPanel.SetDock(countPill, Dock.Right); heading.Children.Add(countPill);
        heading.Children.Add(Row(Shape(HourglassGeometry, 13, Violet), Spaced(Text("待ちの流れ", 16, Ink, FontWeight.Bold), 8)));
        waitBody.Children.Add(heading); waitBody.Children.Add(waitScroll);
        waitPanel = Glass(waitBody, 22, new Thickness(14, 16, 14, 12), 0xC7); waitPanel.Margin = new Thickness(6, 4, 16, 16); waitPanel.Width = 338;
        SetColumn(waitColumn, 2); stage.Children.Add(waitColumn);
        overlay.Children.Add(stage); overlay.Children.Add(pills);
        board.Children.Add(detailHost);
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
        try { await Feed.RunAsync((onActivity, cancel) => WithOwner(api.LatticeEventsAsync(projectId, onActivity, cancel)), source.Token); }
        finally { if (ReferenceEquals(run, source)) run = null; source.Dispose(); }
    }
    public void Stop() { Running = false; run?.Cancel(); run = null; }
    // Each snapshot carries the app's Owner profile, like Web's `owner` on its snapshot, so the reserved owner value is drawn by name and face.
    private async IAsyncEnumerable<LatticeSnapshot> WithOwner(IAsyncEnumerable<LatticeSnapshot> snapshots)
    {
        await foreach (var snapshot in snapshots) { var (name, version) = window.OwnerProfile; yield return snapshot with { OwnerName = name, OwnerAvatarVersion = version }; }
    }
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
        Control? replaced = Feed.Connection switch
        {
            LatticeConnection.NotFound => LatticeWindow.Notice(LatticeChart.NotFound, null, ("一覧へ戻る", () => window.ShowList())),
            LatticeConnection.Unsupported => LatticeWindow.Notice(LatticeChart.OldServer, LatticeChart.OldServerNext, ("閉じる", () => window.Close())),
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
            if (View == "tree") { Tree.Show(snapshot, ChartName); Tree.Highlight(HighlightedMember); Tree.Select(SelectedCard); }
            if (View == "history") RenderHistory(snapshot, now);
            Control center = View switch { "tree" => Tree, "history" => history, _ => Board };
            if (!ReferenceEquals(scroller.Content, center)) scroller.Content = center;
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
            var label = Text(text, 13, Ink); AutomationProperties.SetAutomationId(label, "lattice-status");
            var glass = Glass(spin ? Row(Spinner(14), Spaced(label, 8)) : label, 99, new Thickness(14, 7, 16, 7), 0xF2); glass.Margin = new Thickness(0, 0, 0, 8); glass.HorizontalAlignment = HorizontalAlignment.Center;
            pills.Children.Add(glass);
        }
    }

    private void RenderToolbar(LatticeSnapshot? snapshot)
    {
        toolbar.Children.Clear();
        var switcherContent = new StackPanel { Orientation = Orientation.Horizontal };
        switcherContent.Children.Add(BackIcon(13, Muted));
        switcherContent.Children.Add(Spaced(Text(ChartName, 20, Ink, FontWeight.Bold), 10));
        if (Coordinator) switcherContent.Children.Add(Spaced(CoordinatorBadge(), 10));
        switcherContent.Children.Add(Spaced(DownIcon(11, Muted), 10));
        var switcher = Plain(Glass(switcherContent, 14, new Thickness(12, 8, 14, 8), 0xB3), $"{ChartName}{(Coordinator ? "、統括の工程表" : "")}。一覧へ戻る");
        switcher.Click += (_, _) => window.ShowList(fromChart: true);
        AutomationProperties.SetAutomationId(switcher, "lattice-switcher");
        var lead = Row(switcher); toolbar.Children.Add(lead);
        var live = Feed.Connection == LatticeConnection.Live;
        var dot = new Ellipse { Width = 8, Height = 8, Fill = Brush(live ? Color.FromRgb(0x2E, 0xB3, 0x9E) : Muted) };
        if (live) Loop(dot, Pulse(1, .35, TimeSpan.FromSeconds(1.2)));
        var livePill = Pill(Row(dot, Spaced(Text(live ? "ライブ" : "再接続中", 12, live ? Color.FromRgb(0x1F, 0x86, 0x76) : Muted, FontWeight.SemiBold), 6)), live ? Color.FromRgb(0x2E, 0xB3, 0x9E) : Muted, 0x1F);
        livePill.Margin = new Thickness(14, 0, 0, 0); lead.Children.Add(livePill);
        if (snapshot is null or { State: "unavailable" }) return;
        lead.Children.Add(ViewSwitch(LatticeChart.History(snapshot, window.Now()).Count));
        var counts = LatticeChart.Counts(snapshot);
        var stats = Row(new LatticeRing(counts.Done, counts.Total, 40)); toolbar.Children.Add(stats);
        stats.Children.Add(Spaced(new StackPanel { Children = { Text("完了", 11, Muted), Text($"{counts.Done} / {counts.Total}", 14, Ink, FontWeight.SemiBold) }, VerticalAlignment = VerticalAlignment.Center }, 8));
        stats.Children.Add(Counter(Arc(14, Violet, 1.8), "作業中", counts.Working, Violet, 22));
        stats.Children.Add(Counter(Shape(HourglassGeometry, 11, Violet), "待ち", counts.Waiting, Violet, 8));
        stats.Children.Add(Counter(Shape(OctagonGeometry, 13, Red), "止まり", counts.Blocked, Red, 8));
    }
    /// <summary>The segmented control ツリー / 担当 / 過去ログ N.</summary>
    private Border ViewSwitch(int finished)
    {
        Button Segment(string label, string view)
        {
            var on = View == view;
            var face = new Border { Child = Text(label, 12.5, on ? Ink : Muted, on ? FontWeight.SemiBold : FontWeight.Normal), CornerRadius = new CornerRadius(8), Padding = new Thickness(14, 5, 14, 5), Background = on ? Brush(Colors.White) : Brushes.Transparent };
            if (on) face.BoxShadow = new BoxShadows(new BoxShadow { OffsetY = 1, Blur = 6, Color = Color.FromArgb(20, Ink.R, Ink.G, Ink.B) });
            var button = Plain(face, label + (on ? "、表示中" : "で表示"));
            AutomationProperties.SetAutomationId(button, "lattice-view-" + view);
            button.Click += (_, _) => SetView(view);
            return button;
        }
        return new Border { Child = Row(Segment("ツリー", "tree"), Segment("担当", "lanes"), Segment($"過去ログ {finished}", "history")), CornerRadius = new CornerRadius(10), Padding = new Thickness(3), Background = Brush(Muted, 0x1F), Margin = new Thickness(14, 0, 0, 0), VerticalAlignment = VerticalAlignment.Center };
    }
    /// <summary>Switches the center between the tree, the lanes and 過去ログ; 詳細, highlight and the selected card's scroll position carry over.</summary>
    internal void SetView(string view)
    {
        if (View == view) return;
        View = view; Render();
        if (SelectedCard is { } selected) { scroller.UpdateLayout(); ScrollToCard(selected); }
    }

    /// <summary>過去ログ: finished cards under JST day headings, newest first; a row opens 詳細.</summary>
    private void RenderHistory(LatticeSnapshot snapshot, DateTimeOffset now)
    {
        history.Children.Clear(); historyRows.Clear(); historyFrames.Clear();
        var log = LatticeChart.History(snapshot, now);
        if (log.Count == 0) { var none = Text("まだ終わった工程はありません。", 14, Muted); none.Margin = new Thickness(4, 10, 0, 0); history.Children.Add(none); return; }
        foreach (var group in log.Groups)
        {
            var heading = Text(group.Heading, 12.5, Muted, FontWeight.SemiBold); heading.Margin = new Thickness(4, 10, 0, 8); history.Children.Add(heading);
            foreach (var row in group.Rows)
            {
                var dock = new DockPanel();
                var time = Text(row.Time, 12, Muted); time.Margin = new Thickness(14, 0, 0, 0); DockPanel.SetDock(time, Dock.Right); dock.Children.Add(time);
                var name = Text(LatticeChart.NameOf(row.Owner), 12, Muted); name.Margin = new Thickness(6, 0, 0, 0); DockPanel.SetDock(name, Dock.Right); dock.Children.Add(name);
                var face = new LatticeAvatar(row.Owner, 20, window.Avatar) { Margin = new Thickness(12, 0, 0, 0) }; DockPanel.SetDock(face, Dock.Right); dock.Children.Add(face);
                var glyph = StateGlyph(row.Card.State, 14, Violet); glyph.Margin = new Thickness(0, 0, 10, 0); DockPanel.SetDock(glyph, Dock.Left); dock.Children.Add(glyph);
                var title = Text(LatticeChart.Title(row.Card), 13.5, Ink, FontWeight.SemiBold); if (row.Card.State == "retired") title.TextDecorations = TextDecorations.Strikethrough;
                dock.Children.Add(title);
                var frame = new Border { Child = dock, CornerRadius = new CornerRadius(10), Padding = new Thickness(12, 8, 12, 8), Margin = new Thickness(0, 0, 0, 6), Background = Brush(Colors.White, 0xD9), BorderBrush = Brush(LatticeLook.Line), BorderThickness = new Thickness(1) };
                var button = Plain(frame, row.Label); var id = row.Id; button.Click += (_, _) => OpenDetail(id);
                AutomationProperties.SetAutomationId(button, "lattice-history-row");
                historyRows[id] = button; historyFrames[id] = frame; history.Children.Add(button);
            }
        }
        ApplyHistory();
    }
    /// <summary>The selected card's ring and the member highlight on 過去ログ rows, as the tree and the lanes show them.</summary>
    private void ApplyHistory()
    {
        var on = HighlightedMember is { } member && Feed.Snapshot is { } snapshot ? LatticeChart.Highlight(snapshot, member).Cards : null;
        foreach (var (id, row) in historyRows)
        {
            row.Opacity = on is not null && !on.Contains(id) ? .28 : 1;
            var selected = id == SelectedCard; var frame = historyFrames[id];
            frame.BorderBrush = Brush(selected ? Violet : LatticeLook.Line); frame.BorderThickness = new Thickness(selected ? 2 : 1); frame.Padding = selected ? new Thickness(11, 7, 11, 7) : new Thickness(12, 8, 12, 8);
        }
    }

    private static Border Counter(Control glyph, string label, int count, Color color, double left)
    {
        var pill = Pill(Row(glyph, Spaced(Text(label, 12.5, Ink), 6), Spaced(Text(count.ToString(), 14, color, FontWeight.Bold), 6)), Colors.White, 0xB3, new Thickness(12, 6, 13, 6));
        pill.BorderBrush = Brush(Colors.White); pill.BorderThickness = new Thickness(1); pill.Margin = new Thickness(left, 0, 0, 0);
        AutomationProperties.SetName(pill, $"{label} {count}");
        return pill;
    }

    private Border Banner(LatticeBanner banner)
    {
        var amber = banner.Tone == "amber"; var color = amber ? Amber : Slate;
        var text = new StackPanel { VerticalAlignment = VerticalAlignment.Center };
        text.Children.Add(Text(banner.Text, 14, Ink, FontWeight.SemiBold, wrap: true)); text.Children.Add(Text(banner.Next, 12.5, Muted, wrap: true));
        var dock = new DockPanel();
        var talk = Action("統括と話す", ChatGlyph); talk.Margin = new Thickness(12, 0, 0, 0); DockPanel.SetDock(talk, Dock.Right);
        talk.IsEnabled = CoordinatorBotId is not null; talk.Click += (_, _) => { if (CoordinatorBotId is { } coordinator) _ = window.OpenChatAsync(coordinator); };
        dock.Children.Add(talk);
        var glyph = amber ? WarningIcon(18, color) : InfoIcon(18, color); glyph.Margin = new Thickness(0, 0, 12, 0); DockPanel.SetDock(glyph, Dock.Left); dock.Children.Add(glyph);
        dock.Children.Add(text);
        var border = new Border { Child = dock, CornerRadius = new CornerRadius(14), Padding = new Thickness(16, 10, 12, 10), Margin = new Thickness(18, 0, 18, 10), Background = Brush(amber ? Color.FromRgb(0xFF, 0xF1, 0xD6) : Color.FromRgb(0xE6, 0xEC, 0xF3), 0xF0), BorderBrush = Brush(color, 0x55), BorderThickness = new Thickness(1) };
        AutomationProperties.SetAutomationId(border, "lattice-banner");
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
            if (item.Blocked) face.Children.Add(new Ellipse { Width = 12, Height = 12, Fill = Brush(Red), Stroke = Brushes.White, StrokeThickness = 2, HorizontalAlignment = HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Top });
            if (item.Waiting > 0)
            {
                var badge = Pill(Row(Shape(HourglassGeometry, 8, Colors.White), Spaced(Text(item.Waiting.ToString(), 10, Colors.White, FontWeight.Bold), 3)), Violet, 0xFF, new Thickness(5, 1, 6, 1));
                badge.HorizontalAlignment = HorizontalAlignment.Right; badge.VerticalAlignment = VerticalAlignment.Bottom; badge.Margin = new Thickness(0, 0, -4, -2); face.Children.Add(badge);
            }
            var state = string.Join("、", new[] { item.Working ? "作業中" : null, item.Blocked ? "止まりあり" : null, item.Waiting > 0 ? $"待ち {item.Waiting}" : null }.OfType<string>());
            var button = Plain(face, $"{item.Member.Name}{(state.Length > 0 ? "、" + state : "")}。押すとこのメンバーの工程だけを強調します");
            ToolTip.SetTip(button, item.Member.Name); var id = item.BotId; button.Click += (_, _) => Highlight(HighlightedMember == id ? null : id);
            rail.Children.Add(button);
        }
    }
    internal void Highlight(string? botId) { HighlightedMember = botId; Board.Highlight(botId); Tree.Highlight(botId); ApplyHistory(); if (Feed.Snapshot is { } snapshot) { RenderRail(snapshot); RenderWaits(snapshot, window.Now()); } }

    private static string GlyphState(string tone) => tone switch { "working" => "in-progress", "blocked" => "blocked", "ready" => "ready", "done" => "done", "retired" => "retired", _ => "pending" };

    private void RenderWaits(LatticeSnapshot snapshot, DateTimeOffset now)
    {
        waits.Children.Clear();
        var rows = LatticeChart.WaitRows(snapshot, now);
        waitCount.Text = $"{rows.Count}件";
        waitColumn.Content = WaitsOpen ? waitPanel : WaitHandle(rows.Count, rows.Any(row => row.Emphasized));
        var on =HighlightedMember is { } member ? LatticeChart.Highlight(snapshot, member).Waits : null;
        if (rows.Count == 0) { var none = Text("いま待っている工程はありません。", 13, Muted, wrap: true); none.Margin = new Thickness(4); waits.Children.Add(none); return; }
        foreach (var row in rows)
        {
            var body = new StackPanel();
            // Reads on its own: the waiting card + owner, then 「この工程が終わるのを待っています」 over the awaited card, then who makes it.
            var head = new DockPanel();
            var length = Text($"待ち {row.Length}", 12, Muted); length.Margin = new Thickness(8, 0, 0, 0); DockPanel.SetDock(length, Dock.Right); head.Children.Add(length);
            var face = new LatticeAvatar(row.Waiter, 24, window.Avatar); DockPanel.SetDock(face, Dock.Left); head.Children.Add(face);
            head.Children.Add(Spaced(Text(row.Headline, 14, Ink, FontWeight.Bold, wrap: true), 8));
            body.Children.Add(head);
            var owner = Text(row.OwnerText, 12, Muted); owner.Margin = new Thickness(32, 2, 0, 0); body.Children.Add(owner);
            var marker = Text("この工程が終わるのを待っています", 12, Muted); marker.Margin = new Thickness(0, 10, 0, 4); body.Children.Add(marker);
            var awaited = new DockPanel(); var awaitedGlyph = StateGlyph(GlyphState(row.Info.Tone), 13, Violet);
            awaitedGlyph.Margin = new Thickness(0, 0, 8, 0); DockPanel.SetDock(awaitedGlyph, Dock.Left); awaited.Children.Add(awaitedGlyph); awaited.Children.Add(Text(row.Title, 13.5, Ink, FontWeight.SemiBold, wrap: true));
            var title = new Border { Child = awaited, CornerRadius = new CornerRadius(12), Padding = new Thickness(10, 7, 10, 7), Margin = new Thickness(0, 0, 0, 8), Background = Brush(Muted, 0x12), BorderBrush = Brush(LatticeLook.Line), BorderThickness = new Thickness(1) };
            body.Children.Add(title);
            var producerLine = Row(Text("つくっている", 11.5, Muted), Spaced(new LatticeAvatar(row.Producer, 20, window.Avatar), 8), Spaced(Text(LatticeChart.NameOf(row.Producer), 13, row.Producer is { Known: true } ? Ink : Muted, FontWeight.SemiBold), 6));
            body.Children.Add(producerLine);
            var stateLine = Row(StateGlyph(GlyphState(row.Info.Tone), 13, Violet), Spaced(Text(row.StateText, 12.5, row.Emphasized ? Red : Muted, row.Emphasized ? FontWeight.SemiBold : FontWeight.Normal, wrap: true), 6));
            stateLine.Margin = new Thickness(0, 6, 0, 10); body.Children.Add(stateLine);
            var chat = Action("会話を開く", ChatGlyph); chat.IsEnabled = row.CanChat; var producerId = row.Producer?.BotId;
            chat.Click += (_, _) => { if (producerId is not null) _ = window.OpenChatAsync(producerId); };
            if (!row.CanChat) ToolTip.SetTip(chat, "名簿にないメンバーとは会話を開けません。");
            var go = Action("工程へ移動", ForwardGlyph); var target = row.ForCard; go.Click += (_, _) => GoTo(target);
            body.Children.Add(Row(chat, go));
            var card = new Border { Child = body, CornerRadius = new CornerRadius(16), Padding = new Thickness(14, 12, 12, 12), Margin = new Thickness(0, 0, 0, 10),
                Background = Brush(row.Emphasized ? Color.FromRgb(0xFF, 0xEC, 0xE8) : Colors.White, row.Emphasized ? (byte)0xF2 : (byte)0xCC), BorderBrush = Brush(row.Emphasized ? Red : Colors.White, row.Emphasized ? (byte)0x80 : (byte)0xFF), BorderThickness = new Thickness(row.Emphasized ? 1.4 : 1) };
            card.Opacity = on is not null && !on.Contains(row.Key) ? .35 : 1;
            AutomationProperties.SetName(card, row.Label); AutomationProperties.SetAutomationId(card, "lattice-wait");
            waits.Children.Add(card);
        }
    }

    /// <summary>The folded 待ちの流れ: a slim right-edge handle (open chevrons, hourglass, wait count; the count is red when a row waits on a blocked producer).</summary>
    private Button WaitHandle(int count, bool emphasized)
    {
        var tone = emphasized ? Red : Violet;
        var stack = new StackPanel { Spacing = 10, HorizontalAlignment = HorizontalAlignment.Center };
        stack.Children.Add(Row(BackIcon(11, Muted), BackIcon(11, Muted)));
        stack.Children.Add(Shape(HourglassGeometry, 15, Ink));
        stack.Children.Add(Pill(Text(count.ToString(), 13, tone, FontWeight.Bold), tone, 0x1F, new Thickness(7, 2, 7, 2)));
        var glass = Glass(stack, 22, new Thickness(0, 18, 0, 12), 0xC7); glass.Width = 48;
        var handle = Plain(glass, $"待ちの流れを開く、{count}件"); handle.Margin = new Thickness(6, 4, 16, 16); handle.VerticalAlignment = VerticalAlignment.Stretch;
        handle.Click += (_, _) => ToggleWaits(); ToolTip.SetTip(handle, "待ちの流れを開く"); AutomationProperties.SetAutomationId(handle, "lattice-waits-open");
        return handle;
    }
    internal void ToggleWaits() { WaitsOpen = !WaitsOpen; if (Feed.Snapshot is { } snapshot) RenderWaits(snapshot, window.Now()); }

    /// <summary>工程へ移動: the board scrolls to the card when it is drawn (not archived, not 過去ログ) and opens its detail either way.</summary>
    internal void GoTo(string cardId)
    {
        ScrollToCard(cardId);
        OpenDetail(cardId);
    }
    internal Rect? CardRect(string id) => View switch { "tree" => Tree.CardRect(id), "lanes" => Board.CardRect(id), _ => HistoryRect(id) };
    // A 過去ログ row's place in the scrolled content (the panel's margin included); empty before layout or for an unfinished card.
    private Rect? HistoryRect(string id)
    {
        if (!historyRows.TryGetValue(id, out var row) || row.Bounds.Height == 0 || row.TranslatePoint(new Point(), history) is not { } at) return null;
        return new Rect(at.X + history.Margin.Left, at.Y + history.Margin.Top, row.Bounds.Width, row.Bounds.Height);
    }
    private Control? CardElement(string id) => View switch { "tree" => Tree.CardElement(id), "lanes" => Board.CardElement(id), _ => historyRows.GetValueOrDefault(id) };
    private bool ScrollToCard(string cardId)
    {
        if (CardRect(cardId) is not { } rect) return false;
        // The lanes keep their names at the left edge; the tree and 過去ログ have none.
        if (View is "tree" or "history") { scroller.UpdateLayout(); scroller.Offset = new Vector(Math.Max(0, rect.X - 40), Math.Max(0, rect.Y - 60)); }
        else ScrollBoard(rect.X, rect.Y);
        return true;
    }
    /// <summary>Brings a board point near the top left, clear of the lane names.</summary>
    internal void ScrollBoard(double x, double y) { scroller.UpdateLayout(); scroller.Offset = new Vector(Math.Max(0, x - LatticeChart.LabelWidth - 40), Math.Max(0, y - 60)); }

    internal void OpenDetail(string cardId, bool morph = true) { SelectedCard = cardId; Board.Select(cardId); Tree.Select(cardId); ApplyHistory(); ShowDetail(cardId, morph); }
    internal bool CloseDetail()
    {
        if (SelectedCard is null) return false;
        var card = SelectedCard; SelectedCard = null; detailHost.Content = null; Board.Select(null); Tree.Select(null); ApplyHistory();
        CardElement(card)?.Focus();
        return true;
    }
    private void ShowDetail(string cardId, bool morph)
    {
        if (Feed.Snapshot is not { } snapshot || LatticeChart.Detail(snapshot, cardId, window.Now()) is not { } detail) return;
        var accent = detail.Producer is { Known: true } ? Accent(detail.Producer.Color) : Violet;
        var body = new StackPanel();
        var head = new DockPanel();
        var close = Action(""); close.Content = CloseIcon(14, Violet); close.Padding = new Thickness(8); close.Margin = new Thickness(8, 0, 0, 0); DockPanel.SetDock(close, Dock.Right); close.Click += (_, _) => CloseDetail();
        AutomationProperties.SetName(close, "詳細を閉じる"); head.Children.Add(close);
        head.Children.Add(Row(StateGlyph(detail.Card.State, 18, accent), Spaced(Text(detail.Info.Badge, 13, detail.Card.State == "blocked" ? Red : accent, FontWeight.SemiBold), 7)));
        body.Children.Add(head);
        var title = Text(LatticeChart.Title(detail.Card), 21, Ink, FontWeight.Bold, wrap: true); title.Margin = new Thickness(0, 10, 0, 10); body.Children.Add(title);
        body.Children.Add(Row(new LatticeAvatar(detail.Producer, 26, window.Avatar), Spaced(Text(LatticeChart.NameOf(detail.Producer), 14, Ink, FontWeight.SemiBold), 8), Spaced(Text(detail.StateText, 13, detail.Card.State == "blocked" ? Red : Muted, wrap: true), 10)));
        var started = Text(detail.StartedText, 12.5, Muted); started.Margin = new Thickness(0, 8, 0, 0); body.Children.Add(started);
        Section(body, "設計メモ", detail.Card.DesignMemo);
        Section(body, "終了条件", detail.Card.DoneCondition);
        Links(body, "前の工程", detail.Previous);
        Links(body, "次の工程", detail.Next);
        var panel = Glass(new ScrollViewer { Content = body, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled }, 22, new Thickness(20, 16, 18, 18), 0xFA);
        panel.Width = 400; panel.VerticalAlignment = VerticalAlignment.Top; panel.MaxHeight = 4000;
        AutomationProperties.SetAutomationId(panel, "lattice-detail"); AutomationProperties.SetName(panel, LatticeChart.CardLabel(detail.Card, detail.Producer));
        detailHost.Content = panel;
        if (!morph || !Motion) return;
        // card -> 詳細: the sheet grows out of the card (FLIP: start at the card's place and size, settle on the spring curve).
        var source = CardElement(cardId);
        detailHost.UpdateLayout();
        if (source is null || !source.IsVisible || panel.Bounds.Width == 0 || source.TranslatePoint(new Point(), panel) is not { } from) return;
        var startX = source.Bounds.Width / panel.Bounds.Width; var startY = source.Bounds.Height / Math.Max(1, panel.Bounds.Height);
        panel.RenderTransformOrigin = new RelativePoint(0, 0, RelativeUnit.Relative);
        var settle = new Animation
        {
            Duration = TimeSpan.FromMilliseconds(380), Easing = new CubicEaseOut(),
            Children =
            {
                new KeyFrame { Cue = new Cue(0), Setters = { new Setter(ScaleTransform.ScaleXProperty, startX), new Setter(ScaleTransform.ScaleYProperty, startY), new Setter(TranslateTransform.XProperty, from.X), new Setter(TranslateTransform.YProperty, from.Y), new Setter(OpacityProperty, .4) } },
                new KeyFrame { Cue = new Cue(1), Setters = { new Setter(ScaleTransform.ScaleXProperty, 1d), new Setter(ScaleTransform.ScaleYProperty, 1d), new Setter(TranslateTransform.XProperty, 0d), new Setter(TranslateTransform.YProperty, 0d), new Setter(OpacityProperty, 1d) } }
            }
        };
        _ = settle.RunAsync(panel);
    }
    private static void Section(StackPanel body, string heading, string? text)
    {
        if (text is not { Length: > 0 }) return;
        var label = Text(heading, 12, Muted, FontWeight.SemiBold); label.Margin = new Thickness(0, 18, 0, 6); body.Children.Add(label);
        // Markdown shown as plain text (screen-spec: designMemo as plain text).
        body.Children.Add(new TextBox { Classes = { "bare" }, Text = text, FontSize = 14, Foreground = Brush(Ink), TextWrapping = TextWrapping.Wrap, IsReadOnly = true, AcceptsReturn = true });
    }
    private void Links(StackPanel body, string heading, IReadOnlyList<LatticeLink> links)
    {
        var label = Text(heading, 12, Muted, FontWeight.SemiBold); label.Margin = new Thickness(0, 18, 0, 6); body.Children.Add(label);
        if (links.Count == 0) { body.Children.Add(Text("なし", 13, Muted)); return; }
        foreach (var link in links)
        {
            var row = new DockPanel();
            var glyph = StateGlyph(link.State, 15, link.Producer is { Known: true } ? Accent(link.Producer.Color) : Violet); glyph.Margin = new Thickness(0, 0, 10, 0); DockPanel.SetDock(glyph, Dock.Left); row.Children.Add(glyph);
            var arrow = RightIcon(11, Muted); DockPanel.SetDock(arrow, Dock.Right); row.Children.Add(arrow);
            row.Children.Add(new StackPanel { Children = { Text(link.Title, 13.5, Ink, FontWeight.SemiBold), Text($"{LatticeChart.NameOf(link.Producer)}・{link.StateText}", 11.5, Muted) } });
            var frame = new Border { Child = row, CornerRadius = new CornerRadius(12), Padding = new Thickness(10, 8, 10, 8), Margin = new Thickness(0, 0, 0, 6), Background = Brush(Colors.White, 0xB0), BorderBrush = Brush(LatticeLook.Line), BorderThickness = new Thickness(1) };
            var button = Plain(frame, $"{link.Title}、{LatticeChart.StateInfo(link.State).Badge}、つくっている {LatticeChart.NameOf(link.Producer)}");
            var id = link.Id; button.Click += (_, _) => GoTo(id);
            body.Children.Add(button);
        }
    }
}
