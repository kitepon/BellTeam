using System.Windows;
using System.Windows.Controls;
using BellTeam.Core;

namespace BellTeam.App;

public sealed class ModelPicker : StackPanel
{
    private readonly ModelSelection selection;
    private readonly ComboBox harness = Combo();
    private readonly ComboBox model = Combo();
    private readonly ComboBox effort = Combo();
    private readonly TextBox custom = new();
    private readonly TextBlock customLabel = new() { Text = "モデルID", Margin = new Thickness(0, 9, 0, 5) };
    private readonly TextBlock error = new() { TextWrapping = TextWrapping.Wrap, Foreground = System.Windows.Media.Brushes.Firebrick };
    private readonly CheckBox fast = new() { Content = "ファストモード", Margin = new Thickness(0, 12, 0, 6) };
    private readonly TextBlock fastReason = new() { TextWrapping = TextWrapping.Wrap, FontSize = 14, Margin = new Thickness(0, 0, 0, 8) };
    private bool updating;
    private string? loadError;
    public ModelPicker(BotSettings initial)
    {
        selection = new(initial.Harness, initial.Model, initial.ReasoningEffort);
        System.Windows.Automation.AutomationProperties.SetName(custom, "モデルID");
        var harnesses = new List<FormOption> { new("codex", "Codex"), new("claude", "Claude"), new("grok", "Grok"), new("cursor", "Cursor"), new("antigravity", "Antigravity") };
        if (!harnesses.Any(option => option.Id == initial.Harness)) harnesses.Add(new(initial.Harness, initial.Harness + "（現在の設定）"));
        harness.ItemsSource = harnesses;
        Add("CLI", harness); Add("モデル", model); Children.Add(customLabel); Children.Add(custom); Add("エフォート", effort); Children.Add(error);
        fast.IsChecked = initial.FastMode; Children.Add(fast);
        fast.Checked += (_, _) => RenderFast(); fast.Unchecked += (_, _) => RenderFast();
        Children.Add(new TextBlock { Text = "入れると利用枠を多く使います。", TextWrapping = TextWrapping.Wrap, FontSize = 14 }); Children.Add(fastReason);
        harness.SelectionChanged += (_, _) => { if (updating || harness.SelectedValue is not string id) return; selection.SelectHarness(id); Render(); };
        model.SelectionChanged += (_, _) => { if (updating || model.SelectedValue is not string id) return; selection.SelectModel(id == "__custom__" ? custom.Text : id); RenderEffort(); customLabel.Visibility = custom.Visibility = id == "__custom__" ? Visibility.Visible : Visibility.Collapsed; };
        custom.TextChanged += (_, _) => { if (updating || model.SelectedValue as string != "__custom__") return; selection.SelectModel(custom.Text); RenderEffort(); };
        effort.SelectionChanged += (_, _) => { if (!updating && effort.SelectedValue is string id) selection.Effort = id; };
        Render(); harness.IsEnabled = model.IsEnabled = effort.IsEnabled = false; error.Text = "モデル候補を読み込んでいます…";
    }
    private static ComboBox Combo() => new() { DisplayMemberPath = nameof(FormOption.Label), SelectedValuePath = nameof(FormOption.Id), Padding = new Thickness(8), Margin = new Thickness(0, 0, 0, 8) };
    private void Add(string label, UIElement control)
    {
        System.Windows.Automation.AutomationProperties.SetName(control, label);
        var row = new Grid { Margin = new Thickness(0, 5, 0, 5) }; row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(78) }); row.ColumnDefinitions.Add(new ColumnDefinition());
        row.Children.Add(new TextBlock { Text = label, FontSize = 14, Foreground = System.Windows.Media.Brushes.SlateGray, VerticalAlignment = VerticalAlignment.Center }); Grid.SetColumn(control, 1); row.Children.Add(control); Children.Add(row);
    }
    public async Task LoadAsync(ManagementApi api, CancellationToken token)
    {
        try { selection.SetCatalog((await api.Api.GetAsync<ModelsResponse>("/api/models", token)).Models); }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { return; }
        catch (Exception exception) { loadError = exception.Message; }
        Render();
    }
    private void Render()
    {
        updating = true;
        harness.SelectedValue = selection.Harness;
        var catalog = selection.Catalog.GetValueOrDefault(selection.Harness);
        var options = new List<FormOption> { new("", "CLIの既定") };
        options.AddRange((catalog?.Models ?? []).Select(choice => new FormOption(choice.Id, choice.Id))); options.Add(new("__custom__", "その他"));
        model.ItemsSource = options;
        var known = options.Any(option => option.Id == selection.Model);
        model.SelectedValue = known ? selection.Model : "__custom__";
        custom.Text = known ? "" : selection.Model; customLabel.Visibility = custom.Visibility = known ? Visibility.Collapsed : Visibility.Visible;
        error.Text = loadError ?? catalog?.Error?.Message ?? (catalog is null ? "このCLIのモデル候補がありません。現在の設定を保持しています。" : "");
        harness.IsEnabled = loadError is null;
        model.IsEnabled = effort.IsEnabled = loadError is null && catalog is not null && catalog.Error is null;
        updating = false; RenderEffort();
    }
    private void RenderEffort()
    {
        updating = true;
        var choices = new List<FormOption> { new("", "CLIの既定") };
        choices.AddRange(selection.Efforts.Where(value => value.Length != 0).Select(value => new FormOption(value, value)));
        if (selection.Effort.Length != 0 && !choices.Any(choice => choice.Id == selection.Effort)) choices.Add(new(selection.Effort, selection.Effort + "（現在の設定）"));
        effort.ItemsSource = choices; effort.SelectedValue = selection.Effort; updating = false;
        RenderFast();
    }
    private void RenderFast()
    {
        var reason = loadError ?? selection.FastUnavailableReason;
        fast.IsEnabled = fast.IsChecked == true || reason is null;
        fastReason.Text = reason ?? "";
        fastReason.Visibility = reason is null ? Visibility.Collapsed : Visibility.Visible;
    }
    public void SetSavedFastMode(bool value) => fast.IsChecked = value;
    public BotSettings Apply(BotSettings settings)
    {
        if (model.SelectedValue as string == "__custom__" && string.IsNullOrWhiteSpace(custom.Text)) throw new ArgumentException("モデルIDを入力してください。");
        return settings with { Harness = selection.Harness, Model = selection.Model, ReasoningEffort = selection.Effort, FastMode = fast.IsChecked == true };
    }
}

