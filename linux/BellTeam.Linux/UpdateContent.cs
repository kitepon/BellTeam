using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Controls.Shapes;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Media.Imaging;
using Avalonia.Threading;
using BellTeam.Core;

namespace BellTeam.Linux;

// Segoe icon glyphs of the Windows UpdateContent as 24x24 stroked vector icons.
internal static class UpdateIcons
{
    public const string ArrowDown = "M12,4 V19.5 M5.5,13 L12,19.5 L18.5,13";
    public const string Clock = "M12,3 a9,9 0 1 0 0.01,0 Z M12,7 V12 L15.5,14";
    public const string Question = "M9,9.5 a3,3 0 1 1 4.6,2.5 C12.6,12.7 12,13.3 12,14.5 M12,17.6 V18";
    public const string Info = "M12,3 a9,9 0 1 0 0.01,0 Z M12,11 V16.5 M12,7.6 V8";
    public const string Pause = "M9,6 V18 M15,6 V18";
    public const string Refresh = "M19,12 a7,7 0 1 1 -2.05,-4.95 M19,4.5 V8.5 H15";
    public const string Container = "M12,3 L20,7.5 V16.5 L12,21 L4,16.5 V7.5 Z M4,7.5 L12,12 L20,7.5 M12,12 V21";
    public const string Globe = "M12,3 a9,9 0 1 0 0.01,0 Z M3,12 H21 M12,3 C8,7 8,17 12,21 M12,3 C16,7 16,17 12,21";
    public const string Bell = "M6,16 V11 a6,6 0 0 1 12,0 V16 L19.5,18 H4.5 Z M10,20.5 a2,2 0 0 0 4,0";
    public const string People = "M9,8 a3.2,3.2 0 1 0 0.01,0 Z M3,19.5 C3,16 5.5,14.5 9,14.5 C12.5,14.5 15,16 15,19.5 M16,5.5 a3,3 0 0 1 0,5.5 M17.5,14.7 C19.7,15.2 21,16.5 21,19.5";
    public const string Chip = "M7,7 H17 V17 H7 Z M10,10 H14 V14 H10 Z M9.5,3.5 V7 M14.5,3.5 V7 M9.5,17 V20.5 M14.5,17 V20.5 M3.5,9.5 H7 M3.5,14.5 H7 M17,9.5 H20.5 M17,14.5 H20.5";
    public const string Pulse = "M3,12 H7 L9.5,6 L13,18 L15.5,12 H21";
    public const string Bars = "M5,20 V13 M12,20 V5 M19,20 V9";
    public const string Bolt = "M13,3 L5,13.5 H11 L10,21 L19,10 H13 Z";
    public const string Grid = "M4,4 H10 V10 H4 Z M14,4 H20 V10 H14 Z M4,14 H10 V20 H4 Z M14,14 H20 V20 H14 Z";
    public static string For(string componentId) => componentId switch
    {
        "container" => Container, "web-gateway" => Globe, "notifications" => Bell, "members" => People, "memory" => Chip, "diagnostics" => Pulse,
        "usage" => Bars, "execution" => Bolt, "conversation" => Icons.Chat, _ => Grid
    };
}

// The Mac UpdateContent: hero card, attention banner, chooser or confirmation, part list, change list, jobs, problems and a closed 詳細.
// Shared by the Settings アップデート page and the Update sheet; the state logic lives in Core UpdateScreen.
public sealed class UpdateContent : UserControl, IDisposable
{
    private static readonly Color VioletColor = Color.FromRgb(0x61, 0x47, 0xD4), MintColor = Color.FromRgb(0x2E, 0xB3, 0x9E), RedColor = Color.FromRgb(0xFF, 0x3B, 0x30), GreyColor = Color.FromRgb(0x8A, 0x8A, 0x8E);
    private static readonly IBrush Group = new Avalonia.Media.Immutable.ImmutableSolidColorBrush(Color.FromRgb(0xF2, 0xF2, 0xF7));
    private static readonly IBrush Hairline = new Avalonia.Media.Immutable.ImmutableSolidColorBrush(Color.FromRgb(0xE6, 0xE6, 0xEB));
    private readonly Workspace<Bitmap> workspace;
    private readonly UpdateCenter center;
    private readonly StackPanel stack = new() { Margin = new Thickness(18, 22, 18, 22), MaxWidth = 620 };
    private readonly ScrollViewer scroller = new() { VerticalScrollBarVisibility = Avalonia.Controls.Primitives.ScrollBarVisibility.Auto, HorizontalScrollBarVisibility = Avalonia.Controls.Primitives.ScrollBarVisibility.Disabled };
    private readonly DispatcherTimer poll = new() { Interval = TimeSpan.FromSeconds(5) };
    private UpdateInventory? inventory;
    private string? readError, actionMessage;
    private UpdatePlan? plan;
    private bool choosing, confirmedRestart, detailsOpen, refreshing, disposed;
    private UpdateKind kind = UpdateKind.Loading;
    private UpdateOperation? current;
    private UpdateComponent[] candidates = [];

