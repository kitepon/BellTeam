using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using BellTeam.Core;

namespace BellTeam.App;

public sealed class SettingsWindow(Workspace workspace, Action? changeServer = null) : EditorWindow("設定", workspace.ConnectionToken)
{
    public async Task InitializeAsync()
    {
        SaveButton.Visibility = Visibility.Collapsed; CloseButton.Content = "閉じる";
        await RunAsync(async () =>
        {
            var owner = (await workspace.Planning.OwnerAsync(Token)).Owner;
            var features = await workspace.Planning.FeaturesAsync(Token); Token.ThrowIfCancellationRequested(); Body.Children.Clear();
            Body.Children.Add(new TextBlock { Text = "設定", FontSize = 32, FontWeight = FontWeights.Bold, Margin = new Thickness(0, 0, 0, 24) });
            var profile = new StackPanel { Margin = new Thickness(25) };
            var portraitEntry = new ConversationEntry(new("owner", false), owner.Name, "", DateTimeOffset.MinValue, new Bot { Id = "owner", Name = owner.Name, DisplayName = owner.Name, Avatar = owner.Avatar }, null);
            profile.Children.Add(new AvatarTile { Entry = portraitEntry, Workspace = workspace, Width = 83, Height = 83, HorizontalAlignment = HorizontalAlignment.Center });
            profile.Children.Add(new TextBlock { Text = owner.Name, FontSize = 24, FontWeight = FontWeights.Bold, TextAlignment = TextAlignment.Center, Margin = new Thickness(0, 15, 0, 10) });
            if (owner.Profile.Length != 0) profile.Children.Add(new TextBlock { Text = owner.Profile, FontSize = 16, TextWrapping = TextWrapping.Wrap, TextAlignment = TextAlignment.Center, Foreground = Brushes.SlateGray });
            var edit = new Button { Content = "プロフィールと規範を編集", HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 18, 0, 0) }; edit.SetResourceReference(StyleProperty, "PrimaryButton");
            edit.Click += (_, _) => { var editor = new ProfileEditor(workspace) { Owner = DialogOwner }; _ = editor.InitializeAsync(); editor.ShowDialog(); _ = ReloadAsync(); }; profile.Children.Add(edit); Body.Children.Add(Card(profile));
            var connection = new StackPanel { Margin = new Thickness(20) }; connection.Children.Add(new TextBlock { Text = "接続先", FontSize = 17, FontWeight = FontWeights.SemiBold }); connection.Children.Add(new TextBlock { Text = new Uri(workspace.Server).Authority, FontSize = 16, Foreground = Brushes.SlateGray, Margin = new Thickness(0, 12, 0, 8) }); connection.Children.Add(new TextBlock { Text = workspace.AuthMode == "cloudflare" ? "Cloudflare Accessで認証済み" : "ローカル接続", FontSize = 14, Foreground = Brushes.MediumAquamarine });
            if (changeServer is not null) { var change = new Button { Content = "接続先を変更", HorizontalAlignment = HorizontalAlignment.Left, Margin = new Thickness(0, 14, 0, 0) }; change.Click += (_, _) => changeServer(); connection.Children.Add(change); } Body.Children.Add(Card(connection));
            var authentication = new StackPanel { Margin = new Thickness(20) };
            authentication.Children.Add(new TextBlock { Text = "AIの認証", FontSize = 20, FontWeight = FontWeights.SemiBold });
            authentication.Children.Add(new TextBlock { Text = "AIの認証が切れたときや、別のアカウントで入り直すときに使います。", FontSize = 14, Foreground = Brushes.SlateGray, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 10, 0, 12) });
            try
            {
                var harnesses = (await new HarnessAuthenticationApi(workspace.Management.Api).ListAsync(Token)).Harnesses; Token.ThrowIfCancellationRequested();
                foreach (var harness in harnesses)
                {
                    var row = new DockPanel(); var usage = new TextBlock { Text = harness.UsageText, Foreground = Brushes.SlateGray, FontSize = 14 }; DockPanel.SetDock(usage, Dock.Right); row.Children.Add(usage); row.Children.Add(new TextBlock { Text = harness.Name, FontSize = 17 });
                    var open = new Button { Content = row, HorizontalContentAlignment = HorizontalAlignment.Stretch }; open.SetResourceReference(StyleProperty, "QuietButton");
                    open.Click += (_, _) => { var editor = new HarnessAuthenticationWindow(workspace, harness) { Owner = DialogOwner }; _ = editor.InitializeAsync(); editor.ShowDialog(); }; authentication.Children.Add(open);
                }
            }
            catch (OperationCanceledException) when (Token.IsCancellationRequested) { throw; }
            catch (Exception error)
            {
                authentication.Children.Add(new TextBlock { Text = "AIの種類を確認できませんでした。\n" + error.Message, Foreground = Brushes.Firebrick, TextWrapping = TextWrapping.Wrap });
                var retry = new Button { Content = "一覧を更新", HorizontalAlignment = HorizontalAlignment.Left }; retry.Click += (_, _) => _ = ReloadAsync(); authentication.Children.Add(retry);
            }
            Body.Children.Add(Card(authentication));
            Heading("追加機能"); Body.Children.Add(new TextBlock { Text = "未設定の機能は無効です。案内役との会話でも設定できます。", FontSize = 14, Foreground = Brushes.SlateGray, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 0, 0, 12) });
            foreach (var feature in features)
            {
                var row = new DockPanel { Margin = new Thickness(12) }; row.Children.Add(new TextBlock { Text = feature.StatusText, FontSize = 14, Foreground = feature.ApplyFailed ? Brushes.Firebrick : Brushes.SlateGray, HorizontalAlignment = HorizontalAlignment.Right }); DockPanel.SetDock(row.Children[0], Dock.Right);
                row.Children.Add(new TextBlock { Text = feature.Title, FontSize = 17, TextWrapping = TextWrapping.Wrap });
                var button = new Button { Content = row, HorizontalContentAlignment = HorizontalAlignment.Stretch, Margin = new Thickness(0) }; button.SetResourceReference(StyleProperty, "QuietButton"); button.Foreground = new SolidColorBrush(Color.FromRgb(33, 41, 61));
                button.Click += (_, _) => { var editor = new FeatureEditor(workspace, feature.Id, feature.Title) { Owner = DialogOwner }; _ = editor.InitializeAsync(); editor.ShowDialog(); _ = ReloadAsync(); }; Body.Children.Add(Card(button));
            }
            Body.Children.Add(new TextBlock { Text = "BellTeam for Windows " + typeof(MainWindow).Assembly.GetName().Version?.ToString(3), FontSize = 14, Foreground = Brushes.SlateGray, Margin = new Thickness(4, 16, 0, 4) });
            return false;
        }, canClose: true);
    }
    private static Border Card(UIElement content) => new() { Child = content, Background = Brushes.White, CornerRadius = new CornerRadius(24), BorderBrush = new SolidColorBrush(Color.FromRgb(229, 227, 240)), BorderThickness = new Thickness(1), Margin = new Thickness(0, 0, 0, 12) };
    private async Task ReloadAsync() { Body.Children.Clear(); await InitializeAsync(); }
}

