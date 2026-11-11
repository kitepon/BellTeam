using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Effects;
using BellTeam.Core;

namespace BellTeam.App;

// A sheet whose header carries a 保存 button (Mac goal editor toolbar).
public interface ISheetSave
{
    bool CanSave { get; }
    event Action? CanSaveChanged;
    Task SaveAsync();
    // The header's two buttons: the left one closes (the editors say キャンセル until something is saved), the right one saves.
    string CloseLabel => "閉じる";
    string SaveLabel => "保存";
    bool CanClose => true;
    // Escape closes an open alert before it closes the sheet; true when something was closed.
    bool DismissPopup() => false;
}

// SF Symbol "target": two rings and a dot, drawn so it follows Foreground at any size.
public sealed class TargetIcon : FrameworkElement
{
    public static readonly DependencyProperty StrokeProperty = DependencyProperty.Register(nameof(Stroke), typeof(Brush), typeof(TargetIcon), new FrameworkPropertyMetadata(Brushes.Gray, FrameworkPropertyMetadataOptions.AffectsRender));
    public Brush Stroke { get => (Brush)GetValue(StrokeProperty); set => SetValue(StrokeProperty, value); }
    public TargetIcon() : this(16) { }
    public TargetIcon(double size) { Width = Height = size; IsHitTestVisible = false; VerticalAlignment = VerticalAlignment.Center; }
    protected override void OnRender(DrawingContext context)
    {
        var size = Math.Min(ActualWidth, ActualHeight); var thickness = size / 11; var center = new Point(ActualWidth / 2, ActualHeight / 2);
        var pen = new Pen(Stroke, thickness);
        context.DrawEllipse(null, pen, center, size / 2 - thickness / 2, size / 2 - thickness / 2);
        context.DrawEllipse(null, pen, center, size * .31, size * .31);
        context.DrawEllipse(Stroke, null, center, size * .12, size * .12);
    }
}

internal static class GoalUi
{
    public static Brush Brush(string key) => (Brush)Application.Current.FindResource(key);
    public static readonly Brush Red = Frozen(0xFF, 0x3B, 0x30);
    private static Brush Frozen(byte r, byte g, byte b) { var brush = new SolidColorBrush(Color.FromRgb(r, g, b)); brush.Freeze(); return brush; }

    public static TextBlock Text(string text, double size, Brush? foreground = null, FontWeight? weight = null, Thickness? margin = null) => new()
    {
        Text = text, FontSize = size, Foreground = foreground ?? Brush("Ink"), FontWeight = weight ?? FontWeights.Normal, TextWrapping = TextWrapping.Wrap, Margin = margin ?? default
    };

