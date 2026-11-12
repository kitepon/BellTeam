using System.Globalization;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Media;
using BellTeam.Core;
using static BellTeam.App.SettingsUi;

namespace BellTeam.App;

// Mac SchedulesView as a main-window page: read when opened and on every server event; the editor is the in-window sheet.
public sealed class SchedulesWindow : EditorWindow
{
    private readonly Workspace workspace;
    private readonly IInspectorHost host;
    private readonly Grid alertLayer = new() { Background = new SolidColorBrush(Color.FromArgb(0x59, 0, 0, 0)), Visibility = Visibility.Collapsed };
    private ScheduledEntry[]? entries;
    private string? errorText;
    private string shown = "";
    private Task? reading;
    private bool readAgain, keepError, acting;
    public ScheduledEntry[] Entries => entries ?? [];
    internal ScheduleEditorView? Editor { get; private set; }
    // Mac onDismiss: whatever closes the sheet reads the schedules again.
    public SchedulesWindow(Workspace workspace, IInspectorHost host) : base("予定", workspace.ConnectionToken)
    {
        this.workspace = workspace; this.host = host;
        SaveButton.Visibility = Visibility.Collapsed; CloseButton.Content = "閉じる";
        Body.Margin = new Thickness(22, 24, 22, 30);
        workspace.ServerChanged += Changed; Closed += (_, _) => workspace.ServerChanged -= Changed;
        Render();
    }
    public override bool CanNavigateAway => true;
    public override FrameworkElement AsPage(Action close, bool keepActions = false)
    {
        var page = base.AsPage(close, keepActions);
        var layered = new Grid(); layered.Children.Add(page); layered.Children.Add(alertLayer); Panel.SetZIndex(alertLayer, 5); return layered;
    }
    private void Changed() { if (!Token.IsCancellationRequested) _ = LoadAsync(); }
    public Task InitializeAsync() => LoadAsync();

    // One read at a time; a request that arrives meanwhile makes one more read after it.
    private Task LoadAsync()
    {
        if (reading is not null) { readAgain = true; return reading; }
        var task = ReadLoop(); if (!task.IsCompleted) reading = task; return task;
    }
    private async Task ReadLoop()
    {
        try { do { readAgain = false; await ReadOnce(); } while (readAgain && !Token.IsCancellationRequested); }
        finally { reading = null; }
    }
    private async Task ReadOnce()
    {
        if (entries is null) Render();
        try
        {
            var sources = await workspace.Planning.AllSchedulesAsync(workspace.Conversations.Select(owner => (owner.Target, owner.Name)), Token);
            Token.ThrowIfCancellationRequested();
            var read = new List<ScheduledEntry>();
            foreach (var source in sources)
            {
                var owner = workspace.Conversations.FirstOrDefault(candidate => candidate.Target == source.Target);
                if (owner is not null) read.AddRange(source.Schedules.Select(schedule => new ScheduledEntry(owner.Target, owner.Name, schedule)));
            }
            // Mac: only schedules with a next run or still enabled, soonest first; a schedule without a readable date goes last.
            entries = read.Where(entry => entry.Schedule.NextRunAt is not null || entry.Schedule.Enabled).Select((entry, index) => (entry, index)).OrderBy(item => NextAt(item.entry.Schedule)).ThenBy(item => item.index).Select(item => item.entry).ToArray();
            if (!keepError) errorText = null;
        }
        catch (OperationCanceledException) when (Token.IsCancellationRequested) { return; }
        catch (Exception error) { entries ??= []; errorText = error.Message; }
        keepError = false; Render();
    }
    private static DateTimeOffset NextAt(Schedule schedule) => schedule.NextRunAt is { } next && DateTimeOffset.TryParse(next, CultureInfo.InvariantCulture, DateTimeStyles.None, out var at) ? at : DateTimeOffset.MaxValue;

    // Mac run / remove: one request per press, never sent again by itself. A failure is shown and the list is read again, which is the way out when the result is unknown.
    private async Task ActAsync(Func<Task> request)
    {
        if (acting) return;
        acting = true;
        try { await request(); await LoadAsync(); }
        catch (OperationCanceledException) when (Token.IsCancellationRequested) { }
        catch (Exception error) { errorText = EditorText.Failure(error); keepError = true; await LoadAsync(); }
        finally { acting = false; }
    }

