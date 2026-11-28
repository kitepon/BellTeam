using System.Globalization;
using System.Text.Json;
using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Controls.Primitives;
using Avalonia.Layout;
using Avalonia.Media;
using BellTeam.Core;
using static BellTeam.Linux.FormKit;

namespace BellTeam.Linux;

// Mac SchedulesView as a main-window page: read when opened and on every server event; the editor is the in-window sheet.
public sealed class SchedulesPage : ListPage
{
    private readonly LinuxWorkspace workspace;
    private readonly ISheetHost host;
    private readonly Grid alertLayer = new() { Background = new SolidColorBrush(Color.FromArgb(0x59, 0, 0, 0)), IsVisible = false };
    private ScheduledEntry[]? entries;
    private string? errorText;
    private string shown = "";
    private Task? reading;
    private bool readAgain, keepError, acting;
    public ScheduledEntry[] Entries => entries ?? [];
    internal ScheduleEditorView? Editor { get; private set; }
    // Mac onDismiss: whatever closes the sheet reads the schedules again.
    public SchedulesPage(LinuxWorkspace workspace, ISheetHost host) : base(workspace)
    {
        this.workspace = workspace; this.host = host;
        Layers.Children.Add(alertLayer); alertLayer.ZIndex = 5;
        workspace.ServerChanged += Changed;
        Render();
    }
    protected override void Release() => workspace.ServerChanged -= Changed;
    private void Changed() { if (!Token.IsCancellationRequested) GoalUi.OnUi(() => _ = LoadAsync()); }
    public override Task InitializeAsync() => LoadAsync();

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
        var add = GoalUi.Round(RequestIcons.Plus, LinuxStrings.ScheduleEditors_Render_1, filled: true); add.VerticalAlignment = VerticalAlignment.Top; add.Click += (_, _) => OpenEditor(null);
        DockPanel.SetDock(add, Dock.Right); header.Children.Add(add);
        var title = new StackPanel(); title.Children.Add(new TextBlock { Text = LinuxStrings.MainWindow_BuildSidebar_4, FontSize = 34, FontWeight = FontWeight.Bold });
        title.Children.Add(GoalUi.Text(LinuxStrings.ScheduleEditors_Render_3, 14, BellTheme.Muted, margin: new Thickness(0, 8, 0, 0)));
        header.Children.Add(title); Body.Children.Add(header);
        if (errorText is { } error) Body.Children.Add(GoalUi.Text(error, 13, BellTheme.Red, margin: new Thickness(0, 0, 0, 20)));
        if (entries is null) { Body.Children.Add(new Spinner(BellTheme.Muted, 20) { Margin = new Thickness(0, 75, 0, 0), HorizontalAlignment = HorizontalAlignment.Center }); return; }
        if (entries.Length == 0)
        {
            if (errorText is not null)
            {
                var retry = LinkButton(LinuxStrings.MainWindow_BuildConversation_13, () => _ = LoadAsync()); retry.HorizontalAlignment = HorizontalAlignment.Center; retry.Margin = new Thickness(0, 14, 0, 0);
                Body.Children.Add(GoalUi.Unavailable(Icons.Warning, LinuxStrings.ScheduleEditors_Render_5, LinuxStrings.MainWindow_BuildConversation_12, retry));
            }
            else Body.Children.Add(GoalUi.Unavailable(Icons.Calendar, LinuxStrings.ScheduleEditors_Render_7, LinuxStrings.ScheduleEditors_Render_8));
            return;
        }
        foreach (var entry in entries) { var card = BuildCard(entry); card.Margin = new Thickness(0, 0, 0, 20); Body.Children.Add(card); }
    }

    // Mac kind symbol: a calendar for a one-time schedule, the repeat arrows for every recurring kind.
    internal static string KindIcon(string kind) => ScheduleText.IsOneTime(kind) ? Icons.Calendar : RequestIcons.Repeat;

    private Border BuildCard(ScheduledEntry entry)
    {
        var schedule = entry.Schedule; var violet = BellTheme.Violet;
        var owner = workspace.Conversations.FirstOrDefault(candidate => candidate.Target == entry.Target) ?? new ConversationEntry(entry.Target, entry.OwnerName, "", DateTimeOffset.MinValue, null, null);
        var stack = new StackPanel();
        var head = new Grid { ColumnDefinitions = new ColumnDefinitions("Auto,*,Auto") };
        head.Children.Add(new AvatarTile { Entry = owner, Workspace = workspace, Width = 42, Height = 42, Margin = new Thickness(0, 0, 12, 0) });
        var labels = new StackPanel { VerticalAlignment = VerticalAlignment.Center }; Grid.SetColumn(labels, 1);
        labels.Children.Add(GoalUi.Text(entry.OwnerName, 13, violet, FontWeight.SemiBold));
        labels.Children.Add(Clamp(GoalUi.Text(schedule.Title, 17, BellTheme.Ink, FontWeight.Bold, new Thickness(0, 3, 0, 0)), 2, 22));
        head.Children.Add(labels);
        var kind = Icons.Draw(KindIcon(schedule.Kind), 17, violet, thickness: 1.8); kind.Margin = new Thickness(12, 0, 0, 0); Grid.SetColumn(kind, 2); head.Children.Add(kind);
        stack.Children.Add(head);
        if ((schedule.Command ?? schedule.Prompt) is { } action) stack.Children.Add(Clamp(GoalUi.Text(action, 14, BellTheme.Muted, margin: new Thickness(0, 14, 0, 0)), 3, 20));
        var next = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 14, 0, 0), Spacing = 6 };
        next.Children.Add(Icons.Draw(RequestIcons.Clock, 14, violet, thickness: 2)); var nextText = GoalUi.Text(ScheduleText.Next(schedule.NextRunAt), 12, violet, FontWeight.Medium); nextText.TextWrapping = TextWrapping.NoWrap; nextText.VerticalAlignment = VerticalAlignment.Center; next.Children.Add(nextText);
        stack.Children.Add(next);
        stack.Children.Add(new Border { Height = 1, Background = Hairline, Margin = new Thickness(0, 14) });
        var tint = new SolidColorBrush(Color.FromArgb(0x14, 0x61, 0x47, 0xD4));
        Button Tinted(string label, Action click, string? icon = null)
        {
            var button = Capsule(label, tint, violet, 8, 12, new Thickness(12, 6));
            if (icon is not null) button.Content = Icons.Draw(icon, 14, violet, thickness: 2);
            AutomationProperties.SetName(button, label); button.Click += (_, _) => click(); return button;
        }
        var buttons = new Grid { ColumnDefinitions = new ColumnDefinitions("*,Auto") };
        var run = Tinted(LinuxStrings.ScheduleEditors_BuildCard_1, () => _ = ActAsync(() => workspace.Planning.RunScheduleAsync(entry, Token))); run.HorizontalAlignment = HorizontalAlignment.Left; buttons.Children.Add(run);
        var right = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 12 }; Grid.SetColumn(right, 1);
        right.Children.Add(Tinted(LinuxStrings.GoalViews_Build_2, () => OpenEditor(entry)));
        right.Children.Add(Tinted(LinuxStrings.MemberEditors_AskDelete_1, () => AskDelete(entry), RequestIcons.Trash));
        buttons.Children.Add(right); stack.Children.Add(buttons);
        var card = MacUi.Card(stack, new Thickness(18));
        AutomationProperties.SetName(card, LinuxStrings.ScheduleEditors_BuildCard_4(entry.OwnerName, schedule.Title));
        return card;
    }
    // Mac lineLimit(n): n lines of a fixed height, the last one cut with an ellipsis.
    private static TextBlock Clamp(TextBlock text, int lines, double lineHeight)
    {
        text.LineHeight = lineHeight; text.MaxLines = lines; text.TextTrimming = TextTrimming.CharacterEllipsis; return text;
    }

    private void AskDelete(ScheduledEntry entry)
    {
        alertLayer.Children.Clear();
        alertLayer.Children.Add(AlertFrame(LinuxStrings.ScheduleEditors_AskDelete_1, "", () => alertLayer.IsVisible = false,
            new AlertChoice(LinuxStrings.MemberEditors_AskDelete_1, () => _ = ActAsync(() => workspace.Planning.DeleteScheduleAsync(entry, Token)), Destructive: true), new AlertChoice(LinuxStrings.EditorForm_CloseLabel_2, Bold: true)));
        alertLayer.IsVisible = true;
    }
    private void OpenEditor(ScheduledEntry? entry)
    {
        var view = new ScheduleEditorView(workspace, entry, () => { if (!Token.IsCancellationRequested) GoalUi.OnUi(() => _ = LoadAsync()); }) { Closer = host.CloseSheet };
        Editor = view; host.OpenSheet(entry is null ? LinuxStrings.ScheduleEditors_Render_1 : LinuxStrings.ScheduleEditors_OpenEditor_2, view);
    }
    // Render seams: the sheet and the delete confirmation without a click.
    internal ScheduleEditorView OpenEditorForRender(string? id = null) { OpenEditor(id is null ? null : Entries.First(entry => entry.Schedule.Id == id)); return Editor!; }
    internal void AskDeleteForRender() => AskDelete(Entries[0]);
}