    // Mac ContentUnavailableView: a large symbol, a title and an optional description, centred.
    public static StackPanel Unavailable(string title, string? description, bool target)
    {
        var panel = new StackPanel { HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 42, 0, 20) };
        if (target) panel.Children.Add(new TargetIcon(40) { Stroke = Brush("Muted"), HorizontalAlignment = HorizontalAlignment.Center });
        else panel.Children.Add(new TextBlock { Text = "", FontFamily = new FontFamily("Segoe Fluent Icons, Segoe MDL2 Assets"), FontSize = 36, Foreground = Brush("Muted"), HorizontalAlignment = HorizontalAlignment.Center });
        panel.Children.Add(Text(title, 17, Brush("Muted"), FontWeights.SemiBold, new Thickness(0, 14, 0, 0)));
        ((TextBlock)panel.Children[1]).TextAlignment = TextAlignment.Center;
        if (description is not null) { var line = Text(description, 14, Brush("Muted"), margin: new Thickness(0, 6, 0, 0)); line.TextAlignment = TextAlignment.Center; panel.Children.Add(line); }
        return panel;
    }

    public static Button Round(string glyph, string name, bool filled, string? chevron = null)
    {
        var content = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
        var icons = new FontFamily("Segoe Fluent Icons, Segoe MDL2 Assets"); var ink = filled ? Brushes.White : Brush("Ink");
        content.Children.Add(new TextBlock { Text = glyph, FontFamily = icons, FontSize = 16, Foreground = ink, VerticalAlignment = VerticalAlignment.Center });
        if (chevron is not null) content.Children.Add(new TextBlock { Text = chevron, FontFamily = icons, FontSize = 9, Foreground = ink, Margin = new Thickness(5, 0, 0, 0), VerticalAlignment = VerticalAlignment.Center });
        var button = new Button { Height = 38, MinWidth = 38, Padding = new Thickness(chevron is null ? 0 : 12, 0, chevron is null ? 0 : 12, 0), Margin = new Thickness(4, 0, 0, 0), Content = content, ToolTip = name };
        var chrome = new FrameworkElementFactory(typeof(Border)); chrome.Name = "Chrome"; chrome.SetValue(Border.CornerRadiusProperty, new CornerRadius(19));
        chrome.SetValue(Border.BackgroundProperty, filled ? Brush("Violet") : Brushes.White); chrome.SetValue(Border.BorderBrushProperty, Brush("Line")); chrome.SetValue(Border.BorderThicknessProperty, new Thickness(filled ? 0 : 1));
        var presenter = new FrameworkElementFactory(typeof(ContentPresenter)); presenter.SetValue(FrameworkElement.HorizontalAlignmentProperty, HorizontalAlignment.Center); presenter.SetValue(FrameworkElement.VerticalAlignmentProperty, VerticalAlignment.Center); chrome.AppendChild(presenter);
        var template = new ControlTemplate(typeof(Button)) { VisualTree = chrome };
        template.Triggers.Add(new Trigger { Property = UIElement.IsEnabledProperty, Value = false, Setters = { new Setter(UIElement.OpacityProperty, .4, "Chrome") } });
        template.Triggers.Add(new Trigger { Property = UIElement.IsMouseOverProperty, Value = true, Setters = { new Setter(UIElement.OpacityProperty, .8, "Chrome") } });
        button.Template = template; System.Windows.Automation.AutomationProperties.SetName(button, name);
        return button;
    }

    public static Button ActionButton(string label, Action click, bool destructive, bool enabled)
    {
        var button = new Button { Content = label, IsEnabled = enabled, Margin = new Thickness(0, 0, 10, 0) };
        if (destructive) button.Foreground = Red;
        button.Click += (_, _) => click(); return button;
    }
}

