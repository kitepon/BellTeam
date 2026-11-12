using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Controls.Primitives;
using Avalonia.Input;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Threading;
using BellTeam.Core;

namespace BellTeam.Linux;

// Segoe icons of the Windows pages as vector paths on the 24x24 canvas of Icons.
internal static class RequestIcons
{
    public const string Plus = "M12,5 V19 M5,12 H19";
    public const string Refresh = "M20,12 A8,8 0 1 1 17.66,6.34 M18,3 V7 H14";
    public const string Trash = "M4,7 H20 M9,7 V4.5 H15 V7 M6,7 L7,20 H17 L18,7 M10,11 V16 M14,11 V16";
    public const string Repeat = "M4,11 V9 a3,3 0 0 1 3,-3 H18 M15,3 L18,6 L15,9 M20,13 V15 a3,3 0 0 1 -3,3 H6 M9,21 L6,18 L9,15";
    public const string Clock = "M12,3 a9,9 0 1 0 0.01,0 Z M12,7 V12 L15.5,14";
    public const string List = "M9,6 H20 M9,12 H20 M9,18 H20 M4.5,6 H5.5 M4.5,12 H5.5 M4.5,18 H5.5";
}

internal static class GoalUi
{
    public static TextBlock Text(string text, double size, IBrush? foreground = null, FontWeight weight = FontWeight.Normal, Thickness? margin = null) => BellTheme.Text(text, size, foreground, weight, margin);

    // Mac ContentUnavailableView: a large symbol, a title and an optional description (and action), centred.
    public static StackPanel Unavailable(string icon, string title, string? description, Control? action = null)
    {
        var panel = new StackPanel { HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 42, 0, 20) };
        var symbol = Icons.Draw(icon, icon == Icons.Target ? 40 : 36, BellTheme.Muted, thickness: 1.4); symbol.HorizontalAlignment = HorizontalAlignment.Center; panel.Children.Add(symbol);
        var heading = Text(title, 17, BellTheme.Muted, FontWeight.SemiBold, new Thickness(0, 14, 0, 0)); heading.TextAlignment = TextAlignment.Center; panel.Children.Add(heading);
        if (description is not null) { var line = Text(description, 14, BellTheme.Muted, margin: new Thickness(0, 6, 0, 0)); line.TextAlignment = TextAlignment.Center; panel.Children.Add(line); }
        if (action is not null) panel.Children.Add(action);
        return panel;
    }

    // The 38-high round button of the page header: filled violet or white with a line.
    public static Button Round(string icon, string name, bool filled, bool chevron = false)
    {
        var ink = filled ? Brushes.White : BellTheme.Ink;
        var content = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center, Spacing = 5, Children = { Icons.Draw(icon, 16, ink, thickness: 2) } };
        if (chevron) content.Children.Add(Icons.Draw(Icons.ChevronDown, 10, ink, thickness: 2.4));
        var button = new Button
        {
            Classes = { "plain" }, Height = 38, MinWidth = 38, Padding = new Thickness(chevron ? 12 : 0, 0), Margin = new Thickness(4, 0, 0, 0), Content = content, CornerRadius = new CornerRadius(19),
            Background = filled ? BellTheme.Violet : Brushes.White, BorderBrush = BellTheme.Line, BorderThickness = new Thickness(filled ? 0 : 1), HorizontalContentAlignment = HorizontalAlignment.Center, VerticalContentAlignment = VerticalAlignment.Center
        };
        ToolTip.SetTip(button, name); AutomationProperties.SetName(button, name); return button;
    }

    // The default (bordered) button of a card: white with a line, violet text.
    public static Button ActionButton(string label, Action click, bool destructive, bool enabled)
    {
        var button = new Button { Classes = { "plain" }, Content = label, IsEnabled = enabled, Margin = new Thickness(0, 0, 10, 0), Background = Brushes.White, BorderBrush = BellTheme.Line, BorderThickness = new Thickness(1), Foreground = destructive ? BellTheme.Red : BellTheme.Violet, CornerRadius = new CornerRadius(10), Padding = new Thickness(14, 8), FontSize = 14 };
        AutomationProperties.SetName(button, label); button.Click += (_, _) => click(); return button;
    }

    // A read-only box whose text can be selected and copied (Windows SelectableBody).
    public static TextBox Selectable(string text, double size) => new() { Classes = { "bare" }, Text = text, IsReadOnly = true, TextWrapping = TextWrapping.Wrap, FontSize = size, Foreground = BellTheme.Ink, Padding = default };

    public static void OnUi(Action action) { if (Dispatcher.UIThread.CheckAccess()) action(); else Dispatcher.UIThread.Post(action); }
}

