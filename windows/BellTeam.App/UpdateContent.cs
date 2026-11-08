using System.Windows;
using System.Windows.Controls;
using System.Windows.Markup;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Shapes;
using System.Windows.Threading;
using BellTeam.Core;

namespace BellTeam.App;

// The Mac UpdateContent: hero card, attention banner, chooser or confirmation, part list, change list, jobs, problems and a closed 詳細.
// Shared by the Settings アップデート page and the Update sheet; the state logic lives in Core UpdateScreen.
public sealed class UpdateContent : UserControl, IDisposable
{
    private static readonly Color VioletColor = Color.FromRgb(0x61, 0x47, 0xD4), MintColor = Color.FromRgb(0x2E, 0xB3, 0x9E), RedColor = Color.FromRgb(0xFF, 0x3B, 0x30), GreyColor = Color.FromRgb(0x8A, 0x8A, 0x8E);
    private static Brush Group => Palette.Get("Grouped");
    private readonly Workspace workspace;
    private readonly UpdateCenter center;
    private readonly StackPanel stack = new() { Margin = new Thickness(18, 22, 18, 22), MaxWidth = 620 };
    private readonly ScrollViewer scroller = new() { VerticalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled };
    private readonly DispatcherTimer poll = new() { Interval = TimeSpan.FromSeconds(5) };
    private UpdateInventory? inventory;
    private string? readError, actionMessage;
    private UpdatePlan? plan;
    private bool choosing, confirmedRestart, detailsOpen, refreshing;
    private UpdateKind kind = UpdateKind.Loading;
    private UpdateOperation? current;
    private UpdateComponent[] candidates = [];