    public UpdateContent(Workspace<Bitmap> workspace, SettingsStore? settings = null)
    {
        this.workspace = workspace;
        center = new(workspace.Management.Api, settings ?? new SettingsStore(SettingsStore.UserDirectory));
        scroller.Content = stack; Content = scroller; Background = Group;
        workspace.UpdatesChanged += Changed;
        // While an update runs the Mac shows no button, so the same request is read again on a timer (GET only).
        poll.Tick += (_, _) => { if (kind == UpdateKind.Updating) _ = RefreshAsync(); };
        Render();
    }
    public bool Busy { get; private set; }
    public UpdateKind Kind => kind;
    public bool DetailsOpen { get => detailsOpen; set { detailsOpen = value; Render(); } }
    public void Dispose() { disposed = true; workspace.UpdatesChanged -= Changed; poll.Stop(); }
    public void ScrollToEnd() { scroller.UpdateLayout(); scroller.ScrollToEnd(); scroller.UpdateLayout(); }
    // The server event arrives on the connection's thread.
    private void Changed() => Dispatcher.UIThread.Post(() => { if (!Busy && !disposed) _ = RefreshAsync(); });
    private CancellationToken Token => workspace.ConnectionToken;

    // Reads the inventory, then (when asked) the saved requests by their own ids. Nothing here ever posts.
    public async Task RefreshAsync(bool requery = true)
    {
        if (refreshing) return;
        refreshing = true;
        try
        {
            try { inventory = await center.InventoryAsync(Token); readError = null; }
            catch (OperationCanceledException) when (Token.IsCancellationRequested) { return; }
            catch (Exception error) { inventory = null; readError = error.Message; }
            if (requery && inventory is not null) await RequeryAsync();
        }
        finally { refreshing = false; if (!disposed) Render(); }
    }
    private async Task RequeryAsync()
    {
        var pending = center.Requests.Where(item => item.Rejection is null && (item.Result is null || !UpdateScreen.Settled(item.Result))).ToList();
        if (inventory?.Operation is { } operation && !UpdateScreen.Settled(operation) && pending.All(item => item.RequestId != operation.RequestId)) pending.Add(new(workspace.Server, operation.RequestId, operation.Plan.PlanId, operation));
        foreach (var request in pending)
        {
            try { await center.ReadAsync(request, Token); }
            catch (OperationCanceledException) when (Token.IsCancellationRequested) { return; }
            catch (Exception error) { actionMessage = "更新の結果を確認できません。同じ要求を照会し直します。更新は送り直しません。" + error.Message; }
        }
    }

    private async Task PlanAsync(string componentId)
    {
        choosing = false; plan = null; actionMessage = null; Busy = true; Render();
        try { plan = await center.PlanAsync(componentId, Token); confirmedRestart = false; }
        catch (OperationCanceledException) when (Token.IsCancellationRequested) { }
        catch (Exception error) { actionMessage = "更新計画を取得できませんでした。" + error.Message; }
        finally { Busy = false; if (!disposed) Render(); }
    }
    private async Task ExecuteAsync(UpdatePlan target)
    {
        actionMessage = null; Busy = true; Render();
        try { await center.StartAsync(target, !target.Impact.ContainerRestart || confirmedRestart, Token); }
        catch (OperationCanceledException) when (Token.IsCancellationRequested) { }
        catch (Exception error) { actionMessage = error.Message; }
        plan = null; Busy = false;
        await RefreshAsync(requery: false);
    }