public sealed class MemberEditor(Workspace workspace, string? id) : EditorWindow(id is null ? "メンバーを追加" : "メンバーを編集", workspace.ConnectionToken)
{
    private BotSettings? original;
    private Dictionary<string, object?> submitted = [];
    public Task ModelLoad { get; private set; } = Task.CompletedTask;
    public async Task InitializeAsync()
    {
        Width = Math.Min(1120, SystemParameters.WorkArea.Width); Height = Math.Min(900, SystemParameters.WorkArea.Height);
        SaveButton.IsEnabled = false; Status.Text = "読み込んでいます…";
        try
        {
            var api = workspace.Management;
            original = id is null ? new BotSettings { Name = "", Harness = "codex" } : (await api.GetBotAsync(id, Token)).Bot;
            Token.ThrowIfCancellationRequested();
            var memberSection = Section("メンバー"); var avatar = new AvatarPicker(original.Avatar, name: original.Name, color: original.Color, compact: true); memberSection.Children.Add(avatar); InitialLoads.Add(avatar.LoadAsync());
            var name = TextField("名前", original.Name, parent: memberSection, inlineLabel: true); var position = TextField("役職", original.Position, parent: memberSection, inlineLabel: true);
            var color = Choice("テーマ色", [new("violet", "紫"), new("rose", "ローズ"), new("indigo", "インディゴ")], original.Color, memberSection, inlineLabel: true);
            var aiSection = Section("AI"); var models = new ModelPicker(original); aiSection.Children.Add(models); ModelLoad = models.LoadAsync(api, Token); InitialLoads.Add(ModelLoad);
            var profileSection = Section("プロフィール"); var profile = TextField("背景・見た目・関係性", original.ProfileText, true, profileSection); var personality = TextField("性格・考え方", original.Personality, true, profileSection); var speech = TextField("口調", original.SpeechStyle, true, profileSection); var role = TextField("担当する仕事", original.Role, true, profileSection);
            foreach (var field in new[] { profile, personality, speech, role }) field.MinHeight = 120;
            var sections = Body.Children.Cast<UIElement>().ToArray(); Body.Children.Clear();
            var layout = new Grid(); layout.ColumnDefinitions.Add(new ColumnDefinition()); layout.ColumnDefinitions.Add(new ColumnDefinition()); layout.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto }); layout.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            var identity = new StackPanel(); foreach (var section in sections.Take(4)) identity.Children.Add(section);
            var biography = new StackPanel(); foreach (var section in sections.Skip(4)) biography.Children.Add(section);
            layout.Children.Add(identity); layout.Children.Add(biography); Body.Children.Add(layout);
            void ArrangeSections(double width)
            {
                var wide = width >= 920; layout.ColumnDefinitions[0].Width = wide ? new GridLength(330) : new GridLength(1, GridUnitType.Star); layout.ColumnDefinitions[1].Width = wide ? new GridLength(1, GridUnitType.Star) : new GridLength(0);
                Grid.SetColumn(biography, wide ? 1 : 0); Grid.SetRow(biography, wide ? 0 : 1); biography.Margin = wide ? new Thickness(24, 0, 0, 0) : new Thickness(0);
            }
            ArrangeSections(Width); SizeChanged += (_, args) => ArrangeSections(args.NewSize.Width);
            var confirm = new Button { Content = "保存結果を確認", Visibility = Visibility.Collapsed };
            confirm.Click += async (_, _) => await RunAsync(async () =>
            {
                if (submitted.Count == 0 || id is null) { Status.Text = "先に変更を保存してください。"; return false; }
                if (await api.ConfirmBotAsync(id, submitted, Token)) { await workspace.RefreshManagementAsync(); return true; }
                Status.Text = "現在の設定が保存した内容と一致しません。設定を確認してから編集してください。"; return false;
            }); Actions.Children.Insert(0, confirm);
            SaveAction = async () =>
            {
                if (string.IsNullOrWhiteSpace(name.Text)) throw new ArgumentException("名前を入力してください。");
                var edited = models.Apply(original with { Name = name.Text, Position = position.Text, ProfileText = profile.Text, Personality = personality.Text, SpeechStyle = speech.Text, Role = role.Text, Avatar = avatar.Value, Color = (string?)color.SelectedValue ?? original.Color });
                submitted = edited.ChangesFrom(original);
                if (submitted.Count == 0 && id is not null) return true;
                BotSettingsResponse result;
                try { result = id is null ? await api.CreateBotAsync(edited, Token) : await api.SaveBotAsync(id, submitted, Token); }
                catch { if (id is not null) confirm.Visibility = Visibility.Visible; throw; }
                models.SetSavedFastMode(result.Bot.FastMode);
                await workspace.RefreshManagementAsync();
                if (result.Applying) { Saved = true; Status.Foreground = System.Windows.Media.Brushes.DarkSlateGray; Status.Text = "設定を保存しました。現在の作業が終わってから適用します。"; return false; }
                return true;
            };
            Status.Text = ""; SaveButton.IsEnabled = true;
        }
        catch (OperationCanceledException) when (Token.IsCancellationRequested) { }
        catch (Exception error) { Status.Text = error.Message; SaveButton.IsEnabled = false; }
    }
}