    private void Render()
    {
        var signature = string.Join("\n", (entries ?? []).Select(entry => entry.Path + "|" + entry.OwnerName + "|" + JsonSerializer.Serialize(entry.Schedule, BellApi.Json)).Prepend(entries is null ? "reading" : "read").Append(errorText ?? ""));
        if (signature == shown) return;
        shown = signature; Body.Children.Clear();
        var header = new DockPanel { Margin = new Thickness(0, 0, 0, 20) };
        var add = GoalUi.Round("", "予定を追加", filled: true); add.VerticalAlignment = VerticalAlignment.Top; add.Click += (_, _) => OpenEditor(null);
        DockPanel.SetDock(add, Dock.Right); header.Children.Add(add);
        var title = new StackPanel(); title.Children.Add(new TextBlock { Text = "予定", FontSize = 34, FontWeight = FontWeights.Bold });
        title.Children.Add(GoalUi.Text("チームに任せた仕事の、これから。", 14, GoalUi.Brush("Muted"), margin: new Thickness(0, 8, 0, 0)));
        header.Children.Add(title); Body.Children.Add(header);
        if (errorText is { } error) Body.Children.Add(GoalUi.Text(error, 13, GoalUi.Red, margin: new Thickness(0, 0, 0, 20)));
        if (entries is null) { Body.Children.Add(new Spinner { Width = 20, Height = 20, Stroke = GoalUi.Brush("Muted"), Margin = new Thickness(0, 75, 0, 0), HorizontalAlignment = HorizontalAlignment.Center }); return; }
        if (entries.Length == 0)
        {
            if (errorText is not null)
            {
                var retry = EditorFormView.LinkButton("再読み込み", () => _ = LoadAsync()); retry.HorizontalAlignment = HorizontalAlignment.Center; retry.Margin = new Thickness(0, 14, 0, 0);
                Body.Children.Add(Unavailable("", "予定を読み込めませんでした", "再読み込みしてください。", retry));
            }
            else Body.Children.Add(Unavailable("", "予定はありません", "右上の＋から追加できます。", null));
            return;
        }
        foreach (var entry in entries) { var card = BuildCard(entry); card.Margin = new Thickness(0, 0, 0, 20); Body.Children.Add(card); }
    }