    // The Mac canStartPlan: not while a plan is being fetched or sent, and not while an accepted update is still running.
    private bool CanStartPlan => !Busy && (current is null || UpdateScreen.Settled(current) || UpdateScreen.Unknown(current));

    // ---- building blocks ----
    private static IBrush Tint(Color color, double opacity) => new Avalonia.Media.Immutable.ImmutableSolidColorBrush(Color.FromArgb((byte)(opacity * 255), color.R, color.G, color.B));
    private static IBrush Solid(Color color) => new Avalonia.Media.Immutable.ImmutableSolidColorBrush(color);
    private static TextBlock Label(string text, double size, IBrush? color = null, FontWeight weight = FontWeight.Normal, Thickness? margin = null, bool mono = false)
    {
        var block = BellTheme.Text(text, size, color ?? BellTheme.Ink, weight, margin);
        if (mono) block.FontFamily = BellTheme.Mono;
        return block;
    }
    private static Border Card(Control child, double padding = 18) => new() { Child = child, Background = Brushes.White, CornerRadius = new CornerRadius(16), Padding = new Thickness(padding) };
    private void Add(Control element) { element.Margin = new Thickness(element.Margin.Left, stack.Children.Count == 0 ? 0 : 22, element.Margin.Right, element.Margin.Bottom); stack.Children.Add(element); }
    private static Button Capsule(string label, IBrush background, IBrush foreground, double radius, double size, Thickness padding)
    {
        var button = new Button { Classes = { "plain" }, Content = label, Background = background, Foreground = foreground, CornerRadius = new CornerRadius(radius), FontSize = size, Padding = padding, HorizontalContentAlignment = HorizontalAlignment.Center };
        AutomationProperties.SetName(button, label);
        return button;
    }
    private static Button Pill(string label, bool prominent, Action click, bool enabled = true)
    {
        var button = Capsule(label, prominent ? BellTheme.Violet : Tint(VioletColor, .12), prominent ? Brushes.White : BellTheme.Violet, 22, 15, new Thickness(18, 11));
        button.HorizontalAlignment = HorizontalAlignment.Stretch; button.IsEnabled = enabled; button.Click += (_, _) => click();
        return button;
    }
    private static Border StatusTag(Control child, Color tint, Thickness padding) => new() { Child = child, Background = Tint(tint, .14), CornerRadius = new CornerRadius(12), Padding = padding, VerticalAlignment = VerticalAlignment.Center };
    private static Control FilledCircle(IBrush color, string icon, double size)
    {
        var grid = new Grid { Width = size, Height = size };
        grid.Children.Add(new Ellipse { Fill = color }); grid.Children.Add(Centered(Icons.Draw(icon, size * .5, Brushes.White, thickness: 3)));
        return grid;
    }
    private static Control Seal(IBrush color, double size)
    {
        var grid = new Grid { Width = size, Height = size };
        var side = size * .74;
        foreach (var angle in new[] { 0.0, 45.0 }) grid.Children.Add(new Border { Width = side, Height = side, CornerRadius = new CornerRadius(side * .3), Background = color, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center, RenderTransformOrigin = RelativePoint.Center, RenderTransform = new RotateTransform(angle) });
        grid.Children.Add(Centered(Icons.Draw(Icons.Check, size * .46, Brushes.White, thickness: 3.2)));
        return grid;
    }
    private static Control HeroIcon(UpdateKind kind)
    {
        var tint = kind switch { UpdateKind.Updating or UpdateKind.Available => VioletColor, UpdateKind.Completed or UpdateKind.UpToDate or UpdateKind.Waiting => MintColor, _ => GreyColor };
        var brush = Solid(tint);
        var grid = new Grid { Width = 52, Height = 52, VerticalAlignment = VerticalAlignment.Center };
        grid.Children.Add(new Ellipse { Fill = Tint(tint, .15) });
        Control inner = kind switch
        {
            UpdateKind.Updating => new Spinner(brush, 24),
            UpdateKind.Available => FilledCircle(brush, UpdateIcons.ArrowDown, 28),
            UpdateKind.Completed => FilledCircle(brush, Icons.Check, 28),
            UpdateKind.UpToDate or UpdateKind.Waiting => Seal(brush, 30),
            UpdateKind.Failed => Outlined(Icons.Close, brush),
            UpdateKind.Unreachable => Icons.Draw(Icons.Warning, 22, brush),
            UpdateKind.Unconfirmed => Icons.Draw(UpdateIcons.Clock, 22, brush),
            UpdateKind.Unknown => Outlined(UpdateIcons.Question, brush),
            _ => Icons.Draw(UpdateIcons.Refresh, 22, brush)
        };
        grid.Children.Add(Centered(inner));
        return grid;
    }
    private static Control Outlined(string icon, IBrush color)
    {
        var grid = new Grid { Width = 26, Height = 26 };
        grid.Children.Add(new Ellipse { Stroke = color, StrokeThickness = 2 }); grid.Children.Add(Centered(Icons.Draw(icon, 14, color, thickness: 2.4)));
        return grid;
    }
    private static Control InfoLine(string icon, string text, IBrush color, double size = 13, bool filled = false, IBrush? iconColor = null)
    {
        var grid = new Grid { ColumnDefinitions = new ColumnDefinitions("Auto,*") };
        var glyph = Icons.Draw(icon, size + 2, iconColor ?? color, filled, filled ? 0 : 2); glyph.VerticalAlignment = VerticalAlignment.Top; glyph.Margin = new Thickness(0, 1, 8, 0); grid.Children.Add(glyph);
        var label = Label(text, size, color); Grid.SetColumn(label, 1); grid.Children.Add(label);
        return grid;
    }
    private static T Centered<T>(T element) where T : Control { element.HorizontalAlignment = HorizontalAlignment.Center; element.VerticalAlignment = VerticalAlignment.Center; return element; }