// Mac ScheduleEditor: 担当, 実行内容 and タイミング as a grouped form in the sheet. The same schedule is written back whole (PUT); a new one is a POST. 保存 sends once and never again by itself.
public sealed class ScheduleEditorView : SheetFormView
{
    internal static readonly FormOption[] Frequencies = [new("once", LinuxStrings.ScheduleEditors_Frequencies_1), new("hourly", LinuxStrings.ScheduleEditors_Frequencies_2), new("daily", LinuxStrings.ScheduleEditors_Frequencies_3), new("weekly", LinuxStrings.ScheduleEditors_Frequencies_4), new("interval_days", LinuxStrings.ScheduleEditors_Frequencies_5), new("interval_hours", LinuxStrings.ScheduleEditors_Frequencies_6), new("cron", LinuxStrings.ScheduleEditors_Frequencies_7)];
    private static readonly string[] DayNames = [LinuxStrings.ScheduleEditors_DayNames_1, LinuxStrings.ScheduleEditors_DayNames_2, LinuxStrings.ScheduleEditors_DayNames_3, LinuxStrings.ScheduleEditors_DayNames_4, LinuxStrings.ScheduleEditors_DayNames_5, LinuxStrings.ScheduleEditors_DayNames_6, LinuxStrings.ScheduleEditors_DayNames_7];
    private readonly LinuxWorkspace workspace;
    private readonly ScheduledEntry? initial;
    private Action? dismissed;
    private readonly ScheduleDraft draft;
    private readonly ConversationEntry[] owners;
    private readonly FormPopup target, action, frequency;
    private readonly FormGroup ownerCard = new(), contentCard = new(), timingCard = new();
    private readonly List<Control> memberRows = [];
    private readonly HashSet<string> replyTo;
    private readonly TextBox name, prompt, command, expression;
    private readonly Border kindRow, promptRow, commandRow;
    private readonly CalendarDatePicker once, startDate;
    private readonly TimeBox onceTime, time, time2;
    private readonly FormPopup minute, minute2;
    private readonly List<ToggleButton> days = [];
    private readonly Func<int> intervalDays, intervalHours, startHour, endHour;
    private readonly List<(Control Row, string[] Modes)> timing = [];
    private readonly StackPanel errors = new();
    public string ErrorText { get; private set; } = "";
    public override string CloseLabel => LinuxStrings.EditorForm_CloseLabel_2;