    // Mac ContentUnavailableView: a large symbol, a title, a description and an optional action, centred.
    private static StackPanel Unavailable(string glyph, string title, string description, UIElement? action)
    {
        var panel = new StackPanel { HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 42, 0, 20) };
        var icon = Glyph(glyph, 36, GoalUi.Brush("Muted")); icon.HorizontalAlignment = HorizontalAlignment.Center; panel.Children.Add(icon);
        var heading = GoalUi.Text(title, 17, GoalUi.Brush("Muted"), FontWeights.SemiBold, new Thickness(0, 14, 0, 0)); heading.TextAlignment = TextAlignment.Center; panel.Children.Add(heading);
        var detail = GoalUi.Text(description, 14, GoalUi.Brush("Muted"), margin: new Thickness(0, 6, 0, 0)); detail.TextAlignment = TextAlignment.Center; panel.Children.Add(detail);
        if (action is not null) panel.Children.Add(action);
        return panel;
    }

    // Mac kind symbol: a calendar for a one-time schedule, the repeat arrows for every recurring kind.
    internal static string KindGlyph(string kind) => ScheduleText.IsOneTime(kind) ? "" : "";

    private Border BuildCard(ScheduledEntry entry)
    {
        var schedule = entry.Schedule; var violet = GoalUi.Brush("Violet");
        var owner = workspace.Conversations.FirstOrDefault(candidate => candidate.Target == entry.Target) ?? new ConversationEntry(entry.Target, entry.OwnerName, "", DateTimeOffset.MinValue, null, null);
        var stack = new StackPanel();
        var head = new Grid(); head.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto }); head.ColumnDefinitions.Add(new ColumnDefinition()); head.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        head.Children.Add(new AvatarTile { Entry = owner, Workspace = workspace, Width = 42, Height = 42, Margin = new Thickness(0, 0, 12, 0) });
        var labels = new StackPanel { VerticalAlignment = VerticalAlignment.Center }; Grid.SetColumn(labels, 1);
        labels.Children.Add(GoalUi.Text(entry.OwnerName, 13, violet, FontWeights.SemiBold));
        labels.Children.Add(Clamp(GoalUi.Text(schedule.Title, 17, GoalUi.Brush("Ink"), FontWeights.Bold, new Thickness(0, 3, 0, 0)), 2, 22));
        head.Children.Add(labels);
        var kind = Glyph(KindGlyph(schedule.Kind), 15, violet); kind.Margin = new Thickness(12, 0, 0, 0); Grid.SetColumn(kind, 2); head.Children.Add(kind);
        stack.Children.Add(head);
        if (ActionLine(schedule, GoalUi.Brush("Muted")) is { } action) stack.Children.Add(action);
        var next = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 14, 0, 0) };
        next.Children.Add(Glyph("", 12, violet)); var nextText = GoalUi.Text(ScheduleText.Next(schedule.NextRunAt), 12, violet, FontWeights.Medium, new Thickness(6, 0, 0, 0)); nextText.TextWrapping = TextWrapping.NoWrap; next.Children.Add(nextText);
        stack.Children.Add(next);
        stack.Children.Add(new Border { Height = 1, Background = Hairline, Margin = new Thickness(0, 14, 0, 14) });
        var tint = new SolidColorBrush(Color.FromArgb(0x14, 0x61, 0x47, 0xD4));
        Button Tinted(string label, Action click, string? glyph = null)
        {
            var button = Capsule(label, tint, Violet, 8, 12, new Thickness(12, 6, 12, 6));
            if (glyph is not null) button.Content = Glyph(glyph, 13, Violet);
            System.Windows.Automation.AutomationProperties.SetName(button, label); button.Click += (_, _) => click(); return button;
        }
        var buttons = new Grid(); buttons.ColumnDefinitions.Add(new ColumnDefinition()); buttons.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var run = Tinted("今すぐ実行", () => _ = ActAsync(() => workspace.Planning.RunScheduleAsync(entry, Token))); run.HorizontalAlignment = HorizontalAlignment.Left; buttons.Children.Add(run);
        var right = new StackPanel { Orientation = Orientation.Horizontal }; Grid.SetColumn(right, 1);
        right.Children.Add(Tinted("編集", () => OpenEditor(entry)));
        var trash = Tinted("削除", () => AskDelete(entry), ""); trash.Margin = new Thickness(12, 0, 0, 0); right.Children.Add(trash);
        buttons.Children.Add(right); stack.Children.Add(buttons);
        var card = Card(stack); card.Padding = new Thickness(18);
        System.Windows.Automation.AutomationProperties.SetName(card, entry.OwnerName + "の予定 " + schedule.Title);
        return card;
    }
    // A command is machine text (paths, IDs): the card names its kind and the command itself stays in the editor; a prompt keeps its text (three lines).
    internal static UIElement? ActionLine(Schedule schedule, Brush muted)
    {
        if (schedule.Command is null) return schedule.Prompt is { } prompt ? Clamp(GoalUi.Text(prompt, 14, muted, margin: new Thickness(0, 14, 0, 0)), 3, 20) : null;
        var badge = Badge("AIを起こさずに動く自動の作業", SettingsTone.Violet, ""); badge.HorizontalAlignment = HorizontalAlignment.Left; badge.Margin = new Thickness(0, 14, 0, 0); return badge;
    }
    // Mac lineLimit(n): n lines of a fixed height, the last one cut with an ellipsis.
    private static TextBlock Clamp(TextBlock text, int lines, double lineHeight)
    {
        text.LineHeight = lineHeight; text.LineStackingStrategy = LineStackingStrategy.BlockLineHeight; text.TextTrimming = TextTrimming.CharacterEllipsis;
        text.MaxHeight = lines * lineHeight + text.Margin.Top; return text;
    }

    private void AskDelete(ScheduledEntry entry)
    {
        alertLayer.Children.Clear();
        alertLayer.Children.Add(EditorFormView.AlertFrame("この予定を削除しますか？", "", () => alertLayer.Visibility = Visibility.Collapsed,
            new AlertChoice("削除", () => _ = ActAsync(() => workspace.Planning.DeleteScheduleAsync(entry, Token)), Destructive: true), new AlertChoice("キャンセル", Bold: true)));
        alertLayer.Visibility = Visibility.Visible;
    }
    private void OpenEditor(ScheduledEntry? entry)
    {
        var view = new ScheduleEditorView(workspace, entry, () => { if (!Token.IsCancellationRequested) _ = LoadAsync(); }) { Closer = host.CloseSheet };
        Editor = view; host.OpenSheet(entry is null ? "予定を追加" : "予定を編集", view);
    }
    // Render seams: the sheet and the delete confirmation without a click.
    internal ScheduleEditorView OpenEditorForRender(string? id = null) { OpenEditor(id is null ? null : Entries.First(entry => entry.Schedule.Id == id)); return Editor!; }
    internal void AskDeleteForRender() => AskDelete(Entries[0]);
}