// One goal as the Mac GoalCard draws it: the page shows name, status, objective and usage; the chat presentation shows the objective and the notes.
internal static class GoalCard
{
    public static Border Build(GoalSnapshot snapshot, string name, bool busy, bool chat, Action<string> onEdit, Action<string> onAction)
    {
        var stack = new StackPanel();
        void Add(Control element) { if (stack.Children.Count != 0) element.Margin = new Thickness(element.Margin.Left, element.Margin.Top + 12, element.Margin.Right, element.Margin.Bottom); stack.Children.Add(element); }
        var muted = BellTheme.Muted;
        if (!chat) Add(GoalUi.Text(name, 20, weight: FontWeight.Bold));
        if (snapshot.Availability != GoalAvailability.Available) Add(GoalUi.Text(snapshot.UnavailableMessage, 16, muted));
        else
        {
            if (!chat || snapshot.Goal is null) Add(GoalUi.Text(snapshot.StatusTitle, 15, BellTheme.Violet, FontWeight.SemiBold));
            if (snapshot.Goal is { } goal)
            {
                if (chat)
                {
                    var objective = GoalUi.Selectable(goal.Objective, 16); AutomationProperties.SetAutomationId(objective, "chat-goal-objective");
                    Add(new ScrollViewer { Content = objective, MinHeight = 22, MaxHeight = 180, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled });
                }
                else
                {
                    Add(GoalUi.Selectable(goal.Objective, 16));
                    Add(GoalUi.Text(goal.UsageText, 13, muted));
                }
            }
            if (snapshot.HistoryText is { } history) Add(GoalUi.Text(history, 13, muted));
            if (snapshot.ObservedText is { } observed) Add(GoalUi.Text(observed, 13, muted));
            var actions = new WrapPanel();
            void Button(string label, Action click, bool destructive = false) => actions.Children.Add(GoalUi.ActionButton(label, click, destructive, !busy));
            if (snapshot.CanCreate) Button("設定", () => onEdit("create"));
            if (snapshot.CanEdit) Button("編集", () => onEdit("edit"));
            if (snapshot.CanPause) Button("一時停止", () => onAction("pause"));
            if (snapshot.CanResume) Button("再開", () => onAction("resume"));
            if (snapshot.CanClear) Button("取り消す", () => onAction("clear"), destructive: true);
            Add(actions);
            if (snapshot.Goal is null && !snapshot.HasAction) Add(GoalUi.Text("このメンバーでは今、ゴールの設定を利用できません。", 13, muted));
            if (snapshot.UnavailableActions is { Length: > 0 } unavailable) Add(GoalUi.Text($"今のゴールでは{string.Join("・", unavailable)}を操作できません。", 13, muted));
            if (!chat && snapshot.Goal is not null) Add(GoalUi.Text(snapshot.PageFootnote, 13, muted));
        }
        var card = new Border { Child = stack, Padding = new Thickness(18), CornerRadius = new CornerRadius(24), Background = new SolidColorBrush(Color.FromArgb(0xE8, 255, 255, 255)), BorderBrush = BellTheme.Line, BorderThickness = new Thickness(1) };
        if (chat) card.BoxShadow = BoxShadows.Parse("0 7 14 0 #26000000");
        AutomationProperties.SetName(card, name + "のゴール");
        return card;
    }
}

