using System.Globalization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using BellTeam.Core;

namespace BellTeam.App;

public sealed class SchedulesWindow : EditorWindow
{
    private readonly Workspace workspace;
    public SchedulesWindow(Workspace workspace) : base("予定", workspace.ConnectionToken)
    {
        this.workspace = workspace; SaveButton.Visibility = Visibility.Collapsed; CloseButton.Content = "閉じる";
        workspace.ServerChanged += Changed; Closed += (_, _) => workspace.ServerChanged -= Changed;
    }
    private void Changed() { if (!Busy && !Token.IsCancellationRequested) _ = InitializeAsync(); }
    public Task InitializeAsync() => RunAsync(async () =>
    {
        var entries = new List<ScheduledEntry>();
        var sources = await workspace.Planning.AllSchedulesAsync(workspace.Conversations.Select(owner => (owner.Target, owner.Name)), Token);
        foreach (var source in sources)
        {
            var owner = workspace.Conversations.FirstOrDefault(entry => entry.Target == source.Target);
            if (owner is not null) entries.AddRange(source.Schedules.Select(schedule => new ScheduledEntry(owner.Target, owner.Name, schedule)));
        }
        Token.ThrowIfCancellationRequested(); Body.Children.Clear();
        var heading = new DockPanel { Margin = new Thickness(0, 0, 0, 8) };
        var add = new Button { Content = "予定を追加", Tag = "\uE710", VerticalAlignment = VerticalAlignment.Top }; add.SetResourceReference(StyleProperty, "PrimaryButton"); add.Click += (_, _) => Edit(null); DockPanel.SetDock(add, Dock.Right); heading.Children.Add(add);
        var refresh = new Button { Content = "\uE72C", FontFamily = new FontFamily("Segoe Fluent Icons, Segoe MDL2 Assets"), ToolTip = "再読込", VerticalAlignment = VerticalAlignment.Top }; refresh.SetResourceReference(StyleProperty, "IconButton"); refresh.Click += (_, _) => _ = InitializeAsync(); DockPanel.SetDock(refresh, Dock.Right); heading.Children.Add(refresh);
        System.Windows.Automation.AutomationProperties.SetName(refresh, "再読込");
        var title = new StackPanel(); title.Children.Add(new TextBlock { Text = "予定", FontSize = 32, FontWeight = FontWeights.Bold, Margin = new Thickness(0, 0, 0, 8) }); title.Children.Add(new TextBlock { Text = "チームに任せた仕事の、これから。", FontSize = 16, Foreground = Brushes.SlateGray, Margin = new Thickness(0, 0, 0, 18) }); heading.Children.Add(title); Body.Children.Add(heading);
        var shown = entries.Where(entry => entry.Schedule.NextRunAt is not null || entry.Schedule.Enabled).OrderBy(entry => entry.Schedule.NextRunAt is { } next ? DateTimeOffset.Parse(next, CultureInfo.InvariantCulture) : DateTimeOffset.MaxValue).ToArray();
        if (shown.Length == 0) Heading("予定はありません");
        foreach (var entry in shown)
        {
            var card = new StackPanel { Margin = new Thickness(18) };
            var owner = workspace.Conversations.FirstOrDefault(candidate => candidate.Target == entry.Target) ?? new ConversationEntry(entry.Target, entry.OwnerName, "", DateTimeOffset.MinValue, null, null);
            var caption = new DockPanel { Margin = new Thickness(0, 0, 0, 12) }; caption.Children.Add(new AvatarTile { Entry = owner, Workspace = workspace, Width = 42, Height = 42, Margin = new Thickness(0, 0, 12, 0) });
            var labels = new StackPanel(); labels.Children.Add(new TextBlock { Text = entry.OwnerName, FontSize = 14, FontWeight = FontWeights.SemiBold, Foreground = new SolidColorBrush(Color.FromRgb(97, 71, 212)) }); labels.Children.Add(new TextBlock { Text = entry.Schedule.Title, FontSize = 18, FontWeight = FontWeights.Bold, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 5, 0, 0) }); caption.Children.Add(labels); card.Children.Add(caption);
            card.Children.Add(new TextBlock { Text = entry.Schedule.Command ?? entry.Schedule.Prompt ?? "", FontSize = 14, TextWrapping = TextWrapping.Wrap, Foreground = Brushes.SlateGray, MaxHeight = 65, TextTrimming = TextTrimming.CharacterEllipsis });
            card.Children.Add(new TextBlock { Text = entry.Schedule.NextRunAt is { } next ? "次回 " + DateTimeOffset.Parse(next, CultureInfo.InvariantCulture).ToLocalTime().ToString("M/d (ddd) HH:mm") : "次回未定", FontSize = 14, Foreground = new SolidColorBrush(Color.FromRgb(97, 71, 212)), Margin = new Thickness(0, 14, 0, 12) });
            card.Children.Add(new Border { Height = 1, Background = new SolidColorBrush(Color.FromRgb(229, 227, 240)), Margin = new Thickness(0, 0, 0, 6) });
            var row = new DockPanel { LastChildFill = false }; card.Children.Add(row);
            void Button(string label, Action action, Dock dock = Dock.Right) { var button = new Button { Content = label, HorizontalAlignment = HorizontalAlignment.Left }; button.SetResourceReference(StyleProperty, "QuietButton"); button.Click += (_, _) => action(); DockPanel.SetDock(button, dock); row.Children.Add(button); }
            Button("今すぐ実行", () => _ = RunAsync(async () => { await workspace.Planning.RunScheduleAsync(entry, Token); Status.Text = "実行を受け付けました。再読込で次回を確認できます。"; return false; }), Dock.Left);
            Button("削除", () =>
            {
                if (new ConfirmationWindow("予定を削除", "この予定を削除しますか？", "削除") { Owner = DialogOwner }.ShowDialog() == true)
                    _ = DeleteAsync(entry);
            });
            Button("編集", () => Edit(entry));
            Body.Children.Add(new Border { Child = card, Background = Brushes.White, CornerRadius = new CornerRadius(24), BorderBrush = new SolidColorBrush(Color.FromRgb(229, 227, 240)), BorderThickness = new Thickness(1), Margin = new Thickness(0, 16, 0, 0) });
        }
        return false;
    }, canClose: true);
    private async Task DeleteAsync(ScheduledEntry entry)
    {
        var deleted = false;
        await RunAsync(async () => { await workspace.Planning.DeleteScheduleAsync(entry, Token); deleted = true; return false; });
        if (deleted) await InitializeAsync();
    }
    private void Edit(ScheduledEntry? entry) { var editor = new ScheduleEditor(workspace, entry) { Owner = DialogOwner }; editor.ShowDialog(); _ = InitializeAsync(); }
}