// Mac ScheduleEditor: 担当, 実行内容 and タイミング as a grouped form in the sheet. The same schedule is written back whole (PUT); a new one is a POST. 保存 sends once and never again by itself.
public sealed class ScheduleEditorView : EditorFormView
{
    internal static readonly FormOption[] Frequencies = [new("once", "一回だけ"), new("hourly", "毎時"), new("daily", "毎日"), new("weekly", "毎週"), new("interval_days", "数日おき"), new("interval_hours", "数時間おき"), new("cron", "cron式")];
    private static readonly string[] DayNames = ["日", "月", "火", "水", "木", "金", "土"];
    private readonly Workspace workspace;
    private readonly ScheduledEntry? initial;
    private Action? dismissed;
    private readonly ScheduleDraft draft;
    private readonly ConversationEntry[] owners;
    private readonly ComboBox target, action, frequency;
    private readonly GroupCard ownerCard = new(), contentCard = new(), timingCard = new();
    private readonly List<UIElement> memberRows = [];
    private readonly HashSet<string> replyTo;
    private readonly TextBox name, prompt, command, expression;
    private readonly Border kindRow, promptRow, commandRow;
    private readonly DatePicker once, startDate;
    private readonly TimeBox onceTime, time, time2;
    private readonly ComboBox minute, minute2;
    private readonly List<ToggleButton> days = [];
    private readonly Func<int> intervalDays, intervalHours, startHour, endHour;
    private readonly List<(UIElement Row, string[] Modes)> timing = [];
    private readonly StackPanel errors = new();
    public string ErrorText { get; private set; } = "";
    public override string CloseLabel => "キャンセル";