// The scrolling page of the main window (Windows EditorWindow.AsPage): a body of up to 850, and a lifetime that ends with the connection or when the page leaves the screen.
public abstract class ListPage : Border, IDisposable
{
    private readonly CancellationTokenSource lifetime;
    protected readonly StackPanel Body = new() { Margin = new Thickness(22, 24, 22, 30), MaxWidth = 850, HorizontalAlignment = HorizontalAlignment.Stretch };
    // The scrolling body, and whatever a page lays over it (an alert).
    protected readonly Grid Layers = new();
    protected ListPage(LinuxWorkspace workspace)
    {
        lifetime = CancellationTokenSource.CreateLinkedTokenSource(workspace.ConnectionToken);
        Background = BellTheme.ConversationBackground;
        Layers.Children.Add(new ScrollViewer { Content = Body, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled });
        Child = Layers;
    }
    protected CancellationToken Token => lifetime.Token;
    public abstract Task InitializeAsync();
    protected virtual void Release() { }
    public void Dispose() { if (!lifetime.IsCancellationRequested) { lifetime.Cancel(); Release(); } }
    protected override void OnDetachedFromVisualTree(VisualTreeAttachmentEventArgs e) { Dispose(); base.OnDetachedFromVisualTree(e); }
}

// Mac GoalsView as a main-window page: read when opened, on refresh, when the window becomes active and when the server reports an event.
public sealed class GoalsPage : ListPage
{
    private readonly LinuxWorkspace workspace;
    private readonly ISheetHost host;
    private readonly GoalModel goals;
    private IReadOnlyList<GoalSnapshot>? shownSnapshots;
    private (bool, bool, bool, bool, string?) shownFlags;
    public GoalModel Model => goals;
    public GoalsPage(LinuxWorkspace workspace, ISheetHost host) : base(workspace)
    {
        this.workspace = workspace; this.host = host; goals = new GoalModel(workspace.Goals);
        goals.Changed += OnChanged; workspace.GoalEvent += Reload;
        Render();
    }
    protected override void Release() { goals.Changed -= OnChanged; workspace.GoalEvent -= Reload; }
    private void OnChanged() => GoalUi.OnUi(Render);
    public override Task InitializeAsync() => goals.LoadListAsync(Token);
    public void Reload() { if (!Token.IsCancellationRequested) GoalUi.OnUi(() => _ = goals.LoadListAsync(Token)); }

    private string NameOf(string botId) => workspace.Bots.FirstOrDefault(bot => bot.Id == botId)?.DisplayName ?? botId;
    private void Edit(GoalSnapshot snapshot, string action)
    {
        var harness = workspace.Bots.FirstOrDefault(bot => bot.Id == snapshot.BotId)?.Harness ?? "";
        host.OpenSheet(NameOf(snapshot.BotId) + "のゴール", new GoalEditorView(new GoalEditorModel(snapshot, action, harness), goals, host.CloseSheet));
    }
    private void Render()
    {
        // The server pushes an event for almost everything; rebuilding only on a real change keeps a text selection alive.
        var flags = (goals.Loading, goals.Loaded, goals.NeedsRefresh, goals.Mutating, goals.ErrorText);
        if (shownSnapshots is not null && flags == shownFlags && shownSnapshots.SequenceEqual(goals.Snapshots)) return;
        shownSnapshots = goals.Snapshots; shownFlags = flags;
        Body.Children.Clear();
        var header = new DockPanel { Margin = new Thickness(0, 0, 0, 18) };
        var tools = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Top, Margin = new Thickness(0, 2, 0, 0) };
        var refresh = GoalUi.Round(RequestIcons.Refresh, "ゴールを更新", filled: true); refresh.IsEnabled = !goals.Loading && !goals.Mutating; refresh.Click += (_, _) => _ = goals.LoadListAsync(Token);
        tools.Children.Add(refresh);
        var candidates = goals.CurrentSnapshots.Where(snapshot => snapshot.Availability == GoalAvailability.Available && snapshot.Goal is null && snapshot.Capabilities.Create && snapshot.FieldCapabilities.Create.Objective).ToArray();
        if (candidates.Length != 0)
        {
            var add = GoalUi.Round(RequestIcons.Plus, "ゴールを設定", filled: false, chevron: candidates.Length > 1); add.IsEnabled = !goals.Busy;
            add.Click += (_, _) =>
            {
                if (candidates.Length == 1) { Edit(candidates[0], "create"); return; }
                var menu = new MenuFlyout { Placement = PlacementMode.Bottom };
                foreach (var candidate in candidates) { var item = new MenuItem { Header = NameOf(candidate.BotId) }; item.Click += (_, _) => Edit(candidate, "create"); menu.Items.Add(item); }
                menu.ShowAt(add);
            };
            tools.Children.Add(add);
        }
        DockPanel.SetDock(tools, Dock.Right); header.Children.Add(tools);
        var title = new StackPanel(); title.Children.Add(new TextBlock { Text = "ゴール", FontSize = 34, FontWeight = FontWeight.Bold }); title.Children.Add(GoalUi.Text("設定済みのゴールと、現在取得できた状態。", 14, BellTheme.Muted, margin: new Thickness(0, 14, 0, 0)));
        header.Children.Add(title); Body.Children.Add(header);
        if (goals.ErrorText is { } error) Body.Children.Add(GoalUi.Text(error, 13, BellTheme.Red, margin: new Thickness(0, 0, 0, 18)));
        if (goals.Loading && !goals.Loaded) Body.Children.Add(new Spinner(BellTheme.Muted, 20) { Margin = new Thickness(0, 75, 0, 0), HorizontalAlignment = HorizontalAlignment.Center });
        else if (!goals.Loaded) Body.Children.Add(GoalUi.Unavailable(Icons.Warning, "ゴールを読み込めませんでした", "更新して確認してください。"));
        else if (goals.NeedsRefresh) Body.Children.Add(GoalUi.Unavailable(Icons.Warning, "現在のゴールを確認できません", "状態を更新して確認してください。"));
        else
        {
            var configured = goals.CurrentSnapshots.Where(snapshot => snapshot.Availability == GoalAvailability.Available && snapshot.Goal is not null).ToArray();
            if (configured.Length == 0) Body.Children.Add(GoalUi.Unavailable(Icons.Target, "設定済みのゴールはありません", null));
            foreach (var snapshot in configured)
            {
                var card = GoalCard.Build(snapshot, NameOf(snapshot.BotId), goals.Busy, chat: false, action => Edit(snapshot, action), action => _ = goals.RunAsync(snapshot, action));
                card.Margin = new Thickness(0, 0, 0, 18); Body.Children.Add(card);
            }
        }
    }
}