    public ScheduleEditorView(LinuxWorkspace workspace, ScheduledEntry? initial, Action? dismissed = null) : base(workspace)
    {
        this.workspace = workspace; this.initial = initial; this.dismissed = dismissed;
        draft = initial is null ? new ScheduleDraft() : ScheduleDraft.From(initial.Schedule);
        owners = workspace.Conversations.Where(entry => !entry.Target.IsRoom).Concat(workspace.Conversations.Where(entry => entry.Target.IsRoom)).ToArray();
        replyTo = [.. initial?.Schedule.Targets ?? []];

        // 担当
        target = Popup(LinuxStrings.ScheduleEditors_ScheduleEditorView_1, owners.Select(entry => new FormOption(entry.Target.Path, entry.Name)), initial?.Target.Path ?? owners.FirstOrDefault()?.Target.Path);
        target.IsEnabled = initial is null; target.MinWidth = 180;
        ownerCard.Add(Labeled(LinuxStrings.ScheduleEditors_ScheduleEditorView_1, target));

        // 実行内容
        name = Field(LinuxStrings.ScheduleEditors_ScheduleEditorView_3, draft.Name);
        action = Popup(LinuxStrings.ScheduleEditors_ScheduleEditorView_4, [new("prompt", LinuxStrings.ApprovalsDetail_Answering_10), new("command", LinuxStrings.ScheduleEditors_ScheduleEditorView_6)], draft.Action);
        prompt = Field(LinuxStrings.ScheduleEditors_ScheduleEditorView_7, initial?.Schedule.Prompt ?? "", multiline: true, minHeight: 54); prompt.MaxHeight = 136;
        command = Field(LinuxStrings.ScheduleEditors_ScheduleEditorView_8, initial?.Schedule.Command ?? "", multiline: true, minHeight: 36); command.MaxHeight = 85;
        contentCard.Add(Row(name)); contentCard.Add(kindRow = Labeled(LinuxStrings.ScheduleEditors_ScheduleEditorView_4, action)); contentCard.Add(promptRow = Row(prompt)); contentCard.Add(commandRow = Row(command));

        // タイミング
        frequency = Popup(LinuxStrings.ScheduleEditors_ScheduleEditorView_10, Frequencies, draft.Frequency); timingCard.Add(Labeled(LinuxStrings.ScheduleEditors_ScheduleEditorView_10, frequency));
        void AddTiming(Control row, params string[] modes) { timingCard.Add(row); timing.Add((row, modes)); }
        var (initialHour, initialMinute) = initial is null || initial.Schedule.Kind == "once" ? (draft.Date.Hour, draft.Date.Minute) : (draft.Hour, draft.Minute);
        once = new CalendarDatePicker { SelectedDate = draft.Date.Date, DisplayDateStart = draft.Date.Date < DateTime.Today ? draft.Date.Date : DateTime.Today, FontSize = 13, MinWidth = 130, Background = Brushes.White, BorderBrush = BellTheme.Line, CornerRadius = new CornerRadius(9) };
        AutomationProperties.SetName(once, LinuxStrings.ScheduleEditors_ScheduleEditorView_12);
        onceTime = new TimeBox(LinuxStrings.ScheduleEditors_ScheduleEditorView_13, draft.Date.Hour, draft.Date.Minute) { Margin = new Thickness(8, 0, 0, 0) };
        var onceControl = new StackPanel { Orientation = Orientation.Horizontal, Children = { once, onceTime } };
        AddTiming(Labeled(LinuxStrings.ScheduleEditors_ScheduleEditorView_14, onceControl), "once");
        minute = MinuteBox(LinuxStrings.ScheduleEditors_ScheduleEditorView_15, draft.Minute); AddTiming(Labeled(LinuxStrings.ScheduleEditors_ScheduleEditorView_15, minute), "hourly");
        time = new TimeBox(LinuxStrings.ScheduleEditors_ScheduleEditorView_17, initialHour, initialMinute); AddTiming(Labeled(LinuxStrings.ScheduleEditors_ScheduleEditorView_17, time), "daily", "weekly");
        for (var day = 0; day < 7; day++) AddTiming(SwitchRow(DayNames[day], draft.Weekdays.Contains(day), days), "weekly");
        var stepDays = Stepper(value => LinuxStrings.ScheduleEditors_ScheduleEditorView_19(value), draft.IntervalDays, 1, 365); intervalDays = stepDays.Value; AddTiming(stepDays.Row, "interval_days");
        startDate = new CalendarDatePicker { SelectedDate = draft.StartDate.Date, FontSize = 13, MinWidth = 130, Background = Brushes.White, BorderBrush = BellTheme.Line, CornerRadius = new CornerRadius(9) }; AutomationProperties.SetName(startDate, LinuxStrings.ScheduleEditors_ScheduleEditorView_20); AddTiming(Labeled(LinuxStrings.ScheduleEditors_ScheduleEditorView_20, startDate), "interval_days");
        time2 = new TimeBox(LinuxStrings.ScheduleEditors_ScheduleEditorView_17, initialHour, initialMinute); AddTiming(Labeled(LinuxStrings.ScheduleEditors_ScheduleEditorView_17, time2), "interval_days");
        var stepHours = Stepper(value => LinuxStrings.ScheduleEditors_ScheduleEditorView_24(value), draft.IntervalHours, 1, 24); intervalHours = stepHours.Value; AddTiming(stepHours.Row, "interval_hours");
        var stepStart = Stepper(value => LinuxStrings.ScheduleEditors_ScheduleEditorView_25(value), draft.StartHour, 0, 23); startHour = stepStart.Value; AddTiming(stepStart.Row, "interval_hours");
        var stepEnd = Stepper(value => LinuxStrings.ScheduleEditors_ScheduleEditorView_26(value), draft.EndHour, 0, 23); endHour = stepEnd.Value; AddTiming(stepEnd.Row, "interval_hours");
        minute2 = MinuteBox(LinuxStrings.ScheduleEditors_ScheduleEditorView_27, draft.Minute); AddTiming(Labeled(LinuxStrings.ScheduleEditors_ScheduleEditorView_27, minute2), "interval_hours");
        expression = Field(LinuxStrings.ScheduleEditors_Frequencies_7, draft.Expression); AddTiming(Row(expression), "cron");
        // The two 時刻 rows and the two minute lists are one value each, shown where the Mac shows them.
        time.Changed += () => time2.Set(time.Hour, time.Minute); time2.Changed += () => time.Set(time2.Hour, time2.Minute);
        minute.SelectionChanged += (_, _) => minute2.SelectedId = minute.SelectedId; minute2.SelectionChanged += (_, _) => minute.SelectedId = minute2.SelectedId;

        Form.Children.Add(Section(LinuxStrings.LatticeWindow_ViewSwitch_4, ownerCard)); Form.Children.Add(Section(LinuxStrings.ScheduleEditors_ScheduleEditorView_31, contentCard)); Form.Children.Add(Section(LinuxStrings.ScheduleEditors_ScheduleEditorView_32, timingCard)); Form.Children.Add(errors);
        target.SelectionChanged += (_, _) => { replyTo.Clear(); TargetChanged(); }; action.SelectionChanged += (_, _) => ShowContent(); frequency.SelectionChanged += (_, _) => ShowTiming();
        TargetChanged(); ShowTiming(); Ready = true; Notify();
    }