    public ScheduleEditorView(Workspace workspace, ScheduledEntry? initial, Action? dismissed = null) : base(workspace)
    {
        this.workspace = workspace; this.initial = initial; this.dismissed = dismissed;
        draft = initial is null ? new ScheduleDraft() : ScheduleDraft.From(initial.Schedule);
        owners = workspace.Conversations.Where(entry => !entry.Target.IsRoom).Concat(workspace.Conversations.Where(entry => entry.Target.IsRoom)).ToArray();
        replyTo = [.. initial?.Schedule.Targets ?? []];

        // 担当
        target = Popup("メンバー・ルーム", owners.Select(entry => new FormOption(entry.Target.Path, entry.Name)), initial?.Target.Path ?? owners.FirstOrDefault()?.Target.Path);
        target.IsEnabled = initial is null; target.MinWidth = 180;
        ownerCard.Add(Labeled("メンバー・ルーム", target));

        // 実行内容
        var nameField = Field("予定の名前", draft.Name); name = nameField.Box;
        action = Popup("種類", [new("prompt", "AIへの指示"), new("command", "コマンド")], draft.Action);
        var promptField = Field("依頼する内容", initial?.Schedule.Prompt ?? "", multiline: true, minHeight: 54); prompt = promptField.Box; prompt.MaxHeight = 136;
        var commandField = Field("実行するコマンド", initial?.Schedule.Command ?? "", multiline: true, minHeight: 36); command = commandField.Box; command.MaxHeight = 130; command.FontFamily = new FontFamily("Consolas, Yu Gothic UI"); command.FontSize = 12;
        // Mac: folded by default (paths and IDs only matter when changing the line); an empty command stays open so there is somewhere to type.
        var commandFold = TerminalParts.Disclosure("コマンドを表示して編集", commandField.Element, string.IsNullOrEmpty(command.Text), _ => { });
        System.Windows.Automation.AutomationProperties.SetAutomationId(commandFold, "schedule-command-disclosure");
        command.TextChanged += (_, _) => { if (command.Text.Length == 0) commandFold.IsExpanded = true; };
        contentCard.Add(Row(nameField.Element)); contentCard.Add(kindRow = Labeled("種類", action)); contentCard.Add(promptRow = Row(promptField.Element)); contentCard.Add(commandRow = Row(commandFold));

        // タイミング
        frequency = Popup("繰り返し", Frequencies, draft.Frequency); timingCard.Add(Labeled("繰り返し", frequency));
        void AddTiming(UIElement row, params string[] modes) { timingCard.Add(row); timing.Add((row, modes)); }
        var (initialHour, initialMinute) = initial is null || initial.Schedule.Kind == "once" ? (draft.Date.Hour, draft.Date.Minute) : (draft.Hour, draft.Minute);
        once = new DatePicker { SelectedDate = draft.Date.Date, DisplayDateStart = draft.Date.Date < DateTime.Today ? draft.Date.Date : DateTime.Today, FontSize = 13, MinWidth = 130 };
        System.Windows.Automation.AutomationProperties.SetName(once, "実行日");
        onceTime = new TimeBox("実行時刻", draft.Date.Hour, draft.Date.Minute) { Margin = new Thickness(8, 0, 0, 0) };
        var onceControl = new StackPanel { Orientation = Orientation.Horizontal }; onceControl.Children.Add(once); onceControl.Children.Add(onceTime);
        AddTiming(Labeled("実行日時", onceControl), "once");
        minute = MinuteBox("毎時何分", draft.Minute); AddTiming(Labeled("毎時何分", minute), "hourly");
        time = new TimeBox("時刻", initialHour, initialMinute); AddTiming(Labeled("時刻", time), "daily", "weekly");
        for (var day = 0; day < 7; day++) AddTiming(SwitchRow(DayNames[day], draft.Weekdays.Contains(day), days), "weekly");
        var stepDays = Stepper(value => $"{value}日おき", draft.IntervalDays, 1, 365); intervalDays = stepDays.Value; AddTiming(stepDays.Row, "interval_days");
        startDate = new DatePicker { SelectedDate = draft.StartDate.Date, FontSize = 13, MinWidth = 130 }; System.Windows.Automation.AutomationProperties.SetName(startDate, "開始日"); AddTiming(Labeled("開始日", startDate), "interval_days");
        time2 = new TimeBox("時刻", initialHour, initialMinute); AddTiming(Labeled("時刻", time2), "interval_days");
        var stepHours = Stepper(value => $"{value}時間おき", draft.IntervalHours, 1, 24); intervalHours = stepHours.Value; AddTiming(stepHours.Row, "interval_hours");
        var stepStart = Stepper(value => $"開始 {value}時", draft.StartHour, 0, 23); startHour = stepStart.Value; AddTiming(stepStart.Row, "interval_hours");
        var stepEnd = Stepper(value => $"終了 {value}時", draft.EndHour, 0, 23); endHour = stepEnd.Value; AddTiming(stepEnd.Row, "interval_hours");
        minute2 = MinuteBox("実行する分", draft.Minute); AddTiming(Labeled("実行する分", minute2), "interval_hours");
        var expressionField = Field("cron式", draft.Expression); expression = expressionField.Box; AddTiming(Row(expressionField.Element), "cron");
        // The two 時刻 rows and the two minute lists are one value each, shown where the Mac shows them.
        time.Changed += () => time2.Set(time.Hour, time.Minute); time2.Changed += () => time.Set(time2.Hour, time2.Minute);
        minute.SelectionChanged += (_, _) => minute2.SelectedValue = minute.SelectedValue; minute2.SelectionChanged += (_, _) => minute.SelectedValue = minute2.SelectedValue;

        Form.Children.Add(FormSection("担当", ownerCard)); Form.Children.Add(FormSection("実行内容", contentCard)); Form.Children.Add(FormSection("タイミング", timingCard)); Form.Children.Add(errors);
        target.SelectionChanged += (_, _) => { replyTo.Clear(); TargetChanged(); }; action.SelectionChanged += (_, _) => ShowContent(); frequency.SelectionChanged += (_, _) => ShowTiming();
        TargetChanged(); ShowTiming(); Ready = true; Notify();
    }

    private ConversationEntry? Owner => owners.FirstOrDefault(entry => entry.Target.Path == target.SelectedValue as string);
    private bool Commands => action.SelectedValue as string == "command" && Owner?.Target.IsRoom != true;
    protected override bool SaveBlocked => Owner is null;
    public override void Dispose() { base.Dispose(); var done = dismissed; dismissed = null; done?.Invoke(); }