public sealed class ScheduleEditor : EditorWindow
{
    public ScheduleEditor(Workspace workspace, ScheduledEntry? initial) : base(initial is null ? "予定を追加" : "予定を編集", workspace.ConnectionToken)
    {
        var draft = initial is null ? new ScheduleDraft() : ScheduleDraft.From(initial.Schedule);
        Heading("担当");
        var target = new ComboBox { ItemsSource = workspace.Conversations, DisplayMemberPath = nameof(ConversationEntry.Name), Padding = new Thickness(8) };
        target.SelectedItem = workspace.Conversations.FirstOrDefault(entry => initial is null || entry.Target == initial.Target); target.IsEnabled = initial is null; Body.Children.Add(target);
        var replies = new StackPanel(); Body.Children.Add(replies); var targets = new List<(string Id, CheckBox Check)>();
        Heading("実行内容"); var name = TextField("予定の名前", draft.Name);
        var action = Choice("種類", [new("prompt", "AIへの指示"), new("command", "コマンド")], draft.Action);
        var content = TextField(draft.Action == "command" ? "実行するコマンド" : "依頼する内容", draft.Content, true);
        var contentLabel = (TextBlock)Body.Children[Body.Children.IndexOf(content) - 1];
        action.SelectionChanged += (_, _) => contentLabel.Text = action.SelectedValue as string == "command" ? "実行するコマンド" : "依頼する内容";
        Heading("タイミング");
        var frequency = Choice("繰り返し", [new("once", "一回だけ"), new("hourly", "毎時"), new("daily", "毎日"), new("weekly", "毎週"), new("interval_days", "数日おき"), new("interval_hours", "数時間おき"), new("cron", "cron式")], draft.Frequency);
        var rows = new List<(FrameworkElement Element, string[] Modes)>();
        T Row<T>(string label, T control, params string[] modes) where T : FrameworkElement
        {
            var panel = new StackPanel { Margin = new Thickness(0, 6, 0, 6) }; panel.Children.Add(new TextBlock { Text = label, Margin = new Thickness(0, 0, 0, 5) }); panel.Children.Add(control); Body.Children.Add(panel); rows.Add((panel, modes)); return control;
        }
        ComboBox Number(string label, int first, int last, int value, params string[] modes) => Row(label, new ComboBox { ItemsSource = Enumerable.Range(first, last - first + 1).Append(value).Distinct().Order().ToArray(), SelectedItem = value, Padding = new Thickness(8) }, modes);
        var date = Row("実行日", new DatePicker { SelectedDate = draft.Date.Date }, "once");
        var at = Row("実行時刻（HH:mm）", new TextBox { Text = draft.Date.ToString("HH:mm", CultureInfo.InvariantCulture) }, "once");
        var hour = Number("時", 0, 23, draft.Hour, "daily", "weekly", "interval_days");
        var minute = Number("分", 0, 59, draft.Minute, "hourly", "daily", "weekly", "interval_days", "interval_hours");
        var weekdays = Row("曜日", new WrapPanel(), "weekly"); var days = new List<(int Day, CheckBox Check)>();
        for (var day = 0; day < 7; day++) { var check = new CheckBox { Content = new[] { "日", "月", "火", "水", "木", "金", "土" }[day], IsChecked = draft.Weekdays.Contains(day), Margin = new Thickness(4, 8, 12, 8) }; days.Add((day, check)); weekdays.Children.Add(check); }
        var intervalDays = Number("何日おき", 1, 365, draft.IntervalDays, "interval_days");
        var startDate = Row("開始日", new DatePicker { SelectedDate = draft.StartDate }, "interval_days");
        var intervalHours = Number("何時間おき", 1, 24, draft.IntervalHours, "interval_hours");
        var startHour = Number("開始（時）", 0, 23, draft.StartHour, "interval_hours"); var endHour = Number("終了（時）", 0, 23, draft.EndHour, "interval_hours");
        var expression = Row("cron式", new TextBox { Text = draft.Expression }, "cron");
        var timezone = Row("タイムゾーン", new TextBlock { Text = draft.Timezone }, "hourly", "daily", "weekly", "interval_days", "interval_hours", "cron");
        void Timing() { foreach (var row in rows) row.Element.Visibility = row.Modes.Contains(frequency.SelectedValue as string) ? Visibility.Visible : Visibility.Collapsed; }
        void TargetChanged()
        {
            replies.Children.Clear(); targets.Clear();
            var entry = target.SelectedItem as ConversationEntry;
            if (entry?.Room is { } room)
            {
                action.SelectedValue = "prompt"; action.IsEnabled = false;
                replies.Children.Add(new TextBlock { Text = "返信するメンバーを指定。未選択なら自動選択し、発言は全員に届きます。", TextWrapping = TextWrapping.Wrap });
                foreach (var id in room.MemberIds)
                {
                    var check = new CheckBox { Content = workspace.Bots.FirstOrDefault(bot => bot.Id == id)?.DisplayName ?? id, IsChecked = initial?.Schedule.Targets?.Contains(id) == true, Margin = new Thickness(0, 6, 0, 6) }; targets.Add((id, check)); replies.Children.Add(check);
                }
            }
            else action.IsEnabled = true;
        }
        target.SelectionChanged += (_, _) => TargetChanged(); frequency.SelectionChanged += (_, _) => Timing(); TargetChanged(); Timing();
        SaveAction = async () =>
        {
            if (target.SelectedItem is not ConversationEntry entry) throw new ArgumentException("担当を選んでください。");
            draft.Name = name.Text; draft.Action = (string)action.SelectedValue; draft.Content = content.Text; draft.Frequency = (string)frequency.SelectedValue;
            if (draft.Frequency == "once")
            {
                if (date.SelectedDate is not { } selectedDate || !TimeOnly.TryParseExact(at.Text, "HH:mm", CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.None, out var time)) throw new ArgumentException("実行日時を入力してください。");
                draft.Date = selectedDate.Date + time.ToTimeSpan();
            }
            draft.Hour = (int)hour.SelectedItem; draft.Minute = (int)minute.SelectedItem; draft.Weekdays = days.Where(day => day.Check.IsChecked == true).Select(day => day.Day).ToHashSet();
            draft.IntervalDays = (int)intervalDays.SelectedItem; draft.IntervalHours = (int)intervalHours.SelectedItem; draft.StartHour = (int)startHour.SelectedItem; draft.EndHour = (int)endHour.SelectedItem;
            if (draft.Frequency == "interval_days") draft.StartDate = startDate.SelectedDate ?? throw new ArgumentException("開始日を選んでください。");
            draft.Expression = expression.Text;
            await workspace.Planning.SaveScheduleAsync(entry.Target, initial?.Schedule.Id, draft.Payload(entry.Target.IsRoom, targets.Where(item => item.Check.IsChecked == true).Select(item => item.Id).ToArray()), Token);
            return true;
        };
    }
}