// One goal as the Mac GoalCard draws it: the page shows name, status, objective and usage; the chat presentation shows the objective and the notes.
internal static class GoalCard
{
    public static Border Build(GoalSnapshot snapshot, string name, bool busy, bool chat, Action<string> onEdit, Action<string> onAction)
    {
        var stack = new StackPanel();
        void Add(UIElement element) { if (element is FrameworkElement item && stack.Children.Count != 0) item.Margin = new Thickness(item.Margin.Left, item.Margin.Top + 12, item.Margin.Right, item.Margin.Bottom); stack.Children.Add(element); }
        var muted = GoalUi.Brush("Muted");
        if (!chat) Add(GoalUi.Text(name, 20, weight: FontWeights.Bold));
        if (snapshot.Availability != GoalAvailability.Available) Add(GoalUi.Text(snapshot.UnavailableMessage, 16, muted));
        else
        {
            if (!chat || snapshot.Goal is null) Add(GoalUi.Text(snapshot.StatusTitle, 15, GoalUi.Brush("Violet"), FontWeights.SemiBold));
            if (snapshot.Goal is { } goal)
            {
                if (chat)
                {
                    var objective = new TextBox { Text = goal.Objective, Style = (Style)Application.Current.FindResource("SelectableBody"), FontSize = 16 };
                    System.Windows.Automation.AutomationProperties.SetAutomationId(objective, "chat-goal-objective");
                    Add(new ScrollViewer { Content = objective, MinHeight = 22, MaxHeight = 180, VerticalScrollBarVisibility = ScrollBarVisibility.Auto });
                }
                else
                {
                    Add(new TextBox { Text = goal.Objective, Style = (Style)Application.Current.FindResource("SelectableBody"), FontSize = 16 });
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
        var card = new Border { Child = stack, Padding = new Thickness(18), CornerRadius = new CornerRadius(24), Background = new SolidColorBrush(Color.FromArgb(0xE8, 255, 255, 255)), BorderBrush = GoalUi.Brush("Line"), BorderThickness = new Thickness(1) };
        if (chat) card.Effect = new DropShadowEffect { Color = Colors.Black, Opacity = .15, BlurRadius = 14, ShadowDepth = 7, Direction = 270 };
        System.Windows.Automation.AutomationProperties.SetName(card, name + "のゴール");
        return card;
    }
}

// Mac GoalsView as a main-window page: read when opened, on refresh, when the window becomes active and when the server reports an event.
public sealed class GoalsWindow : EditorWindow
{
    private readonly Workspace workspace;
    private readonly IInspectorHost host;
    private readonly GoalModel goals;
    private IReadOnlyList<GoalSnapshot>? shownSnapshots;
    private (bool, bool, bool, bool, string?) shownFlags;
    public GoalModel Model => goals;
    public GoalsWindow(Workspace workspace, IInspectorHost host) : base("ゴール", workspace.ConnectionToken)
    {
        this.workspace = workspace; this.host = host; goals = new GoalModel(workspace.Goals);
        SaveButton.Visibility = Visibility.Collapsed; CloseButton.Content = "閉じる";
        Body.Margin = new Thickness(22, 24, 22, 30);
        goals.Changed += Render; workspace.GoalEvent += Reload;
        Closed += (_, _) => { goals.Changed -= Render; workspace.GoalEvent -= Reload; };
        Render();
    }
    public override bool CanNavigateAway => true;
    public Task InitializeAsync() => goals.LoadListAsync(Token);
    public void Reload() { if (!Token.IsCancellationRequested) _ = goals.LoadListAsync(Token); }

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
        var refresh = GoalUi.Round("", "ゴールを更新", filled: true); refresh.IsEnabled = !goals.Loading && !goals.Mutating; refresh.Click += (_, _) => _ = goals.LoadListAsync(Token);
        tools.Children.Add(refresh);
        var candidates = goals.CurrentSnapshots.Where(snapshot => snapshot.Availability == GoalAvailability.Available && snapshot.Goal is null && snapshot.Capabilities.Create && snapshot.FieldCapabilities.Create.Objective).ToArray();
        if (candidates.Length != 0)
        {
            var add = GoalUi.Round("", "ゴールを設定", filled: false, chevron: candidates.Length > 1 ? "" : null); add.IsEnabled = !goals.Busy;
            add.Click += (_, _) =>
            {
                if (candidates.Length == 1) { Edit(candidates[0], "create"); return; }
                var menu = new ContextMenu { PlacementTarget = add, Placement = System.Windows.Controls.Primitives.PlacementMode.Bottom };
                foreach (var candidate in candidates) { var item = new MenuItem { Header = NameOf(candidate.BotId) }; item.Click += (_, _) => Edit(candidate, "create"); menu.Items.Add(item); }
                menu.IsOpen = true;
            };
            tools.Children.Add(add);
        }
        DockPanel.SetDock(tools, Dock.Right); header.Children.Add(tools);
        var title = new StackPanel(); title.Children.Add(new TextBlock { Text = "ゴール", FontSize = 34, FontWeight = FontWeights.Bold }); title.Children.Add(GoalUi.Text("設定済みのゴールと、現在取得できた状態。", 14, GoalUi.Brush("Muted"), margin: new Thickness(0, 14, 0, 0)));
        header.Children.Add(title); Body.Children.Add(header);
        if (goals.ErrorText is { } error) Body.Children.Add(GoalUi.Text(error, 13, GoalUi.Red, margin: new Thickness(0, 0, 0, 18)));
        if (goals.Loading && !goals.Loaded) Body.Children.Add(new Spinner { Width = 20, Height = 20, Stroke = GoalUi.Brush("Muted"), Margin = new Thickness(0, 75, 0, 0), HorizontalAlignment = HorizontalAlignment.Center });
        else if (!goals.Loaded) Body.Children.Add(GoalUi.Unavailable("ゴールを読み込めませんでした", "更新して確認してください。", target: false));
        else if (goals.NeedsRefresh) Body.Children.Add(GoalUi.Unavailable("現在のゴールを確認できません", "状態を更新して確認してください。", target: false));
        else
        {
            var configured = goals.CurrentSnapshots.Where(snapshot => snapshot.Availability == GoalAvailability.Available && snapshot.Goal is not null).ToArray();
            if (configured.Length == 0) Body.Children.Add(GoalUi.Unavailable("設定済みのゴールはありません", null, target: true));
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
    private Workspace? workspace;
    private IInspectorHost? host;
    private GoalModel? goals;
    private CancellationTokenSource? lifetime;
    private string? botId, harness;
    private bool expanded;
    private (bool, bool, bool, bool, string?, GoalSnapshot?)? shown;
    public string? BotId => botId;
    public GoalModel? Model => goals;
    public Task LoadTask { get; private set; } = Task.CompletedTask;
    public GoalPill() { HorizontalAlignment = HorizontalAlignment.Stretch; Visibility = Visibility.Collapsed; Margin = new Thickness(0, 0, 0, 8); }

    // A member conversation shows the pill; a room (null) hides it and drops the read.
    public void Attach(Workspace owner, string? member, IInspectorHost sheetHost)
    {
        if (member == botId && ReferenceEquals(owner, workspace) && (member is null || goals is not null)) return;
        Detach();
        if (member is null) return;
        workspace = owner; host = sheetHost; botId = member; expanded = false;
        harness = owner.Bots.FirstOrDefault(bot => bot.Id == member)?.Harness ?? "";
        lifetime = CancellationTokenSource.CreateLinkedTokenSource(owner.ConnectionToken);
        goals = new GoalModel(owner.Goals); goals.Changed += Render; owner.GoalEvent += Reload;
        Visibility = Visibility.Visible; Render(); LoadTask = LoadAsync();
    }
    public void Detach()
    {
        if (goals is not null) goals.Changed -= Render;
        if (workspace is not null) workspace.GoalEvent -= Reload;
        lifetime?.Cancel(); lifetime?.Dispose(); lifetime = null; goals = null; workspace = null; botId = null; shown = null;
        Children.Clear(); Visibility = Visibility.Collapsed;
    }
    public Task LoadAsync() => goals is null || botId is null || lifetime is null ? Task.CompletedTask : goals.LoadDetailAsync(botId, lifetime.Token);
    public void Reload() { LoadTask = LoadAsync(); }
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
            if (goals.ErrorText is { } error) details.Children.Add(GoalUi.Text(error, 13, GoalUi.Red, margin: new Thickness(0, 0, 0, 8)));
            if (snapshot is not null)
                details.Children.Add(GoalCard.Build(snapshot, name, goals.Busy, chat: true, action => Edit(snapshot, action), action => _ = goals.RunAsync(snapshot, action)));
            else
            {
                var note = new Border { Padding = new Thickness(18), CornerRadius = new CornerRadius(24), Background = new SolidColorBrush(Color.FromArgb(0xE8, 255, 255, 255)), BorderBrush = GoalUi.Brush("Line"), BorderThickness = new Thickness(1) };
                note.Child = GoalUi.Text(goals.NeedsRefresh ? "現在のゴールを確認できません。状態を更新してください。" : "ゴールの状態を取得できません。", 13);
                details.Children.Add(note);
            }
            var update = new Button { Content = "状態を更新", HorizontalAlignment = HorizontalAlignment.Center, IsEnabled = !goals.Loading && !goals.Mutating, Margin = new Thickness(0, 6, 0, 0), FontSize = 13 };
            update.SetResourceReference(StyleProperty, "QuietButton"); update.Click += (_, _) => Reload();
            details.Children.Add(update); Children.Add(details);
        }
        var label = new StackPanel { Orientation = Orientation.Horizontal };
        label.Children.Add(new TargetIcon(14) { Stroke = GoalUi.Brush("Ink"), Margin = new Thickness(0, 0, 7, 0) });
        label.Children.Add(new TextBlock { Text = Title(goals, botId), FontSize = 13, FontWeight = FontWeights.SemiBold, Foreground = GoalUi.Brush("Ink"), TextTrimming = TextTrimming.CharacterEllipsis });
        if (snapshot is { Availability: GoalAvailability.Available, Goal: not null } && snapshot.PillElapsed is { } elapsed)
            label.Children.Add(new TextBlock { Text = elapsed, FontSize = 13, FontWeight = FontWeights.SemiBold, Foreground = GoalUi.Brush("Ink"), Margin = new Thickness(7, 0, 0, 0), TextTrimming = TextTrimming.CharacterEllipsis });
        var capsule = new Border { Child = label, CornerRadius = new CornerRadius(99), Padding = new Thickness(15, 8, 15, 8), Background = new SolidColorBrush(Color.FromArgb(0xE0, 0xF6, 0xF6, 0xF9)), BorderBrush = GoalUi.Brush("Line"), BorderThickness = new Thickness(1) };
        var pill = new Button { Content = capsule, HorizontalAlignment = HorizontalAlignment.Center, Padding = new Thickness(0), Margin = new Thickness(0), BorderThickness = new Thickness(0), Background = Brushes.Transparent };
        var template = new ControlTemplate(typeof(Button)) { VisualTree = new FrameworkElementFactory(typeof(ContentPresenter)) };
        pill.Template = template; pill.Cursor = Cursors.Hand;
        System.Windows.Automation.AutomationProperties.SetAutomationId(pill, "chat-goal-pill");
        System.Windows.Automation.AutomationProperties.SetName(pill, Title(goals, botId));
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
    private readonly TextBox objective = new(), budget = new();
    private readonly TextBlock count = new(), placeholder = new(), codexNote, staleNote, errorText;
    private readonly StackPanel choice = new(), objectiveSection = new(), budgetSection = new();
    private readonly Border objectiveSegment = new(), budgetSegment = new();
    private bool saving;
    public bool CanSave { get; private set; }
    public event Action? CanSaveChanged;
    public GoalEditorModel Editor => editor;
    // Render seam: what a person would have typed.
    public void SetForRender(string? objectiveText, string? budgetText) { if (objectiveText is not null) objective.Text = objectiveText; if (budgetText is not null) budget.Text = budgetText; }
    public string ErrorText => errorText.Text;

    public GoalEditorView(GoalEditorModel editor, GoalModel goals, Action close)
    {
        this.editor = editor; this.goals = goals; this.close = close;
        var muted = GoalUi.Brush("Muted");
        VerticalScrollBarVisibility = ScrollBarVisibility.Auto;
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
        objective.Text = editor.Objective; objective.AcceptsReturn = true; objective.TextWrapping = TextWrapping.Wrap; objective.MinHeight = 120; objective.VerticalScrollBarVisibility = ScrollBarVisibility.Auto; objective.VerticalContentAlignment = VerticalAlignment.Top; objective.FontSize = 16;
        System.Windows.Automation.AutomationProperties.SetAutomationId(objective, "goal-objective-input"); System.Windows.Automation.AutomationProperties.SetName(objective, "目的");
        objective.TextChanged += (_, _) => { editor.Objective = objective.Text; Update(); };
        objectiveSection.Children.Add(objective);
        count.FontSize = 13; count.Foreground = muted; count.Margin = new Thickness(4, 6, 0, 0); objectiveSection.Children.Add(count);
        form.Children.Add(objectiveSection);
        budgetSection.Children.Add(Header("トークン予算（任意）"));
        budget.Text = editor.Budget; budget.FontSize = 16;
        System.Windows.Automation.AutomationProperties.SetAutomationId(budget, "goal-budget-input"); System.Windows.Automation.AutomationProperties.SetName(budget, "トークン予算（任意）");
        budget.TextChanged += (_, _) => { editor.Budget = budget.Text; editor.BudgetChanged = true; Update(); };
        placeholder.Text = "指定しない"; placeholder.Foreground = muted; placeholder.FontSize = 16; placeholder.IsHitTestVisible = false; placeholder.Margin = new Thickness(13, 11, 0, 0); placeholder.VerticalAlignment = VerticalAlignment.Top; placeholder.HorizontalAlignment = HorizontalAlignment.Left;
        budgetSection.Children.Add(new Grid { Children = { budget, placeholder } });
        if (editor.Action == "edit") budgetSection.Children.Add(GoalUi.Text("予算を空にした場合、現在の指定は変更しません。", 13, muted, margin: new Thickness(4, 6, 0, 0)));
        form.Children.Add(budgetSection);
        codexNote = GoalUi.Text("目的を変えると使用量が初期化されます。", 13, muted, margin: new Thickness(4, 14, 0, 0));
        staleNote = GoalUi.Text("会話が変わりました。この編集を閉じて、現在のゴールから編集し直してください。", 13, GoalUi.Red, margin: new Thickness(4, 14, 0, 0));
        errorText = GoalUi.Text("", 16, GoalUi.Red, margin: new Thickness(4, 14, 0, 0));
        form.Children.Add(codexNote); form.Children.Add(staleNote); form.Children.Add(errorText);
        Content = form;
        goals.Changed += Update; Unloaded += (_, _) => goals.Changed -= Update;
        Update();
    }
    private static TextBlock Header(string text) => GoalUi.Text(text, 13, GoalUi.Brush("Muted"), FontWeights.SemiBold, new Thickness(4, 16, 0, 6));
    private Border Segment(string label, GoalEditField field, Border frame)
    {
        frame.Child = new TextBlock { Text = label, FontSize = 14, FontWeight = FontWeights.Medium, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
        frame.CornerRadius = new CornerRadius(7); frame.Padding = new Thickness(10, 6, 10, 6); frame.Cursor = Cursors.Hand;
        frame.MouseLeftButtonUp += (_, _) => { editor.Field = field; errorText.Text = ""; Update(); };
        System.Windows.Automation.AutomationProperties.SetName(frame, label); System.Windows.Automation.AutomationProperties.SetAutomationId(frame, "goal-edit-field");
        return frame;
    }

    // The live snapshot decides which fields exist and whether 保存 is on; the editor keeps what was typed.
    private void Update()
    {
        var current = goals.Snapshots.FirstOrDefault(item => item.BotId == editor.BotId);
        choice.Visibility = editor.SeparateChoice(current) ? Visibility.Visible : Visibility.Collapsed;
        objectiveSegment.Background = editor.Field == GoalEditField.Objective ? Brushes.White : Brushes.Transparent; budgetSegment.Background = editor.Field == GoalEditField.Budget ? Brushes.White : Brushes.Transparent;
        objectiveSection.Visibility = editor.EditsObjective(current) ? Visibility.Visible : Visibility.Collapsed;
        budgetSection.Visibility = editor.EditsBudget(current) ? Visibility.Visible : Visibility.Collapsed;
        count.Text = editor.CountText; placeholder.Visibility = budget.Text.Length == 0 ? Visibility.Visible : Visibility.Collapsed;
        codexNote.Visibility = editor.CodexResetNote(current) ? Visibility.Visible : Visibility.Collapsed;
        staleNote.Visibility = editor.BindingChanged(current) ? Visibility.Visible : Visibility.Collapsed;
        errorText.Visibility = errorText.Text.Length == 0 ? Visibility.Collapsed : Visibility.Visible;
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