    // Mac: a room has no 種類 and always sends an instruction; its members can be named as repliers.
    private void TargetChanged()
    {
        foreach (var row in memberRows) ownerCard.Remove(row);
        memberRows.Clear();
        if (Owner?.Room is { } room)
        {
            var hint = Note("返信するメンバーを指定。未選択なら自動選択し、発言は全員に届きます。", Ink, 12); memberRows.Add(hint); ownerCard.Add(hint);
            foreach (var id in room.MemberIds)
            {
                var row = SwitchRow(workspace.Bots.FirstOrDefault(bot => bot.Id == id)?.DisplayName ?? id, replyTo.Contains(id), null, on => { if (on) replyTo.Add(id); else replyTo.Remove(id); });
                memberRows.Add(row); ownerCard.Add(row);
            }
        }
        ShowContent();
    }
    private void ShowContent()
    {
        var room = Owner?.Target.IsRoom == true;
        contentCard.SetVisible(kindRow, !room); contentCard.SetVisible(commandRow, Commands); contentCard.SetVisible(promptRow, !Commands);
    }
    private void ShowTiming() { foreach (var (row, modes) in timing) timingCard.SetVisible(row, modes.Contains(frequency.SelectedValue as string)); }

    private static ComboBox MinuteBox(string label, int value) { var box = Popup(label, Enumerable.Range(0, 60).Select(minute => new FormOption(minute.ToString(CultureInfo.InvariantCulture), minute + "分")), value.ToString(CultureInfo.InvariantCulture)); box.MinWidth = 90; return box; }
    private static Border SwitchRow(string label, bool on, List<ToggleButton>? collect, Action<bool>? changed = null)
    {
        var toggle = Switch("#34C759"); toggle.IsChecked = on; System.Windows.Automation.AutomationProperties.SetName(toggle, label); collect?.Add(toggle);
        if (changed is not null) { toggle.Checked += (_, _) => changed(true); toggle.Unchecked += (_, _) => changed(false); }
        var grid = new Grid { VerticalAlignment = VerticalAlignment.Center }; grid.ColumnDefinitions.Add(new ColumnDefinition()); grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var caption = Text(label, 13); caption.VerticalAlignment = VerticalAlignment.Center; grid.Children.Add(caption); Grid.SetColumn(toggle, 1); grid.Children.Add(toggle); return Row(grid);
    }
    // Mac Stepper: the value in its label, minus and plus on the right.
    private static (Border Row, Func<int> Value) Stepper(Func<int, string> label, int value, int min, int max)
    {
        var current = Math.Clamp(value, min, max); var text = Text(label(current), 13); text.VerticalAlignment = VerticalAlignment.Center;
        Button Step(string glyph, int delta, string name)
        {
            var button = Capsule(glyph, Brushes.Transparent, Ink, 8, 15, new Thickness(12, 2, 12, 2)); System.Windows.Automation.AutomationProperties.SetName(button, name);
            button.Click += (_, _) => { current = Math.Clamp(current + delta, min, max); text.Text = label(current); }; return button;
        }
        var pair = new StackPanel { Orientation = Orientation.Horizontal }; pair.Children.Add(Step("−", -1, "減らす")); pair.Children.Add(new Border { Width = 1, Height = 16, Background = Hairline }); pair.Children.Add(Step("+", 1, "増やす"));
        var grid = new Grid { VerticalAlignment = VerticalAlignment.Center }; grid.ColumnDefinitions.Add(new ColumnDefinition()); grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.Children.Add(text); var frame = new Border { Child = pair, Background = Fill, CornerRadius = new CornerRadius(8) }; Grid.SetColumn(frame, 1); grid.Children.Add(frame);
        return (Row(grid), () => current);
    }

    private void Show(string message)
    {
        ErrorText = message; errors.Children.Clear(); errors.Children.Add(FormSection(null, new GroupCard(Row(Text(message, 13, Red)))));
    }