public sealed class FeatureEditor : EditorWindow
{
    private readonly Workspace workspace;
    private readonly string id;
    private readonly List<(FeatureField Field, TextBox? Text, PasswordBox? Password, CheckBox? Remove)> inputs = [];
    public FeatureEditor(Workspace workspace, string id, string title) : base(title, workspace.ConnectionToken)
    {
        this.workspace = workspace; this.id = id;
        Deactivated += (_, _) => ClearSecrets(); Closed += (_, _) => ClearSecrets();
    }
    public void ClearSecrets() { foreach (var input in inputs) input.Password?.Clear(); }
    public async Task InitializeAsync()
    {
        SaveButton.IsEnabled = false; Status.Text = "読み込んでいます…";
        try
        {
            var original = (await workspace.Planning.FeaturesAsync(Token)).Single(setting => setting.Id == id); Token.ThrowIfCancellationRequested();
            var enabled = new CheckBox { Content = "有効にする", IsChecked = original.Enabled, Margin = new Thickness(0, 10, 0, 14) }; Body.Children.Add(enabled);
            Body.Children.Add(new TextBlock { Text = "必要な項目を登録してから有効にしてください。秘密の値は会話へ送られません。", TextWrapping = TextWrapping.Wrap });
            if (original.ApplyFailed) Body.Children.Add(new TextBlock { Text = "設定を保存しましたが、反映できませんでした。設定を確認して再度保存してください。", TextWrapping = TextWrapping.Wrap, Foreground = System.Windows.Media.Brushes.Firebrick });
            Heading("設定");
            foreach (var field in original.Fields)
            {
                if (!field.Secret) { inputs.Add((field, TextField(field.Label, field.Value), null, null)); continue; }
                Body.Children.Add(new TextBlock { Text = field.Label, Margin = new Thickness(0, 10, 0, 5) });
                Body.Children.Add(new TextBlock { Text = field.Configured ? "登録済み・変更するときだけ入力" : "未設定", FontSize = 14 });
                var password = new PasswordBox { Margin = new Thickness(0, 5, 0, 5), Padding = new Thickness(10, 8, 10, 8), FontSize = 16 }; Body.Children.Add(password);
                var remove = new CheckBox { Content = "保存すると登録済みの値を消す", Margin = new Thickness(0, 4, 0, 8) };
                remove.Checked += (_, _) => { password.Clear(); password.IsEnabled = false; }; remove.Unchecked += (_, _) => password.IsEnabled = true;
                Body.Children.Add(remove); inputs.Add((field, null, password, remove));
            }
            SaveAction = async () =>
            {
                var values = CollectChanges(); ClearSecrets();
                bool? changedEnabled = enabled.IsChecked == original.Enabled ? null : enabled.IsChecked == true;
                if (values.Count == 0 && changedEnabled is null) return true;
                try
                {
                    var updated = await workspace.Planning.SaveFeatureAsync(id, changedEnabled, values, Token);
                    if (updated.ApplyFailed) { Saved = true; Status.Text = "設定を保存しましたが、反映できませんでした。閉じて最新の状態を確認してください。"; return false; }
                    return true;
                }
                finally { values.Clear(); }
            };
            Status.Text = ""; SaveButton.IsEnabled = true;
        }
        catch (OperationCanceledException) when (Token.IsCancellationRequested) { }
        catch (Exception) { Status.Text = "追加機能の設定を読み取れませんでした。接続と認証を確認してください。"; }
    }
    public Dictionary<string, string> CollectChanges()
    {
        var values = new Dictionary<string, string>();
        foreach (var input in inputs)
        {
            if (input.Field.Secret)
            {
                if (input.Remove!.IsChecked == true) values[input.Field.Key] = "";
                else if (input.Password!.Password.Length != 0) values[input.Field.Key] = input.Password.Password;
            }
            else if (input.Text!.Text != input.Field.Value) values[input.Field.Key] = input.Text.Text;
        }
        return values;
    }
}