// Mac ChatGoalBar: a capsule above the composer of a member conversation; a click opens the card with 状態を更新.
public sealed class GoalPill : StackPanel
{
    private LinuxWorkspace? workspace;
    private ISheetHost? host;
    private GoalModel? goals;
    private CancellationTokenSource? lifetime;
    private string? botId, harness;
    private bool expanded;
    private (bool, bool, bool, bool, string?, GoalSnapshot?)? shown;
    public string? BotId => botId;
    public GoalModel? Model => goals;
    public Task LoadTask { get; private set; } = Task.CompletedTask;
    public GoalPill() { HorizontalAlignment = HorizontalAlignment.Stretch; IsVisible = false; Margin = new Thickness(0, 0, 0, 8); }

    // A member conversation shows the pill; a room (null) hides it and drops the read.
    public void Attach(LinuxWorkspace owner, string? member, ISheetHost sheetHost)
    {
        if (member == botId && ReferenceEquals(owner, workspace) && (member is null || goals is not null)) return;
        Detach();
        if (member is null) return;
        workspace = owner; host = sheetHost; botId = member; expanded = false;
        harness = owner.Bots.FirstOrDefault(bot => bot.Id == member)?.Harness ?? "";
        lifetime = CancellationTokenSource.CreateLinkedTokenSource(owner.ConnectionToken);
        goals = new GoalModel(owner.Goals); goals.Changed += OnChanged; owner.GoalEvent += Reload;
        IsVisible = true; Render(); LoadTask = LoadAsync();
    }
    public void Detach()
    {
        if (goals is not null) goals.Changed -= OnChanged;
        if (workspace is not null) workspace.GoalEvent -= Reload;
        lifetime?.Cancel(); lifetime?.Dispose(); lifetime = null; goals = null; workspace = null; botId = null; shown = null;
        Children.Clear(); IsVisible = false;
    }
    private void OnChanged() => GoalUi.OnUi(Render);
    public Task LoadAsync() => goals is null || botId is null || lifetime is null ? Task.CompletedTask : goals.LoadDetailAsync(botId, lifetime.Token);
    public void Reload() => GoalUi.OnUi(() => LoadTask = LoadAsync());
    public void SetExpanded(bool value) { expanded = value; shown = null; Render(); }