    public UpdateContent(Workspace workspace, SettingsStore? settings = null)
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
    public void Dispose() { workspace.UpdatesChanged -= Changed; poll.Stop(); }
    public void ScrollToEnd() { scroller.ScrollToEnd(); scroller.UpdateLayout(); }
    private void Changed() { if (!Busy) _ = RefreshAsync(); }
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
        finally { refreshing = false; Render(); }
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
        finally { Busy = false; Render(); }
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
    private static SolidColorBrush Tint(Color color, double opacity) => new(Color.FromArgb((byte)(opacity * 255), color.R, color.G, color.B));
    private static SolidColorBrush Solid(Color color) => new(color);
    private static TextBlock Label(string text, double size, Brush? color = null, FontWeight? weight = null, Thickness? margin = null, bool mono = false)
    {
        var block = SettingsUi.Text(text, size, color ?? SettingsUi.Ink, weight, margin);
        if (mono) block.FontFamily = new FontFamily("Consolas, Yu Gothic UI");
        return block;
    }
    private static Border Card(UIElement child, double padding = 18) => new() { Child = child, Background = Palette.Card, CornerRadius = new CornerRadius(16), Padding = new Thickness(padding) };
    private void Add(UIElement element) { if (element is FrameworkElement item) item.Margin = new Thickness(item.Margin.Left, stack.Children.Count == 0 ? 0 : 22, item.Margin.Right, item.Margin.Bottom); stack.Children.Add(element); }
    private static Button Pill(string label, bool prominent, Action click, bool enabled = true)
    {
        var button = SettingsUi.Capsule(label, prominent ? SettingsUi.Violet : Tint(VioletColor, .12), prominent ? Brushes.White : SettingsUi.Violet, 22, 15, new Thickness(18, 11, 18, 11));
        button.HorizontalAlignment = HorizontalAlignment.Stretch; button.IsEnabled = enabled; button.Click += (_, _) => click();
        return button;
    }
    private static Border Capsule(UIElement child, Color tint, Thickness padding) => new() { Child = child, Background = Tint(tint, .14), CornerRadius = new CornerRadius(12), Padding = padding, VerticalAlignment = VerticalAlignment.Center };
    private static FrameworkElement Spinner(double size, Brush color)
    {
        var arc = new Path { Stroke = color, StrokeThickness = Math.Max(1.5, size / 9), StrokeStartLineCap = PenLineCap.Round, StrokeEndLineCap = PenLineCap.Round, Width = size, Height = size, RenderTransformOrigin = new Point(.5, .5), RenderTransform = new RotateTransform() };
        var r = size / 2 - 1.5; arc.Data = Geometry.Parse($"M {size / 2},1.5 A {r},{r} 0 1 1 1.5,{size / 2}");
        arc.RenderTransform.BeginAnimation(RotateTransform.AngleProperty, new DoubleAnimation(0, 360, TimeSpan.FromSeconds(1)) { RepeatBehavior = RepeatBehavior.Forever });
        return arc;
    }
    private static FrameworkElement FilledCircle(Brush color, string glyph, double size)
    {
        var grid = new Grid { Width = size, Height = size };
        grid.Children.Add(new Ellipse { Fill = color }); grid.Children.Add(SettingsUi.Glyph(glyph, size * .5, Brushes.White).Centered());
        return grid;
    }
    private static FrameworkElement Seal(Brush color, double size)
    {
        var grid = new Grid { Width = size, Height = size };
        var side = size * .74;
        foreach (var angle in new[] { 0.0, 45.0 }) grid.Children.Add(new Border { Width = side, Height = side, CornerRadius = new CornerRadius(side * .3), Background = color, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center, RenderTransformOrigin = new Point(.5, .5), RenderTransform = new RotateTransform(angle) });
        grid.Children.Add(SettingsUi.Glyph("\uE73E", size * .46, Brushes.White).Centered());
        return grid;
    }
    private static FrameworkElement HeroIcon(UpdateKind kind)
    {
        var tint = kind switch { UpdateKind.Updating or UpdateKind.Available => VioletColor, UpdateKind.Completed or UpdateKind.UpToDate => MintColor, _ => GreyColor };
        var brush = Solid(tint);
        var grid = new Grid { Width = 52, Height = 52, VerticalAlignment = VerticalAlignment.Center };
        grid.Children.Add(new Ellipse { Fill = Tint(tint, .15) });
        FrameworkElement inner = kind switch
        {
            UpdateKind.Updating => Spinner(24, brush),
            UpdateKind.Available => FilledCircle(brush, "\uE74B", 28),
            UpdateKind.Completed => FilledCircle(brush, "\uE73E", 28),
            UpdateKind.UpToDate => Seal(brush, 30),
            UpdateKind.Failed => Outlined("\uE711", brush),
            UpdateKind.Unreachable => SettingsUi.Glyph("\uE7BA", 22, brush),
            UpdateKind.Unconfirmed => SettingsUi.Glyph("\uE81C", 22, brush),
            UpdateKind.Unknown => Outlined("\uE897", brush),
            _ => SettingsUi.Glyph("\uE895", 22, brush)
        };
        grid.Children.Add(inner.Centered());
        return grid;
    }
    private static FrameworkElement Outlined(string glyph, Brush color)
    {
        var grid = new Grid { Width = 26, Height = 26 };
        grid.Children.Add(new Ellipse { Stroke = color, StrokeThickness = 2 }); grid.Children.Add(SettingsUi.Glyph(glyph, 12, color).Centered());
        return grid;
    }
    private static FrameworkElement InfoLine(string glyph, string text, Brush color, double size = 13)
    {
        var grid = new Grid(); grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto }); grid.ColumnDefinitions.Add(new ColumnDefinition());
        var icon = SettingsUi.Glyph(glyph, size, color); icon.VerticalAlignment = VerticalAlignment.Top; icon.Margin = new Thickness(0, 2, 8, 0); grid.Children.Add(icon);
        var label = Label(text, size, color); Grid.SetColumn(label, 1); grid.Children.Add(label);
        return grid;
    }

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

    private FrameworkElement HeroCard()
    {
        var (title, detail) = UpdateScreen.Hero(kind, inventory, current);
        var column = new StackPanel();
        var row = new Grid(); row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto }); row.ColumnDefinitions.Add(new ColumnDefinition());
        row.Children.Add(HeroIcon(kind));
        var texts = new StackPanel { Margin = new Thickness(14, 0, 0, 0), VerticalAlignment = VerticalAlignment.Center };
        var heading = Label(title, 18, SettingsUi.Ink, FontWeights.Bold); System.Windows.Automation.AutomationProperties.SetAutomationId(heading, "update-status");
        texts.Children.Add(heading); texts.Children.Add(Label(detail, 13, SettingsUi.Secondary, null, new Thickness(0, 3, 0, 0)));
        Grid.SetColumn(texts, 1); row.Children.Add(texts); column.Children.Add(row);
        if (actionMessage is not null)
        {
            var note = new Border { Background = Tint(GreyColor, .12), CornerRadius = new CornerRadius(10), Padding = new Thickness(10), Margin = new Thickness(0, 16, 0, 0), Child = InfoLine("\uE946", "操作を完了できませんでした。内容は「詳細」で確認できます。", SettingsUi.Ink, 12) };
            System.Windows.Automation.AutomationProperties.SetAutomationId(note, "update-message"); column.Children.Add(note);
        }
        void Choose() { if (candidates.Length == 1) _ = PlanAsync(candidates[0].Id); else { choosing = true; Render(); } }
        void Add(Button button, string id) { button.Margin = new Thickness(0, 16, 0, 0); System.Windows.Automation.AutomationProperties.SetAutomationId(button, id); column.Children.Add(button); }
        if (kind == UpdateKind.Available && plan is null) Add(Pill("更新する", true, Choose, CanStartPlan), "update-start");
        else if (kind == UpdateKind.Failed && plan is null && candidates.Length > 0) Add(Pill("もう一度更新する", true, Choose, CanStartPlan), "update-start");
        else if (kind is UpdateKind.Unreachable or UpdateKind.Unconfirmed or UpdateKind.Failed or UpdateKind.Unknown)
        {
            Add(Pill("状況を確認", false, () => { actionMessage = null; _ = RefreshAsync(); }), "update-refresh");
            // An unconfirmed result still lets the owner pick a fresh plan; the same plan is refused by UpdateCenter.PlanAsync.
            if (kind == UpdateKind.Unconfirmed && plan is null && CanStartPlan && candidates.Length > 0)
            {
                var another = SettingsUi.Capsule("別の更新を選ぶ", Brushes.Transparent, SettingsUi.Violet, 8, 13, new Thickness(8, 6, 8, 6)); another.HorizontalAlignment = HorizontalAlignment.Center;
                another.Click += (_, _) => Choose(); Add(another, "update-another-plan");
            }
        }
        return Card(column);
    }

    private FrameworkElement Chooser()
    {
        var column = new StackPanel(); column.Children.Add(Label("どれを更新しますか", 15, SettingsUi.Ink, FontWeights.SemiBold, new Thickness(0, 0, 0, 4)));
        foreach (var item in candidates)
        {
            var grid = new Grid(); grid.ColumnDefinitions.Add(new ColumnDefinition()); grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            grid.Children.Add(Label(item.Name, 14)); var chevron = SettingsUi.Glyph("\uE76C", 11, SettingsUi.Secondary); Grid.SetColumn(chevron, 1); grid.Children.Add(chevron);
            var id = item.Id; var choice = new Button { Content = grid, Template = RowTemplate, Margin = new Thickness(0, 6, 0, 6), IsEnabled = CanStartPlan, Cursor = System.Windows.Input.Cursors.Hand };
            choice.Click += (_, _) => _ = PlanAsync(id); System.Windows.Automation.AutomationProperties.SetName(choice, item.Name);
            System.Windows.Automation.AutomationProperties.SetAutomationId(choice, "update-choose-" + item.Id); column.Children.Add(choice);
        }
        var cancel = SettingsUi.Capsule("やめる", Brushes.Transparent, SettingsUi.Violet, 8, 13, new Thickness(0, 6, 8, 2)); cancel.HorizontalAlignment = HorizontalAlignment.Left; cancel.Click += (_, _) => { choosing = false; Render(); };
        column.Children.Add(cancel);
        return Card(column);
    }

    private FrameworkElement Confirmation(UpdatePlan target)
    {
        var names = string.Join("、", target.Targets.Select(item => UpdateScreen.ComponentName(inventory, item.ComponentId)));
        var ready = CanStartPlan && target.Compatibility.Compatible && target.Capability.Supported && target.ExpiresAt > DateTimeOffset.UtcNow;
        var wording = UpdateScreen.PlanWording(target);
        var column = new StackPanel();
        column.Children.Add(Label(wording.Title, 15, SettingsUi.Ink, FontWeights.SemiBold));
        column.Children.Add(Label(names, 14, SettingsUi.Ink, FontWeights.SemiBold, new Thickness(0, 12, 0, 0)));
        if (wording.ServerPlan is not null) { var raw = Label(wording.ServerPlan, 11.5, SettingsUi.Muted, null, new Thickness(0, 12, 0, 0), mono: true); System.Windows.Automation.AutomationProperties.SetAutomationId(raw, "update-server-plan"); column.Children.Add(raw); }
        var impact = InfoLine(target.Impact.ContainerRestart ? "\uE769" : "\uE946", target.Impact.Description, SettingsUi.Muted); impact.Margin = new Thickness(0, 12, 0, 0); column.Children.Add(impact);
        if (!target.Compatibility.Compatible || !target.Capability.Supported) column.Children.Add(Label("この更新は、今の状態では適用できません。時間をおいて確認してください。", 13, SettingsUi.Ink, null, new Thickness(0, 12, 0, 0)));
        if (target.Impact.ContainerRestart)
        {
            var toggle = new CheckBox { Content = "会話と処理が一時止まることを確認しました", IsChecked = confirmedRestart, FontSize = 13, Foreground = SettingsUi.Ink, Margin = new Thickness(0, 12, 0, 0), VerticalContentAlignment = VerticalAlignment.Center };
            toggle.Click += (_, _) => { confirmedRestart = toggle.IsChecked == true; Render(); };
            System.Windows.Automation.AutomationProperties.SetAutomationId(toggle, "update-restart-confirm"); column.Children.Add(toggle);
        }
        var buttons = new Grid { Margin = new Thickness(0, 12, 0, 0) }; buttons.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto }); buttons.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(12) }); buttons.ColumnDefinitions.Add(new ColumnDefinition());
        buttons.Children.Add(Pill("やめる", false, () => { plan = null; Render(); }));
        var go = Pill(wording.Button, true, () => _ = ExecuteAsync(target), ready && (!target.Impact.ContainerRestart || confirmedRestart)); Grid.SetColumn(go, 2);
        System.Windows.Automation.AutomationProperties.SetAutomationId(go, "update-execute"); buttons.Children.Add(go);
        column.Children.Add(buttons);
        return Card(column);
    }

    private FrameworkElement AttentionBanner((UpdateComponent Component, UpdatePartStatus Status)[] parts)
    {
        var column = new StackPanel();
        column.Children.Add(InfoLine("\uE7BA", "確認が必要な機能があります", Palette.Get("Red"), 15));
        ((Grid)column.Children[0]).Children.OfType<TextBlock>().Last().FontWeight = FontWeights.SemiBold;
        foreach (var part in parts)
        {
            var item = new StackPanel { Margin = new Thickness(0, 10, 0, 0) };
            item.Children.Add(Label(part.Component.Name, 13, SettingsUi.Ink, FontWeights.SemiBold));
            item.Children.Add(Label(part.Status.Line, 13, SettingsUi.Ink, null, new Thickness(0, 4, 0, 0)));
            if (part.Status.Action is { } action)
            {
                var hint = Label("☞  " + action, 13, Palette.Get("Red"), FontWeights.SemiBold, new Thickness(0, 4, 0, 0)); hint.FontFamily = new FontFamily("Yu Gothic UI, Segoe UI Symbol"); item.Children.Add(hint);
            }
            System.Windows.Automation.AutomationProperties.SetAutomationId(item, "update-attention-" + part.Component.Id); column.Children.Add(item);
        }
        return new Border { Child = column, Padding = new Thickness(16), CornerRadius = new CornerRadius(16), Background = Tint(RedColor, .1), BorderBrush = Tint(RedColor, .35), BorderThickness = new Thickness(1) };
    }

    private static string IconFor(string id) => id switch
    {
        "container" => "\uE7B8", "web-gateway" => "\uE774", "notifications" => "\uEA8F", "members" => "\uE716", "memory" => "\uE950", "diagnostics" => "\uE9D9",
        "usage" => "\uE9D2", "execution" => "\uE945", "conversation" => "\uE8BD", _ => "\uEA86"
    };
    private FrameworkElement PartList()
    {
        var section = new StackPanel();
        section.Children.Add(Label("機能", 12, SettingsUi.Secondary, FontWeights.SemiBold, new Thickness(6, 0, 0, 8)));
        var rows = new StackPanel(); var components = inventory!.Components;
        for (var index = 0; index < components.Length; index++)
        {
            if (index > 0) rows.Children.Add(new Border { Height = 1, Background = SettingsUi.Hairline, Margin = new Thickness(62, 0, 0, 0) });
            rows.Children.Add(PartRow(components[index]));
        }
        section.Children.Add(new Border { Child = rows, Background = Palette.Card, CornerRadius = new CornerRadius(16) });
        return section;
    }
    private FrameworkElement PartRow(UpdateComponent component)
    {
        var badge = UpdateScreen.Badge(component, current);
        var tint = badge switch { UpdateBadge.UpToDate => MintColor, UpdateBadge.Available or UpdateBadge.Updating => VioletColor, UpdateBadge.Failed => RedColor, _ => GreyColor };
        var grid = new Grid { Margin = new Thickness(14, 10, 14, 10) };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(34) }); grid.ColumnDefinitions.Add(new ColumnDefinition()); grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var tile = new Border { Width = 34, Height = 34, CornerRadius = new CornerRadius(8), Background = Solid(badge == UpdateBadge.Failed ? RedColor : VioletColor), Child = SettingsUi.Glyph(IconFor(component.Id), 15, Brushes.White).Centered() };
        grid.Children.Add(tile);
        var texts = new StackPanel { Margin = new Thickness(12, 0, 8, 0), VerticalAlignment = VerticalAlignment.Center };
        texts.Children.Add(Label(component.Name, 14, SettingsUi.Ink, FontWeights.Medium));
        texts.Children.Add(Label(string.Join(" · ", new[] { UpdateScreen.VersionName(component), UpdateScreen.LastUpdated(component) }.OfType<string>()), 12, SettingsUi.Secondary, null, new Thickness(0, 2, 0, 0)));
        Grid.SetColumn(texts, 1); grid.Children.Add(texts);
        var content = new StackPanel { Orientation = Orientation.Horizontal };
        if (badge == UpdateBadge.Updating) { var spin = Spinner(11, Solid(tint)); spin.Margin = new Thickness(0, 0, 5, 0); spin.VerticalAlignment = VerticalAlignment.Center; content.Children.Add(spin); }
        content.Children.Add(Label(UpdateScreen.BadgeText(badge), 11.5, Solid(tint), FontWeights.SemiBold));
        var pill = Capsule(content, tint, new Thickness(9, 3, 9, 3)); Grid.SetColumn(pill, 2); grid.Children.Add(pill);
        System.Windows.Automation.AutomationProperties.SetAutomationId(grid, "update-part-" + component.Id);
        return grid;
    }

    private FrameworkElement ChangeList(string[] changes)
    {
        var column = new StackPanel(); column.Children.Add(Label("更新内容", 15, SettingsUi.Ink, FontWeights.SemiBold));
        foreach (var change in changes)
        {
            var line = InfoLine("✦", change, SettingsUi.Ink); line.Margin = new Thickness(0, 10, 0, 0);
            var icon = ((Grid)line).Children.OfType<TextBlock>().First(); icon.FontFamily = new FontFamily("Segoe UI Symbol"); icon.Foreground = SettingsUi.Violet; column.Children.Add(line);
        }
        return Card(column);
    }

    private IEnumerable<FrameworkElement> JobRows(UpdateJob[] jobs)
    {
        foreach (var job in jobs)
        {
            var item = new StackPanel { Margin = new Thickness(0, 10, 0, 0) };
            item.Children.Add(Label(UpdateScreen.ComponentName(inventory, job.Target.ModuleId), 13, SettingsUi.Ink, FontWeights.SemiBold));
            item.Children.Add(Label("状態: " + job.State, 13));
            item.Children.Add(Label("ジョブID: " + job.JobId, 11.5, SettingsUi.Muted, null, null, mono: true));
            if (job.Reason is { } reason) item.Children.Add(Label(reason.Code + " / " + reason.Message, 13, Palette.Get("Red")));
            System.Windows.Automation.AutomationProperties.SetAutomationId(item, "update-job-" + job.JobId); yield return item;
        }
    }
    private FrameworkElement JobList(UpdateJob[] jobs)
    {
        var column = new StackPanel(); column.Children.Add(Label("ジョブの状態", 15, SettingsUi.Ink, FontWeights.SemiBold));
        foreach (var row in JobRows(jobs)) column.Children.Add(row);
        return Card(column, 16);
    }
    private FrameworkElement ProblemList(UpdateProblem[] problems)
    {
        var column = new StackPanel(); column.Children.Add(Label("機能の問題", 15, SettingsUi.Ink, FontWeights.SemiBold));
        foreach (var problem in problems)
        {
            var item = new StackPanel { Margin = new Thickness(0, 10, 0, 0) };
            item.Children.Add(Label($"{UpdateScreen.ComponentName(inventory, problem.ModuleId)} · 再起動の繰り返し · {(problem.Status == "resolved" ? "解決済み" : "問題あり")}", 13, SettingsUi.Ink, FontWeights.SemiBold));
            item.Children.Add(Label($"再起動回数: {problem.Count} / 集計期間（秒）: {problem.WindowSeconds}", 13));
            item.Children.Add(Label($"直近の終了コード: {(problem.LastExit.Code?.ToString() ?? "未観測")} / シグナル: {problem.LastExit.Signal ?? "未観測"}", 13));
            item.Children.Add(Label("直近の理由: " + problem.LastReason, 13));
            System.Windows.Automation.AutomationProperties.SetAutomationId(item, "update-problem-" + problem.Fingerprint); column.Children.Add(item);
        }
        return Card(column, 16);
    }

    // ---- 詳細 (technical values; closed by default) ----
    private static string Reason(string? code) => code is null ? "" : "（" + code + "）";
    private FrameworkElement Details(UpdateJob[] jobs, UpdateRequest[] requests)
    {
        var lines = new StackPanel { Margin = new Thickness(0, 10, 0, 0) };
        void Line(string text, bool heading = false) => lines.Children.Add(Label(text, heading ? 13 : 11.5, heading ? SettingsUi.Ink : SettingsUi.Muted, heading ? FontWeights.SemiBold : null, new Thickness(0, heading ? 14 : 3, 0, 0), mono: !heading));
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
        var expander = new Expander { Header = "詳細", Content = lines, IsExpanded = detailsOpen, Template = DisclosureTemplate, FontSize = 13, Foreground = SettingsUi.Ink, Margin = new Thickness(4, 0, 4, 0) };
        expander.Expanded += (_, _) => detailsOpen = true; expander.Collapsed += (_, _) => detailsOpen = false;
        System.Windows.Automation.AutomationProperties.SetAutomationId(expander, "update-details");
        return expander;
    }
    // Templates are thread-affine, so each use parses its own.
    private static ControlTemplate RowTemplate => (ControlTemplate)XamlReader.Parse(
        "<ControlTemplate xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\" TargetType=\"Button\"><Border Background=\"Transparent\"><ContentPresenter/></Border></ControlTemplate>");
    private static ControlTemplate DisclosureTemplate => (ControlTemplate)XamlReader.Parse(
        """
        <ControlTemplate xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" TargetType="Expander">
          <StackPanel>
            <ToggleButton IsChecked="{Binding IsExpanded, RelativeSource={RelativeSource TemplatedParent}, Mode=TwoWay}" Cursor="Hand" Focusable="True" Foreground="{DynamicResource RowText}">
              <ToggleButton.Template><ControlTemplate TargetType="ToggleButton"><Grid Background="Transparent"><Grid.ColumnDefinitions><ColumnDefinition/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
                <ContentPresenter Content="{Binding Header, RelativeSource={RelativeSource AncestorType=Expander}}" VerticalAlignment="Center"/>
                <TextBlock x:Name="Chevron" Grid.Column="1" Text="&#xE76C;" FontFamily="Segoe Fluent Icons, Segoe MDL2 Assets" FontSize="12" Foreground="{DynamicResource Ink}" VerticalAlignment="Center" Margin="0,0,6,0"/></Grid>
                <ControlTemplate.Triggers><Trigger Property="IsChecked" Value="True"><Setter TargetName="Chevron" Property="Text" Value="&#xE70D;"/></Trigger></ControlTemplate.Triggers></ControlTemplate></ToggleButton.Template>
            </ToggleButton>
            <ContentPresenter x:Name="Body" Visibility="Collapsed"/>
          </StackPanel>
          <ControlTemplate.Triggers><Trigger Property="IsExpanded" Value="True"><Setter TargetName="Body" Property="Visibility" Value="Visible"/></Trigger></ControlTemplate.Triggers>
        </ControlTemplate>
        """);
}

internal static class UpdateElementExtensions
{
    public static T Centered<T>(this T element) where T : FrameworkElement { element.HorizontalAlignment = HorizontalAlignment.Center; element.VerticalAlignment = VerticalAlignment.Center; return element; }
}