public sealed class ProfileEditor(Workspace workspace) : EditorWindow("プロフィール", workspace.ConnectionToken)
{
    public async Task InitializeAsync()
    {
        SaveButton.IsEnabled = false; Status.Text = "読み込んでいます…";
        try
        {
            var api = workspace.Planning;
            var original = (await api.OwnerAsync(Token)).Owner;
            var originalRules = (await api.RulesAsync(Token)).Text; Token.ThrowIfCancellationRequested();
            Heading("あなた"); var avatar = new AvatarPicker(original.Avatar, name: original.Name); Body.Children.Add(avatar); InitialLoads.Add(avatar.LoadAsync());
            var name = TextField("名前", original.Name); var profile = TextField("プロフィール", original.Profile, true);
            Heading("リンク"); var x = TextField("XのURL", original.XUrl); var github = TextField("GitHubのURL", original.GithubUrl);
            var links = new List<(TextBox Label, TextBox Url)>(); var linkPanel = new StackPanel(); Body.Children.Add(linkPanel);
            void AddLink(OwnerLink value)
            {
                var row = new StackPanel { Margin = new Thickness(0, 10, 0, 10) };
                row.Children.Add(new TextBlock { Text = "名前" }); var label = new TextBox { Text = value.Label }; row.Children.Add(label);
                row.Children.Add(new TextBlock { Text = "URL" }); var url = new TextBox { Text = value.Url }; row.Children.Add(url);
                var remove = new Button { Content = "リンクを削除", HorizontalAlignment = HorizontalAlignment.Left }; remove.Click += (_, _) => { links.Remove((label, url)); linkPanel.Children.Remove(row); }; row.Children.Add(remove);
                links.Add((label, url)); linkPanel.Children.Add(row);
            }
            foreach (var link in original.Links) AddLink(link); ActionButton("リンクを追加", () => AddLink(new("", "")));
            Heading("ユーザー規範"); Body.Children.Add(new TextBlock { Text = "チーム全員があなたについて共有する指示です。", TextWrapping = TextWrapping.Wrap });
            var rules = TextField("ユーザー規範", originalRules, true);
            SaveAction = async () =>
            {
                if (string.IsNullOrWhiteSpace(name.Text)) throw new ArgumentException("名前を入力してください。");
                var edited = original with { Name = name.Text, Profile = profile.Text, Avatar = avatar.Value, XUrl = x.Text, GithubUrl = github.Text, Links = links.Select(link => new OwnerLink(link.Label.Text, link.Url.Text)).ToArray() };
                var changes = edited.ChangesFrom(original);
                if (changes.Count != 0) { await api.SaveOwnerAsync(changes, Token); original = edited; }
                if (TextContent.Normalize(rules.Text) != TextContent.Normalize(originalRules))
                {
                    try { originalRules = (await api.SaveRulesAsync(rules.Text, Token)).Text; }
                    catch (Exception error) { throw new BellApiException("プロフィールの保存処理は完了しています。ユーザー規範の保存結果を確認できませんでした。\n" + error.Message); }
                }
                return true;
            };
            Status.Text = ""; SaveButton.IsEnabled = true;
        }
        catch (OperationCanceledException) when (Token.IsCancellationRequested) { }
        catch (Exception error) { Status.Text = error.Message; }
    }
}