    public static string Title(GoalModel goals, string botId)
    {
        if (goals.NeedsRefresh) return "ゴールを取得できません";
        if (!goals.Loaded) return goals.ErrorText is null ? "ゴールを確認中" : "ゴールを取得できません";
        return goals.CurrentSnapshot(botId) is not { } snapshot ? "ゴールを取得できません" : snapshot.Availability switch
        {
            GoalAvailability.Unsupported => "ゴール未対応", GoalAvailability.Unavailable => snapshot.IsIdle ? "休止中" : "ゴールを取得できません", _ => snapshot.StatusTitle
        };
    }

    private void Render()
    {
        if (goals is null || botId is null) return;
        var snapshot = goals.CurrentSnapshot(botId);
        var key = (goals.Loading, goals.Loaded, goals.NeedsRefresh, goals.Mutating, goals.ErrorText, snapshot);
        if (shown is { } last && last.Equals(key)) return;
        shown = key; Children.Clear();
        var name = workspace?.Bots.FirstOrDefault(bot => bot.Id == botId)?.DisplayName ?? botId;
        if (expanded)
        {
            var details = new StackPanel { MaxWidth = 520, Margin = new Thickness(16, 0, 16, 8) };
            if (goals.ErrorText is { } error) details.Children.Add(GoalUi.Text(error, 13, BellTheme.Red, margin: new Thickness(0, 0, 0, 8)));
            if (snapshot is not null)
                details.Children.Add(GoalCard.Build(snapshot, name, goals.Busy, chat: true, action => Edit(snapshot, action), action => _ = goals.RunAsync(snapshot, action)));
            else
            {
                var note = new Border { Padding = new Thickness(18), CornerRadius = new CornerRadius(24), Background = new SolidColorBrush(Color.FromArgb(0xE8, 255, 255, 255)), BorderBrush = BellTheme.Line, BorderThickness = new Thickness(1) };
                note.Child = GoalUi.Text(goals.NeedsRefresh ? "現在のゴールを確認できません。状態を更新してください。" : "ゴールの状態を取得できません。", 13);
                details.Children.Add(note);
            }
            var update = FormKit.LinkButton("状態を更新", Reload, enabled: !goals.Loading && !goals.Mutating); update.HorizontalAlignment = HorizontalAlignment.Center; update.Margin = new Thickness(0, 6, 0, 0);
            details.Children.Add(update); Children.Add(details);
        }
        var label = new StackPanel { Orientation = Orientation.Horizontal };
        var icon = Icons.Draw(Icons.Target, 14, BellTheme.Ink, thickness: 2); icon.Margin = new Thickness(0, 0, 7, 0); label.Children.Add(icon);
        label.Children.Add(new TextBlock { Text = Title(goals, botId), FontSize = 13, FontWeight = FontWeight.SemiBold, Foreground = BellTheme.Ink, TextTrimming = TextTrimming.CharacterEllipsis });
        if (snapshot is { Availability: GoalAvailability.Available, Goal: not null } && snapshot.PillElapsed is { } elapsed)
            label.Children.Add(new TextBlock { Text = elapsed, FontSize = 13, FontWeight = FontWeight.SemiBold, Foreground = BellTheme.Ink, Margin = new Thickness(7, 0, 0, 0), TextTrimming = TextTrimming.CharacterEllipsis });
        var capsule = new Border { Child = label, CornerRadius = new CornerRadius(99), Padding = new Thickness(15, 8), Background = new SolidColorBrush(Color.FromArgb(0xE0, 0xF6, 0xF6, 0xF9)), BorderBrush = BellTheme.Line, BorderThickness = new Thickness(1) };
        var pill = new Button { Classes = { "plain" }, Content = capsule, HorizontalAlignment = HorizontalAlignment.Center, Padding = default, Margin = default, BorderThickness = default, Background = Brushes.Transparent, CornerRadius = new CornerRadius(99) };
        AutomationProperties.SetAutomationId(pill, "chat-goal-pill"); AutomationProperties.SetName(pill, Title(goals, botId));
        pill.Click += (_, _) => { expanded = !expanded; shown = null; Render(); };
        Children.Add(pill);
    }
    private GoalEditorView? Edit(GoalSnapshot snapshot, string action)
    {
        if (host is null || goals is null || botId is null) return null;
        var name = workspace?.Bots.FirstOrDefault(bot => bot.Id == botId)?.DisplayName ?? botId;
        var view = new GoalEditorView(new GoalEditorModel(snapshot, action, harness ?? ""), goals, host.CloseSheet);
        host.OpenSheet(name + "のゴール", view); return view;
    }
    // Render seam: the editor sheet for the snapshot already read.
    public GoalEditorView? OpenEditorForRender(string action) => botId is not null && goals?.CurrentSnapshot(botId) is { } snapshot ? Edit(snapshot, action) : null;
}