    // ---- sections ----
    private void Render()
    {
        var requests = center.Requests;
        current = UpdateScreen.Current(inventory, requests);
        candidates = UpdateScreen.Candidates(inventory);
        kind = UpdateScreen.Kind(inventory, readError is not null, current, UpdateScreen.HasUnreadRequest(requests));
        if (kind == UpdateKind.Updating) { plan = null; choosing = false; poll.Start(); } else poll.Stop();
        stack.Children.Clear();
        Add(HeroCard());
        var attention = Parts().Where(part => part.Status.Tone == "attention").ToArray();
        if (attention.Length > 0) Add(AttentionBanner(attention));
        if (plan is { } selected) Add(Confirmation(selected));
        else if (choosing && candidates.Length > 1) Add(Chooser());
        if ((inventory?.Components ?? []).Length > 0) Add(PartList());
        var changes = UpdateScreen.Changes(inventory).Where(value => !string.IsNullOrWhiteSpace(value) && !System.Text.RegularExpressions.Regex.IsMatch(value, @"[a-f0-9]{40,64}|sha256:|\b(?:commit|schema|API|CLI)\b|開発者", System.Text.RegularExpressions.RegexOptions.IgnoreCase)).ToArray();
        if (changes.Length > 0 && plan is null && kind is UpdateKind.Available or UpdateKind.Failed) Add(ChangeList(changes));
        var jobs = UpdateScreen.Jobs(inventory, current);
        if (Parts().Length == 0 && jobs.Length > 0) Add(JobList(jobs));
        if (inventory?.Problems is { Length: > 0 } problems) Add(ProblemList(problems));
        Add(Details(jobs, requests));
    }
    private (UpdateComponent Component, UpdatePartStatus Status)[] Parts() => (inventory?.Components ?? []).Select(item => (Component: item, Status: item.Part)).Where(item => item.Status is not null).Select(item => (item.Component, item.Status!)).ToArray();