public sealed class RoomEditor(Workspace workspace, string? id) : EditorWindow(id is null ? "ルームを作る" : "ルームを編集", workspace.ConnectionToken)
{
    public async Task InitializeAsync()
    {
        SaveButton.IsEnabled = false; Status.Text = "読み込んでいます…";
        try
        {
            var api = workspace.Management;
            var original = id is null ? new RoomSettings("", "", [], null, "") : RoomSettings.From((await api.Api.GetAsync<RoomResponse>(new ChatTarget(id, true).Path, Token)).Room);
            Token.ThrowIfCancellationRequested();
            Heading("ルーム"); var avatar = new AvatarPicker(original.Avatar, name: original.Name, isRoom: true); Body.Children.Add(avatar); InitialLoads.Add(avatar.LoadAsync());
            var name = TextField("ルーム名", original.Name); var purpose = TextField("この部屋で共有する仕事", original.Purpose, true);
            Heading("メンバー"); var members = new List<(FormOption Member, CheckBox Choice)>();
            var representative = new ComboBox { DisplayMemberPath = nameof(FormOption.Label), SelectedValuePath = nameof(FormOption.Id), Padding = new Thickness(8) };
            var memberOptions = workspace.Bots.Select(bot => new FormOption(bot.Id, bot.DisplayName)).ToList();
            memberOptions.AddRange(original.MemberIds.Where(member => !memberOptions.Any(option => option.Id == member)).Select(member => new FormOption(member, member + "（現在のメンバー）")));
            foreach (var member in memberOptions)
            {
                var choice = new CheckBox { Content = member.Label, IsChecked = original.MemberIds.Contains(member.Id), Margin = new Thickness(0, 6, 0, 6) };
                members.Add((member, choice)); Body.Children.Add(choice);
            }
            void Representatives()
            {
                var selected = representative.SelectedValue as string ?? original.RepresentativeId ?? "";
                var options = new[] { new FormOption("", "代表なし") }.Concat(members.Where(member => member.Choice.IsChecked == true).Select(member => member.Member)).ToArray();
                representative.ItemsSource = options; representative.SelectedValue = options.Any(option => option.Id == selected) ? selected : "";
            }
            foreach (var member in members) { member.Choice.Checked += (_, _) => Representatives(); member.Choice.Unchecked += (_, _) => Representatives(); }
            Heading("代表"); Body.Children.Add(representative); Representatives();
            if (id is not null)
            {
                ActionButton("ルームを削除", () =>
                {
                    if (new ConfirmationWindow("ルームを削除", $"「{original.Name}」を削除しますか？\nこのルームの設定・会話履歴・予定が削除され、元に戻せません。参加メンバーと個別の記憶は残ります。", "削除") { Owner = this }.ShowDialog() == true)
                        _ = RunAsync(async () => { await api.DeleteRoomAsync(id, Token); await workspace.RefreshManagementAsync(); return true; });
                });
            }
            SaveAction = async () =>
            {
                if (string.IsNullOrWhiteSpace(name.Text)) throw new ArgumentException("ルーム名を入力してください。");
                var selected = representative.SelectedValue as string;
                var edited = new RoomSettings(name.Text.Trim(), purpose.Text, members.Where(member => member.Choice.IsChecked == true).Select(member => member.Member.Id).ToArray(), string.IsNullOrEmpty(selected) ? null : selected, avatar.Value);
                if (id is null) await api.CreateRoomAsync(edited, Token);
                else { var changes = edited.ChangesFrom(original); if (changes.Count == 0) return true; await api.UpdateRoomAsync(id, changes, Token); }
                await workspace.RefreshManagementAsync(); return true;
            };
            Status.Text = ""; SaveButton.IsEnabled = true;
        }
        catch (OperationCanceledException) when (Token.IsCancellationRequested) { }
        catch (Exception error) { Status.Text = error.Message; SaveButton.IsEnabled = false; }
    }
}