// Mac GoalEditor: the sheet content. 保存 lives in the sheet header (ISheetSave).
public sealed class GoalEditorView : ScrollViewer, ISheetSave
{
    private readonly GoalEditorModel editor;
    private readonly GoalModel goals;
    private readonly Action close;
    private readonly TextBox objective = Boxed(new TextBox()), budget = Boxed(new TextBox());
    private readonly TextBlock count = new(), codexNote, staleNote, errorText;
    private readonly StackPanel choice = new(), objectiveSection = new(), budgetSection = new();
    private readonly Border objectiveSegment = new(), budgetSegment = new();
    private bool saving;
    public bool CanSave { get; private set; }
    public event Action? CanSaveChanged;
    public GoalEditorModel Editor => editor;
    // Render seam: what a person would have typed.
    public void SetForRender(string? objectiveText, string? budgetText) { if (objectiveText is not null) objective.Text = objectiveText; if (budgetText is not null) budget.Text = budgetText; }
    public string ErrorText => errorText.Text ?? "";

    private static TextBox Boxed(TextBox box) { box.Background = Brushes.White; box.BorderBrush = BellTheme.Line; box.BorderThickness = new Thickness(1); box.CornerRadius = new CornerRadius(10); box.Padding = new Thickness(12, 10); box.FontSize = 16; return box; }