    private Control HeroCard()
    {
        var (title, detail) = UpdateScreen.Hero(kind, inventory, current);
        var column = new StackPanel();
        var row = new Grid { ColumnDefinitions = new ColumnDefinitions("Auto,*") };
        row.Children.Add(HeroIcon(kind));
        var texts = new StackPanel { Margin = new Thickness(14, 0, 0, 0), VerticalAlignment = VerticalAlignment.Center };
        var heading = Label(title, 18, BellTheme.Ink, FontWeight.Bold); AutomationProperties.SetAutomationId(heading, "update-status");
        texts.Children.Add(heading); texts.Children.Add(Label(detail, 13, BellTheme.Secondary, margin: new Thickness(0, 3, 0, 0)));
        Grid.SetColumn(texts, 1); row.Children.Add(texts); column.Children.Add(row);
        if (actionMessage is not null)
        {
            var note = new Border { Background = Tint(GreyColor, .12), CornerRadius = new CornerRadius(10), Padding = new Thickness(10), Margin = new Thickness(0, 16, 0, 0), Child = InfoLine(UpdateIcons.Info, "操作を完了できませんでした。内容は「詳細」で確認できます。", BellTheme.Ink, 12) };
            AutomationProperties.SetAutomationId(note, "update-message"); column.Children.Add(note);
        }
        void Choose() { if (candidates.Length == 1) _ = PlanAsync(candidates[0].Id); else { choosing = true; Render(); } }
        void AddButton(Button button, string id) { button.Margin = new Thickness(0, 16, 0, 0); AutomationProperties.SetAutomationId(button, id); column.Children.Add(button); }
        if (kind == UpdateKind.Available && plan is null) AddButton(Pill("更新する", true, Choose, CanStartPlan), "update-start");
        else if (kind == UpdateKind.Failed && plan is null && candidates.Length > 0) AddButton(Pill("もう一度更新する", true, Choose, CanStartPlan), "update-start");
        else if (kind is UpdateKind.Unreachable or UpdateKind.Unconfirmed or UpdateKind.Failed or UpdateKind.Unknown)
        {
            AddButton(Pill("状況を確認", false, () => { actionMessage = null; _ = RefreshAsync(); }), "update-refresh");
            // An unconfirmed result still lets the owner pick a fresh plan; the same plan is refused by UpdateCenter.PlanAsync.
            if (kind == UpdateKind.Unconfirmed && plan is null && CanStartPlan && candidates.Length > 0)
            {
                var another = Capsule("別の更新を選ぶ", Brushes.Transparent, BellTheme.Violet, 8, 13, new Thickness(8, 6)); another.HorizontalAlignment = HorizontalAlignment.Center;
                another.Click += (_, _) => Choose(); AddButton(another, "update-another-plan");
            }
        }
        return Card(column);
    }

    private Control Chooser()
    {
        var column = new StackPanel(); column.Children.Add(Label("どれを更新しますか", 15, BellTheme.Ink, FontWeight.SemiBold, new Thickness(0, 0, 0, 4)));
        foreach (var item in candidates)
        {
            var grid = new Grid { ColumnDefinitions = new ColumnDefinitions("*,Auto") };
            grid.Children.Add(Label(item.Name, 14)); var chevron = Icons.Draw(Icons.ChevronRight, 14, BellTheme.Secondary); Grid.SetColumn(chevron, 1); grid.Children.Add(chevron);
            var id = item.Id; var choice = MacUi.Bare(grid, () => _ = PlanAsync(id), item.Name); choice.Margin = new Thickness(0, 6); choice.IsEnabled = CanStartPlan;
            AutomationProperties.SetAutomationId(choice, "update-choose-" + item.Id); column.Children.Add(choice);
        }
        var cancel = Capsule("やめる", Brushes.Transparent, BellTheme.Violet, 8, 13, new Thickness(0, 6, 8, 2)); cancel.HorizontalAlignment = HorizontalAlignment.Left; cancel.Click += (_, _) => { choosing = false; Render(); };
        column.Children.Add(cancel);
        return Card(column);
    }