    private ConversationEntry? Owner => owners.FirstOrDefault(entry => entry.Target.Path == target.SelectedId);
    private bool Commands => action.SelectedId == "command" && Owner?.Target.IsRoom != true;
    protected override bool SaveBlocked => Owner is null;
    public override void Dispose() { base.Dispose(); var done = dismissed; dismissed = null; done?.Invoke(); }

    // Mac: a room has no 種類 and always sends an instruction; its members can be named as repliers.
    private void TargetChanged()
    {
        foreach (var row in memberRows) ownerCard.Remove(row);
        memberRows.Clear();
        if (Owner?.Room is { } room)
        {
            var hint = Note(LinuxStrings.ScheduleEditors_TargetChanged_1, BellTheme.Ink, 12); memberRows.Add(hint); ownerCard.Add(hint);
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
    private void ShowTiming() { foreach (var (row, modes) in timing) timingCard.SetVisible(row, frequency.SelectedId is { } mode && modes.Contains(mode)); }

    private static FormPopup MinuteBox(string label, int value) { var box = Popup(label, Enumerable.Range(0, 60).Select(minute => new FormOption(minute.ToString(CultureInfo.InvariantCulture), LinuxStrings.ScheduleEditors_MinuteBox_1(minute))), value.ToString(CultureInfo.InvariantCulture)); box.MinWidth = 90; return box; }
    private static Border SwitchRow(string label, bool on, List<ToggleButton>? collect, Action<bool>? changed = null)
    {
        var toggle = Switch(); toggle.IsChecked = on; AutomationProperties.SetName(toggle, label); collect?.Add(toggle);
        if (changed is not null) toggle.IsCheckedChanged += (_, _) => changed(toggle.IsChecked == true);
        var grid = new Grid { VerticalAlignment = VerticalAlignment.Center, ColumnDefinitions = new ColumnDefinitions("*,Auto") };
        var caption = Text(label, 13); caption.VerticalAlignment = VerticalAlignment.Center; grid.Children.Add(caption); Grid.SetColumn(toggle, 1); grid.Children.Add(toggle); return Row(grid);
    }
    // Mac Stepper: the value in its label, minus and plus on the right.
    private static (Border Row, Func<int> Value) Stepper(Func<int, string> label, int value, int min, int max)
    {
        var current = Math.Clamp(value, min, max); var text = Text(label(current), 13); text.VerticalAlignment = VerticalAlignment.Center;
        Button Step(string glyph, int delta, string stepName)
        {
            var button = Capsule(glyph, Brushes.Transparent, BellTheme.Ink, 8, 15, new Thickness(12, 2)); AutomationProperties.SetName(button, stepName);
            button.Click += (_, _) => { current = Math.Clamp(current + delta, min, max); text.Text = label(current); }; return button;
        }
        var pair = new StackPanel { Orientation = Orientation.Horizontal, Children = { Step("−", -1, LinuxStrings.ScheduleEditors_Stepper_1), new Border { Width = 1, Height = 16, Background = Hairline }, Step("+", 1, LinuxStrings.ScheduleEditors_Stepper_2) } };
        var grid = new Grid { VerticalAlignment = VerticalAlignment.Center, ColumnDefinitions = new ColumnDefinitions("*,Auto") };
        grid.Children.Add(text); var frame = new Border { Child = pair, Background = Fill, CornerRadius = new CornerRadius(8) }; Grid.SetColumn(frame, 1); grid.Children.Add(frame);
        return (Row(grid), () => current);
    }

    private void Show(string message)
    {
        ErrorText = message; errors.Children.Clear(); errors.Children.Add(Section(null, new FormGroup(Row(Text(message, 13, BellTheme.Red)))));
    }

    // Mac save(): the typed values become the whole schedule; a room always sends the instruction.
    internal Dictionary<string, object?> Collect(out ConversationEntry owner)
    {
        var picked = owner = Owner ?? throw new ArgumentException(LinuxStrings.ScheduleEditors_Collect_1);
        var room = picked.Target.IsRoom; var frequencyId = frequency.SelectedId!;
        draft.Name = name.Text ?? ""; draft.Action = Commands ? "command" : "prompt"; draft.Content = (Commands ? command.Text : prompt.Text) ?? ""; draft.Frequency = frequencyId;
        if (frequencyId == "once")
        {
            if (once.SelectedDate is not { } date) throw new ArgumentException(LinuxStrings.ScheduleEditors_Collect_2);
            draft.Date = date.Date + new TimeSpan(onceTime.Hour, onceTime.Minute, 0);
        }
        if (frequencyId is "hourly" or "interval_hours") draft.Minute = int.Parse(minute.SelectedId!, CultureInfo.InvariantCulture);
        else { draft.Hour = time.Hour; draft.Minute = time.Minute; }
        draft.Weekdays = days.Select((toggle, day) => (toggle, day)).Where(item => item.toggle.IsChecked == true).Select(item => item.day).ToHashSet();
        draft.IntervalDays = intervalDays(); draft.IntervalHours = intervalHours(); draft.StartHour = startHour(); draft.EndHour = endHour();
        if (startDate.SelectedDate is { } start) draft.StartDate = start.Date;
        draft.Expression = expression.Text ?? "";
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
        if (ownerPath is not null) target.SelectedId = ownerPath;
        if (nameText is not null) name.Text = nameText;
        if (text is not null) (Commands ? command : prompt).Text = text;
        if (frequencyId is not null) frequency.SelectedId = frequencyId;
        if (weekdays is not null) for (var day = 0; day < days.Count; day++) days[day].IsChecked = weekdays.Contains(day);
    }

    // The Mac hour-and-minute picker: two lists.
    internal sealed class TimeBox : StackPanel
    {
        private readonly FormPopup hour, minute;
        private bool setting;
        public event Action? Changed;
        public TimeBox(string label, int h, int m)
        {
            Orientation = Orientation.Horizontal;
            hour = Popup(LinuxStrings.ScheduleEditors_TimeBox_1(label), Enumerable.Range(0, 24).Select(value => new FormOption(value.ToString(CultureInfo.InvariantCulture), value.ToString(CultureInfo.InvariantCulture))), h.ToString(CultureInfo.InvariantCulture)); hour.MinWidth = 64;
            minute = Popup(LinuxStrings.ScheduleEditors_TimeBox_2(label), Enumerable.Range(0, 60).Select(value => new FormOption(value.ToString(CultureInfo.InvariantCulture), value.ToString("00", CultureInfo.InvariantCulture))), m.ToString(CultureInfo.InvariantCulture)); minute.MinWidth = 64;
            Children.Add(hour); Children.Add(new TextBlock { Text = ":", FontSize = 13, Margin = new Thickness(6, 0), VerticalAlignment = VerticalAlignment.Center }); Children.Add(minute);
            hour.SelectionChanged += (_, _) => { if (!setting) Changed?.Invoke(); }; minute.SelectionChanged += (_, _) => { if (!setting) Changed?.Invoke(); };
        }
        public int Hour => int.Parse(hour.SelectedId!, CultureInfo.InvariantCulture);
        public int Minute => int.Parse(minute.SelectedId!, CultureInfo.InvariantCulture);
        public void Set(int h, int m) { setting = true; hour.SelectedId = h.ToString(CultureInfo.InvariantCulture); minute.SelectedId = m.ToString(CultureInfo.InvariantCulture); setting = false; }
    }
}