    public GoalEditorView(GoalEditorModel editor, GoalModel goals, Action close)
    {
        this.editor = editor; this.goals = goals; this.close = close;
        var muted = BellTheme.Muted;
        VerticalScrollBarVisibility = ScrollBarVisibility.Auto; HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled; Background = BellTheme.ConversationBackground;
        var form = new StackPanel { Margin = new Thickness(20, 8, 20, 24), MaxWidth = 720 };
        // 変更する項目: a segmented control, shown only when the CLI takes one field at a time.
        choice.Children.Add(Header("変更する項目"));
        var segments = new UniformGrid { Rows = 1, Margin = new Thickness(0, 0, 0, 8) };
        var segmentFrame = new Border { Child = segments, Background = new SolidColorBrush(Color.FromRgb(0xE3, 0xE3, 0xE8)), CornerRadius = new CornerRadius(9), Padding = new Thickness(2) };
        segments.Children.Add(Segment("目的", GoalEditField.Objective, objectiveSegment)); segments.Children.Add(Segment("トークン予算", GoalEditField.Budget, budgetSegment));
        choice.Children.Add(segmentFrame);
        choice.Children.Add(GoalUi.Text("目的と予算は、一項目ずつ保存してください。", 13, muted, margin: new Thickness(4, 0, 0, 0)));
        form.Children.Add(choice);
        objectiveSection.Children.Add(Header("目的"));
        objective.Text = editor.Objective; objective.AcceptsReturn = true; objective.TextWrapping = TextWrapping.Wrap; objective.MinHeight = 120; objective.VerticalContentAlignment = VerticalAlignment.Top;
        ScrollViewer.SetVerticalScrollBarVisibility(objective, ScrollBarVisibility.Auto);
        AutomationProperties.SetAutomationId(objective, "goal-objective-input"); AutomationProperties.SetName(objective, "目的");
        objective.OnText(() => { editor.Objective = objective.Text ?? ""; Update(); });
        objectiveSection.Children.Add(objective);
        count.FontSize = 13; count.Foreground = muted; count.Margin = new Thickness(4, 6, 0, 0); objectiveSection.Children.Add(count);
        form.Children.Add(objectiveSection);
        budgetSection.Children.Add(Header("トークン予算（任意）"));
        budget.Text = editor.Budget; budget.PlaceholderText = "指定しない"; budget.PlaceholderForeground = muted;
        AutomationProperties.SetAutomationId(budget, "goal-budget-input"); AutomationProperties.SetName(budget, "トークン予算（任意）");
        budget.OnText(() => { editor.Budget = budget.Text ?? ""; editor.BudgetChanged = true; Update(); });
        budgetSection.Children.Add(budget);
        if (editor.Action == "edit") budgetSection.Children.Add(GoalUi.Text("予算を空にした場合、現在の指定は変更しません。", 13, muted, margin: new Thickness(4, 6, 0, 0)));
        form.Children.Add(budgetSection);
        codexNote = GoalUi.Text("目的を変えると使用量が初期化されます。", 13, muted, margin: new Thickness(4, 14, 0, 0));
        staleNote = GoalUi.Text("会話が変わりました。この編集を閉じて、現在のゴールから編集し直してください。", 13, BellTheme.Red, margin: new Thickness(4, 14, 0, 0));
        errorText = GoalUi.Text("", 16, BellTheme.Red, margin: new Thickness(4, 14, 0, 0));
        form.Children.Add(codexNote); form.Children.Add(staleNote); form.Children.Add(errorText);
        Content = form;
        Update();
    }
    protected override Type StyleKeyOverride => typeof(ScrollViewer);
    protected override void OnAttachedToVisualTree(VisualTreeAttachmentEventArgs e) { base.OnAttachedToVisualTree(e); goals.Changed += OnChanged; Update(); }
    protected override void OnDetachedFromVisualTree(VisualTreeAttachmentEventArgs e) { goals.Changed -= OnChanged; base.OnDetachedFromVisualTree(e); }
    private void OnChanged() => GoalUi.OnUi(Update);
    private static TextBlock Header(string text) => GoalUi.Text(text, 13, BellTheme.Muted, FontWeight.SemiBold, new Thickness(4, 16, 0, 6));
    private Border Segment(string label, GoalEditField field, Border frame)
    {
        frame.Child = new TextBlock { Text = label, FontSize = 14, FontWeight = FontWeight.Medium, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
        frame.CornerRadius = new CornerRadius(7); frame.Padding = new Thickness(10, 6); frame.Cursor = new Cursor(StandardCursorType.Hand);
        frame.PointerReleased += (_, _) => { editor.Field = field; errorText.Text = ""; Update(); };
        AutomationProperties.SetName(frame, label); AutomationProperties.SetAutomationId(frame, "goal-edit-field");
        return frame;
    }

    // The live snapshot decides which fields exist and whether 保存 is on; the editor keeps what was typed.
    private void Update()
    {
        var current = goals.Snapshots.FirstOrDefault(item => item.BotId == editor.BotId);
        choice.IsVisible = editor.SeparateChoice(current);
        objectiveSegment.Background = editor.Field == GoalEditField.Objective ? Brushes.White : Brushes.Transparent; budgetSegment.Background = editor.Field == GoalEditField.Budget ? Brushes.White : Brushes.Transparent;
        objectiveSection.IsVisible = editor.EditsObjective(current);
        budgetSection.IsVisible = editor.EditsBudget(current);
        count.Text = editor.CountText;
        codexNote.IsVisible = editor.CodexResetNote(current);
        staleNote.IsVisible = editor.BindingChanged(current);
        errorText.IsVisible = (errorText.Text ?? "").Length != 0;
        var can = editor.CanSave(current, saving, goals.Loading);
        if (can != CanSave) { CanSave = can; CanSaveChanged?.Invoke(); }
    }

    public async Task SaveAsync()
    {
        var current = goals.Snapshots.FirstOrDefault(item => item.BotId == editor.BotId);
        if (!editor.CanSave(current, saving, goals.Loading)) return;
        var (objectiveText, tokenBudget, error) = editor.Prepare(current);
        if (error is not null) { errorText.Text = error; Update(); return; }
        saving = true; Update();
        try { await goals.ChangeAsync(editor.Selection, editor.Action, objectiveText, tokenBudget); close(); return; }
        catch (BellApiException login) when (login.RequiresLogin) { }
        catch (Exception failure) { errorText.Text = failure.Message; }
        finally { saving = false; Update(); }
    }
}