    private Control Confirmation(UpdatePlan target)
    {
        var names = string.Join("、", target.Targets.Select(item => UpdateScreen.ComponentName(inventory, item.ComponentId)));
        var ready = CanStartPlan && target.Compatibility.Compatible && target.Capability.Supported && target.ExpiresAt > DateTimeOffset.UtcNow;
        var wording = UpdateScreen.PlanWording(target);
        var column = new StackPanel();
        column.Children.Add(Label(wording.Title, 15, BellTheme.Ink, FontWeight.SemiBold));
        column.Children.Add(Label(names, 14, BellTheme.Ink, FontWeight.SemiBold, new Thickness(0, 12, 0, 0)));
        if (wording.ServerPlan is not null) { var raw = Label(wording.ServerPlan, 11.5, BellTheme.Muted, margin: new Thickness(0, 12, 0, 0), mono: true); AutomationProperties.SetAutomationId(raw, "update-server-plan"); column.Children.Add(raw); }
        var impact = InfoLine(target.Impact.ContainerRestart ? UpdateIcons.Pause : UpdateIcons.Info, target.Impact.Description, BellTheme.Muted); impact.Margin = new Thickness(0, 12, 0, 0); column.Children.Add(impact);
        if (!target.Compatibility.Compatible || !target.Capability.Supported) column.Children.Add(Label("この更新は、今の状態では適用できません。時間をおいて確認してください。", 13, BellTheme.Ink, margin: new Thickness(0, 12, 0, 0)));
        if (target.Impact.ContainerRestart)
        {
            var toggle = new CheckBox { Content = "会話と処理が一時止まることを確認しました", IsChecked = confirmedRestart, FontSize = 13, Foreground = BellTheme.Ink, Margin = new Thickness(0, 12, 0, 0), VerticalContentAlignment = VerticalAlignment.Center };
            toggle.IsCheckedChanged += (_, _) => { if ((toggle.IsChecked == true) != confirmedRestart) { confirmedRestart = toggle.IsChecked == true; Render(); } };
            AutomationProperties.SetAutomationId(toggle, "update-restart-confirm"); column.Children.Add(toggle);
        }
        var buttons = new Grid { Margin = new Thickness(0, 12, 0, 0), ColumnDefinitions = new ColumnDefinitions("Auto,12,*") };
        buttons.Children.Add(Pill("やめる", false, () => { plan = null; Render(); }));
        var go = Pill(wording.Button, true, () => _ = ExecuteAsync(target), ready && (!target.Impact.ContainerRestart || confirmedRestart)); Grid.SetColumn(go, 2);
        AutomationProperties.SetAutomationId(go, "update-execute"); buttons.Children.Add(go);
        column.Children.Add(buttons);
        return Card(column);
    }

    private Control AttentionBanner((UpdateComponent Component, UpdatePartStatus Status)[] parts)
    {
        var column = new StackPanel();
        var header = InfoLine(Icons.Warning, "確認が必要な機能があります", Solid(RedColor), 15);
        ((Grid)header).Children.OfType<TextBlock>().Last().FontWeight = FontWeight.SemiBold; column.Children.Add(header);
        foreach (var part in parts)
        {
            var item = new StackPanel { Margin = new Thickness(0, 10, 0, 0) };
            item.Children.Add(Label(part.Component.Name, 13, BellTheme.Ink, FontWeight.SemiBold));
            item.Children.Add(Label(part.Status.Line, 13, BellTheme.Ink, margin: new Thickness(0, 4, 0, 0)));
            if (part.Status.Action is { } action) item.Children.Add(Label("☞  " + action, 13, Solid(RedColor), FontWeight.SemiBold, new Thickness(0, 4, 0, 0)));
            AutomationProperties.SetAutomationId(item, "update-attention-" + part.Component.Id); column.Children.Add(item);
        }
        return new Border { Child = column, Padding = new Thickness(16), CornerRadius = new CornerRadius(16), Background = Tint(RedColor, .1), BorderBrush = Tint(RedColor, .35), BorderThickness = new Thickness(1) };
    }