    // Mac save(): the typed values become the whole schedule; a room always sends the instruction.
    internal Dictionary<string, object?> Collect(out ConversationEntry owner)
    {
        var picked = owner = Owner ?? throw new ArgumentException("担当を選んでください。");
        var room = picked.Target.IsRoom; var frequencyId = (string)frequency.SelectedValue;
        draft.Name = name.Text; draft.Action = Commands ? "command" : "prompt"; draft.Content = Commands ? command.Text : prompt.Text; draft.Frequency = frequencyId;
        if (frequencyId == "once")
        {
            if (once.SelectedDate is not { } date) throw new ArgumentException("実行日時を入力してください。");
            draft.Date = date.Date + new TimeSpan(onceTime.Hour, onceTime.Minute, 0);
        }
        if (frequencyId is "hourly" or "interval_hours") draft.Minute = int.Parse((string)minute.SelectedValue, CultureInfo.InvariantCulture);
        else { draft.Hour = time.Hour; draft.Minute = time.Minute; }
        draft.Weekdays = days.Select((toggle, day) => (toggle, day)).Where(item => item.toggle.IsChecked == true).Select(item => item.day).ToHashSet();
        draft.IntervalDays = intervalDays(); draft.IntervalHours = intervalHours(); draft.StartHour = startHour(); draft.EndHour = endHour();
        if (startDate.SelectedDate is { } start) draft.StartDate = start.Date;
        draft.Expression = expression.Text;
        return draft.Payload(room, room ? replyTo.Where(id => picked.Room?.MemberIds.Contains(id) == true).ToArray() : []);
    }
    public override Task SaveAsync()
    {
        if (!CanSave) return Task.CompletedTask;
        Dictionary<string, object?> body; ConversationEntry picked;
        try { body = Collect(out picked); }
        catch (ArgumentException error) { Show(error.Message); return Task.CompletedTask; }
        return RunAsync(async () =>
        {
            try { await workspace.Planning.SaveScheduleAsync(picked.Target, initial?.Schedule.Id, body, Token); }
            catch (OperationCanceledException) when (Token.IsCancellationRequested) { throw; }
            catch (Exception error) { Show(EditorText.Failure(error)); return; }
            Close();
        });
    }

    // Render and test seam: what a person would have chosen and typed.
    internal void Prefill(string? ownerPath = null, string? nameText = null, string? text = null, string? frequencyId = null, int[]? weekdays = null)
    {
        if (ownerPath is not null) target.SelectedValue = ownerPath;
        if (nameText is not null) name.Text = nameText;
        if (text is not null) (Commands ? command : prompt).Text = text;
        if (frequencyId is not null) frequency.SelectedValue = frequencyId;
        if (weekdays is not null) for (var day = 0; day < days.Count; day++) days[day].IsChecked = weekdays.Contains(day);
    }

    // The Mac hour-and-minute picker: two lists.
    internal sealed class TimeBox : StackPanel
    {
        private readonly ComboBox hour, minute;
        private bool setting;
        public event Action? Changed;
        public TimeBox(string label, int h, int m)
        {
            Orientation = Orientation.Horizontal;
            hour = Popup(label + "（時）", Enumerable.Range(0, 24).Select(value => new FormOption(value.ToString(CultureInfo.InvariantCulture), value.ToString(CultureInfo.InvariantCulture))), h.ToString(CultureInfo.InvariantCulture)); hour.MinWidth = 64;
            minute = Popup(label + "（分）", Enumerable.Range(0, 60).Select(value => new FormOption(value.ToString(CultureInfo.InvariantCulture), value.ToString("00", CultureInfo.InvariantCulture))), m.ToString(CultureInfo.InvariantCulture)); minute.MinWidth = 64;
            Children.Add(hour); Children.Add(new TextBlock { Text = ":", FontSize = 13, Margin = new Thickness(6, 0, 6, 0), VerticalAlignment = VerticalAlignment.Center }); Children.Add(minute);
            hour.SelectionChanged += (_, _) => { if (!setting) Changed?.Invoke(); }; minute.SelectionChanged += (_, _) => { if (!setting) Changed?.Invoke(); };
        }
        public int Hour => int.Parse((string)hour.SelectedValue, CultureInfo.InvariantCulture);
        public int Minute => int.Parse((string)minute.SelectedValue, CultureInfo.InvariantCulture);
        public void Set(int h, int m) { setting = true; hour.SelectedValue = h.ToString(CultureInfo.InvariantCulture); minute.SelectedValue = m.ToString(CultureInfo.InvariantCulture); setting = false; }
    }
}