    private Control PartList()
    {
        var section = new StackPanel();
        section.Children.Add(Label("機能", 12, BellTheme.Secondary, FontWeight.SemiBold, new Thickness(6, 0, 0, 8)));
        var rows = new StackPanel(); var components = inventory!.Components;
        for (var index = 0; index < components.Length; index++)
        {
            if (index > 0) rows.Children.Add(new Border { Height = 1, Background = Hairline, Margin = new Thickness(62, 0, 0, 0) });
            rows.Children.Add(PartRow(components[index]));
        }
        section.Children.Add(new Border { Child = rows, Background = Brushes.White, CornerRadius = new CornerRadius(16) });
        return section;
    }
    private Control PartRow(UpdateComponent component)
    {
        var badge = UpdateScreen.Badge(component, current);
        var tint = badge switch { UpdateBadge.UpToDate => MintColor, UpdateBadge.Available or UpdateBadge.Updating => VioletColor, UpdateBadge.Failed => RedColor, _ => GreyColor };
        var grid = new Grid { Margin = new Thickness(14, 10), ColumnDefinitions = new ColumnDefinitions("34,*,Auto") };
        var tile = new Border { Width = 34, Height = 34, CornerRadius = new CornerRadius(8), Background = Solid(badge == UpdateBadge.Failed ? RedColor : VioletColor), Child = Centered(Icons.Draw(UpdateIcons.For(component.Id), 17, Brushes.White, thickness: 1.8)) };
        grid.Children.Add(tile);
        var texts = new StackPanel { Margin = new Thickness(12, 0, 8, 0), VerticalAlignment = VerticalAlignment.Center };
        texts.Children.Add(Label(component.Name, 14, BellTheme.Ink, FontWeight.Medium));
        texts.Children.Add(Label(string.Join(" · ", new[] { UpdateScreen.VersionName(component), UpdateScreen.LastUpdated(component) }.OfType<string>()), 12, BellTheme.Secondary, margin: new Thickness(0, 2, 0, 0)));
        Grid.SetColumn(texts, 1); grid.Children.Add(texts);
        var content = new StackPanel { Orientation = Orientation.Horizontal };
        if (badge == UpdateBadge.Updating) { var spin = new Spinner(Solid(tint), 11) { Margin = new Thickness(0, 0, 5, 0) }; content.Children.Add(spin); }
        content.Children.Add(Label(UpdateScreen.BadgeText(badge), 11.5, Solid(tint), FontWeight.SemiBold));
        var pill = StatusTag(content, tint, new Thickness(9, 3)); Grid.SetColumn(pill, 2); grid.Children.Add(pill);
        AutomationProperties.SetAutomationId(grid, "update-part-" + component.Id);
        return grid;
    }

    private Control ChangeList(string[] changes)
    {
        var column = new StackPanel(); column.Children.Add(Label("更新内容", 15, BellTheme.Ink, FontWeight.SemiBold));
        foreach (var change in changes)
        {
            var line = InfoLine(Icons.Sparkle, change, BellTheme.Ink, filled: true, iconColor: BellTheme.Violet); line.Margin = new Thickness(0, 10, 0, 0); column.Children.Add(line);
        }
        return Card(column);
    }

    private IEnumerable<Control> JobRows(UpdateJob[] jobs)
    {
        foreach (var job in jobs)
        {
            var item = new StackPanel { Margin = new Thickness(0, 10, 0, 0) };
            item.Children.Add(Label(UpdateScreen.ComponentName(inventory, job.Target.ModuleId), 13, BellTheme.Ink, FontWeight.SemiBold));
            item.Children.Add(Label("状態: " + job.State, 13));
            item.Children.Add(Label("ジョブID: " + job.JobId, 11.5, BellTheme.Muted, mono: true));
            if (job.Reason is { } reason) item.Children.Add(Label(reason.Code + " / " + reason.Message, 13, Solid(RedColor)));
            AutomationProperties.SetAutomationId(item, "update-job-" + job.JobId); yield return item;
        }
    }
    private Control JobList(UpdateJob[] jobs)
    {
        var column = new StackPanel(); column.Children.Add(Label("ジョブの状態", 15, BellTheme.Ink, FontWeight.SemiBold));
        foreach (var row in JobRows(jobs)) column.Children.Add(row);
        return Card(column, 16);
    }
    private Control ProblemList(UpdateProblem[] problems)
    {
        var column = new StackPanel(); column.Children.Add(Label("機能の問題", 15, BellTheme.Ink, FontWeight.SemiBold));
        foreach (var problem in problems)
        {
            var item = new StackPanel { Margin = new Thickness(0, 10, 0, 0) };
            item.Children.Add(Label($"{UpdateScreen.ComponentName(inventory, problem.ModuleId)} · 再起動の繰り返し · {(problem.Status == "resolved" ? "解決済み" : "問題あり")}", 13, BellTheme.Ink, FontWeight.SemiBold));
            item.Children.Add(Label($"再起動回数: {problem.Count} / 集計期間（秒）: {problem.WindowSeconds}", 13));
            item.Children.Add(Label($"直近の終了コード: {(problem.LastExit.Code?.ToString() ?? "未観測")} / シグナル: {problem.LastExit.Signal ?? "未観測"}", 13));
            item.Children.Add(Label("直近の理由: " + problem.LastReason, 13));
            AutomationProperties.SetAutomationId(item, "update-problem-" + problem.Fingerprint); column.Children.Add(item);
        }
        return Card(column, 16);
    }

    // ---- 詳細 (technical values; closed by default) ----
    private static string Reason(string? code) => code is null ? "" : "（" + code + "）";
    private Control Details(UpdateJob[] jobs, UpdateRequest[] requests)
    {
        var lines = new StackPanel { Margin = new Thickness(0, 10, 0, 0), IsVisible = detailsOpen };
        void Line(string text, bool heading = false) => lines.Children.Add(Label(text, heading ? 13 : 11.5, heading ? BellTheme.Ink : BellTheme.Muted, heading ? FontWeight.SemiBold : FontWeight.Normal, new Thickness(0, heading ? 14 : 3, 0, 0), mono: !heading));
        if (actionMessage is not null) Line("お知らせ: " + actionMessage);
        // An unreadable inventory (for example 503 UNREADABLE) shows the reason as is; no state is made up.
        if (readError is not null) Line("取得エラー: " + readError);
        if (inventory?.Notice is { } notice) Line("サーバー: " + notice.Message + Reason(notice.Code));
        foreach (var component in inventory?.Components ?? [])
        {
            Line(component.Name, true); Line(component.Description);
            Line($"稼働中: {UpdateScreen.Label(component.Current)} / 公開版: {UpdateScreen.Label(component.Published)}");
            Line("比較: " + UpdateScreen.ComparisonText(component.Comparison.State) + Reason(component.Comparison.Reason));
            if (component.Capability.Reason is { } why) Line($"更新: できません（{why}）");
            if (component.Availability.Available == false) Line("利用: できません" + Reason(component.Availability.Reason));
            if (component.Part?.LatestJob is { } job) { Line($"最新のジョブ: {job.JobId} / {job.Kind} / {job.State} / {job.Outcome} / {job.At}"); if (job.Reason is { } reason) Line(reason.Code + " / " + reason.Message); }
        }
        if (Parts().Length > 0 && jobs.Length > 0) { Line("ジョブの記録", true); foreach (var row in JobRows(jobs)) lines.Children.Add(row); }
        void Operation(UpdateOperation? value, string title)
        {
            if (value is null) return;
            Line(title, true); Line("要求ID: " + value.RequestId);
            Line($"{UpdateScreen.PhaseText(value.Phase)} / 受付: {UpdateScreen.AdmissionText(value.Admission)} / 実行: {UpdateScreen.OutcomeText(value.Execution)} / 稼働確認: {UpdateScreen.OutcomeText(value.Verification)}");
            if (value.Error is { } error) Line(error.Code + ": " + error.Message);
        }
        Operation(current, "今回の更新"); if (inventory?.PreviousOperation is { } previous && previous.RequestId != current?.RequestId) Operation(previous, "前回の更新");
        if (plan is { } open) { Line("計画ID: " + open.PlanId); Line("有効期限: " + open.ExpiresAt.LocalDateTime); }
        if (requests.Length > 0)
        {
            Line("保持している操作結果", true);
            foreach (var request in requests)
            {
                Line("要求ID: " + request.RequestId); Line("計画ID: " + request.PlanId);
                if (request.Result is { } result) Line($"{UpdateScreen.PhaseText(result.Phase)} / 受付: {UpdateScreen.AdmissionText(result.Admission)}");
                if (request.Rejection is { } note) Line(note);
            }
        }
        // The Windows Expander with its own disclosure template: a header row with a chevron, the lines below it.
        var header = new Grid { ColumnDefinitions = new ColumnDefinitions("*,Auto") };
        header.Children.Add(Label("詳細", 13)); var chevron = Icons.Draw(detailsOpen ? Icons.ChevronDown : Icons.ChevronRight, 12, BellTheme.Ink); chevron.Margin = new Thickness(0, 0, 6, 0); Grid.SetColumn(chevron, 1); header.Children.Add(chevron);
        var toggle = MacUi.Bare(header, () => { detailsOpen = !detailsOpen; Render(); }, "詳細");
        var expander = new StackPanel { Margin = new Thickness(4, 0), Children = { toggle, lines } };
        AutomationProperties.SetAutomationId(expander, "update-details");
        return expander;
    }
}
