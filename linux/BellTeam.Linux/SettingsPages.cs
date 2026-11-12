using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Controls.Primitives;
using Avalonia.Input;
using Avalonia.Layout;
using Avalonia.Media;
using BellTeam.Core;
using static BellTeam.Linux.SettingsUi;

namespace BellTeam.Linux;

// Page bodies of the Mac settings. Each loader catches its own failures and shows them with the reason; nothing is retried.
public sealed partial class SettingsWindow
{
    private const string PrivacyPolicyUrl = "https://bellteam-subscriptions.kitepon.workers.dev/privacy";
    private const string SupportUrl = "https://bellteam-subscriptions.kitepon.workers.dev/support";

    protected override Window? DialogOwner => TopLevel.GetTopLevel(pane) as Window;
    private static IBrush Tone(HarnessTone tone) => tone switch { HarnessTone.Good => Green, HarnessTone.Warning => Orange, _ => Muted };
    private static StackPanel CardTitle(string glyph, string title, double size = 13)
    {
        var line = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
        line.Children.Add(Glyph(glyph, size + 3, Ink)); line.Children.Add(Text(title, size, Ink, FontWeight.SemiBold)); ((TextBlock)line.Children[1]).VerticalAlignment = VerticalAlignment.Center;
        return line;
    }
    private static Border FillRow(Control content, Action? click)
    {
        var row = new Border { Child = content, Background = Fill, CornerRadius = new CornerRadius(8), Padding = new Thickness(12, 10), Margin = new Thickness(0, 8, 0, 0), Cursor = click is null ? null : Hand };
        if (click is not null) row.PointerReleased += (_, args) => { if (args.InitialPressMouseButton == MouseButton.Left) click(); };
        return row;
    }
    private static Button OpenLink(string label, string url, Action<string> failed)
    {
        var button = Capsule(label, Fill, Ink, 8, 13, new Thickness(12, 6)); button.HorizontalAlignment = HorizontalAlignment.Left; button.Margin = new Thickness(0, 8, 0, 0); button.FontWeight = FontWeight.Normal;
        button.Click += (_, _) => OpenExternal(url, failed);
        return button;
    }
    private static Button QuietButton(string label, Action click, Thickness margin, double radius = 8)
    {
        var button = Capsule(label, Fill, Ink, radius, 13, new Thickness(12, 6)); button.HorizontalAlignment = HorizontalAlignment.Left; button.Margin = margin; button.FontWeight = FontWeight.Normal;
        button.Click += (_, _) => click(); return button;
    }
    private static TextBlock Loading(string text) => Text(text, 13, Secondary, null, new Thickness(0, 10, 0, 0));

    // ---- プロフィール ----
    private async Task ProfilePageAsync(CancellationToken token)
    {
        var page = NewPage(SettingsPage.Profile);
        var content = new StackPanel(); page.Children.Add(content); content.Children.Add(Loading("読み込んでいます…"));
        var save = Capsule("保存", new SolidColorBrush(Color.FromRgb(0xE9, 0xE9, 0xEE)), Ink, 15, 13, new Thickness(14, 5)); save.IsEnabled = false;
        SetToolbar(null, null, save);
        try
        {
            var api = workspace.Planning;
            var original = (await api.OwnerAsync(token)).Owner; var originalRules = (await api.RulesAsync(token)).Text; token.ThrowIfCancellationRequested();
            UpdateProfileRow(original); content.Children.Clear();
            var avatar = new AvatarPicker(original.Avatar, name: original.Name, quiet: true) { HorizontalAlignment = HorizontalAlignment.Center }; InitialLoads.Add(avatar.LoadAsync());
            var name = Field("名前", original.Name); var profile = Field("プロフィール", original.Profile, multiline: true);
            content.Children.Add(FormSection("あなた", new GroupCard(Row(avatar, 0), Row(name.Element), Row(profile.Element))));
            var x = Field("XのURL", original.XUrl); var github = Field("GitHubのURL", original.GithubUrl);
            var group = new GroupCard(Row(x.Element), Row(github.Element));
            var links = new List<(TextBox Label, TextBox Url)>();
            group.Add(Row(IconButtonRow(Icons.PlusCircle, "リンクを追加", Violet, () => AddLink(new("", "")))));
            void AddLink(OwnerLink value)
            {
                var label = Field("名前", value.Label); var url = Field("URL", value.Url);
                var fields = new StackPanel(); fields.Children.Add(label.Element); fields.Children.Add(new Border { Height = 1, Background = Hairline, Margin = new Thickness(0, 8) }); fields.Children.Add(url.Element);
                var line = new Grid { ColumnDefinitions = new ColumnDefinitions("*,Auto") }; line.Children.Add(fields);
                var delete = Capsule("", Brushes.Transparent, Red, 8, 14, new Thickness(8, 4)); delete.Content = Glyph(SettingsIcons.Trash, 18, Red); delete.Margin = new Thickness(8, 0, 0, 0); delete.VerticalAlignment = VerticalAlignment.Center; AutomationProperties.SetName(delete, "リンクを削除");
                Grid.SetColumn(delete, 1); line.Children.Add(delete);
                var holder = Row(line); links.Add((label.Box, url.Box));
                delete.Click += (_, _) => { links.Remove((label.Box, url.Box)); group.Remove(holder); };
                group.Insert(group.Count - 1, holder);
            }
            foreach (var link in original.Links) AddLink(link);
            content.Children.Add(FormSection("リンク", group));
            var rules = Field("あなたの決まり", originalRules, multiline: true, minHeight: 180);
            content.Children.Add(FormSection("あなたの決まり", new GroupCard(Row(rules.Element)), "チーム全員が、あなたについて守る指示です。"));
            var notice = new StackPanel(); content.Children.Add(notice);
            save.IsEnabled = true;
            save.Click += async (_, _) =>
            {
                if (Busy) return;
                notice.Children.Clear();
                if (string.IsNullOrWhiteSpace(name.Box.Text)) { notice.Children.Add(Banner("名前を入力してください。")); return; }
                Busy = true; save.IsEnabled = false;
                try
                {
                    var edited = original with { Name = name.Box.Text ?? "", Profile = profile.Box.Text ?? "", Avatar = avatar.Value, XUrl = x.Box.Text ?? "", GithubUrl = github.Box.Text ?? "", Links = links.Select(link => new OwnerLink(link.Label.Text ?? "", link.Url.Text ?? "")).ToArray() };
                    var changes = edited.ChangesFrom(original);
                    if (changes.Count != 0) { await api.SaveOwnerAsync(changes, Token); original = edited; UpdateProfileRow(edited); }
                    if (TextContent.Normalize(rules.Box.Text ?? "") != TextContent.Normalize(originalRules))
                    {
                        try { originalRules = (await api.SaveRulesAsync(rules.Box.Text ?? "", Token)).Text; }
                        catch (Exception error) when (error is not OperationCanceledException) { notice.Children.Add(Banner("プロフィールの保存処理は完了しています。あなたの決まりの保存結果を確認できませんでした。\n" + error.Message)); return; }
                    }
                    var saved = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6, Margin = new Thickness(0, 10, 0, 0), Children = { Glyph(Icons.Check, 16, Green), Text("保存しました", 14, Green) } }; notice.Children.Add(saved);
                }
                catch (OperationCanceledException) when (Token.IsCancellationRequested) { }
                catch (Exception error) { notice.Children.Add(Banner(ErrorText(error))); }
                finally { Busy = false; save.IsEnabled = true; }
            };
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
        catch (Exception error) { content.Children.Clear(); content.Children.Add(Banner(error.Message)); }
    }

    // ---- AIの設定 ----
    private async Task AiPageAsync(CancellationToken token)
    {
        var page = NewPage(SettingsPage.Ai);
        var auth = new StackPanel(); auth.Children.Add(CardTitle(SettingsIcons.Person, "AIの認証"));
        auth.Children.Add(Text("AIの認証が切れたときや、別のアカウントで入り直すときに使います。", 14, Muted, null, new Thickness(0, 10, 0, 0)));
        var list = new StackPanel(); auth.Children.Add(list);
        var summary = new StackPanel(); summary.Children.Add(CardTitle(SettingsIcons.List, "仕事の要約を書くAI"));
        summary.Children.Add(Text("メンバー一覧に出る「今の仕事」を、チームで一人のAIがまとめます。", 14, Muted, null, new Thickness(0, 10, 0, 0)));
        var authCard = Card(auth); authCard.Margin = new Thickness(0, 16, 0, 0); var summaryCard = Card(summary); summaryCard.Margin = new Thickness(0, 16, 0, 0);
        page.Children.Add(authCard); page.Children.Add(summaryCard);
        await Task.WhenAll(LoadHarnessesAsync(list, token), LoadSummaryAsync(summary, token));
    }

    private async Task LoadHarnessesAsync(StackPanel list, CancellationToken token)
    {
        list.Children.Clear(); list.Children.Add(Loading("AIの種類を確認しています。"));
        try
        {
            var api = new HarnessAuthenticationApi(workspace.Management.Api);
            var harnesses = (await api.ListAsync(token)).Harnesses; token.ThrowIfCancellationRequested(); list.Children.Clear();
            var states = new List<Task>();
            foreach (var harness in harnesses)
            {
                if (harness.Id == "claude") { var host = new StackPanel(); list.Children.Add(host); states.Add(LoadClaudeAsync(host, harness, api, token)); continue; }
                var names = new StackPanel { VerticalAlignment = VerticalAlignment.Center }; names.Children.Add(Text(harness.Name, 14, Ink)); names.Children.Add(Text(harness.UsageText, 12, Muted, null, new Thickness(0, 2, 0, 0)));
                var (row, ready) = AuthRow(names, harness, api, null, null, token); list.Children.Add(row); states.Add(ready);
            }
            await Task.WhenAll(states);
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
        catch (Exception error)
        {
            list.Children.Clear(); list.Children.Add(Text("AIの種類を確認できませんでした。\n" + error.Message, 13, Red, null, new Thickness(0, 10, 0, 0)));
            list.Children.Add(QuietButton("一覧を更新", () => _ = LoadHarnessesAsync(list, token), new Thickness(0, 10, 0, 0)));
        }
    }

    // One AI-authentication row: names | state | action. slot is the Claude account slot ("1st"/"2nd") whose login the row reads and starts; null is the single login.
    // afterDialog replaces the row's own state re-read when the login window closes.
    private (Grid Row, Task Ready) AuthRow(Control names, HarnessAuthenticationOption harness, HarnessAuthenticationApi api, string? slot, Func<Task>? afterDialog, CancellationToken token)
    {
        var row = new Grid { Margin = new Thickness(0, 10, 0, 0), ColumnDefinitions = new ColumnDefinitions("*,Auto,Auto") };
        var state = Text("", 12, Muted, FontWeight.SemiBold, new Thickness(10, 0)); state.VerticalAlignment = VerticalAlignment.Center; Grid.SetColumn(state, 1);
        var action = Capsule("", Violet, Brushes.White); Grid.SetColumn(action, 2); action.VerticalAlignment = VerticalAlignment.Center;
        row.Children.Add(names); row.Children.Add(state); row.Children.Add(action);
        void Show(HarnessRowState value) { state.Text = value.Title; state.Foreground = Tone(value.Tone); action.Content = value.Action; }
        async Task ReadStateAsync()
        {
            Show(HarnessRowState.Checking);
            try { var status = (await api.StatusAsync(harness.Id, token, slot)).Auth?.Status; Show(slot is null ? HarnessRowState.From(status, harness.ReloginSupported) : HarnessRowState.FromSlot(status)); }
            catch (OperationCanceledException) when (token.IsCancellationRequested) { }
            catch (Exception) { Show(HarnessRowState.Unavailable); }
        }
        action.Click += async (_, _) =>
        {
            var dialog = new HarnessAuthenticationWindow(workspace, harness, slot: slot); _ = dialog.InitializeAsync();
            if (DialogOwner is { } owner) await dialog.ShowDialog(owner); else dialog.Show();
            await (afterDialog?.Invoke() ?? ReadStateAsync());
        };
        AutomationProperties.SetName(action, slot is null ? harness.Name : harness.Name + " " + AccountText.SlotTitle(slot));
        return (row, ReadStateAsync());
    }

    // Claude: the two account slots when the server lists accounts, the old single row when GET /api/accounts answers 404 (older server),
    // and for any other read failure the reason with 一覧を更新 (never the old row, which would hide that the slots exist).
    private async Task LoadClaudeAsync(StackPanel host, HarnessAuthenticationOption harness, HarnessAuthenticationApi auth, CancellationToken token)
    {
        host.Children.Clear();
        var accounts = new HarnessAccountsApi(workspace.Management.Api);
        Task Reload() => LoadClaudeAsync(host, harness, auth, token);
        void Failed(string message) { host.Children.Clear(); host.Children.Add(Text("Claudeのアカウントを確認できませんでした。\n" + message, 13, Red, null, new Thickness(0, 10, 0, 0))); host.Children.Add(QuietButton("一覧を更新", () => _ = Reload(), new Thickness(0, 10, 0, 0))); }
        AccountsResponse? list;
        try { list = await accounts.ReadAsync(token); token.ThrowIfCancellationRequested(); }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { return; }
        catch (Exception error) { Failed(error.Message); return; }
        if (list is null)
        {
            var oldNames = new StackPanel { VerticalAlignment = VerticalAlignment.Center }; oldNames.Children.Add(Text(harness.Name, 14, Ink)); oldNames.Children.Add(Text(harness.UsageText, 12, Muted, null, new Thickness(0, 2, 0, 0)));
            var (single, oldReady) = AuthRow(oldNames, harness, auth, null, null, token); host.Children.Add(single); await oldReady; return;
        }
        if (list.Claude is not { } claude) { Failed("アカウントの一覧にClaudeの項目がありません。"); return; }
        var now = DateTimeOffset.Now;
        // Mac ClaudeAccountsCard: the harness name with its usage on the right, the both-limited lines, then the slots as plain rows like the other AI rows.
        var heading = new Grid { Margin = new Thickness(0, 10, 0, 0), ColumnDefinitions = new ColumnDefinitions("*,Auto") };
        var usage = Text(harness.UsageText, 12, Muted); usage.VerticalAlignment = VerticalAlignment.Center; Grid.SetColumn(usage, 1);
        heading.Children.Add(Text(harness.Name, 14, Ink)); heading.Children.Add(usage); host.Children.Add(heading);
        foreach (var text in AccountText.CardBannerTexts(list, now))
        {
            var bar = Text("⚠ " + text, 12, Orange, null, new Thickness(0, 6, 0, 0)); AutomationProperties.SetName(bar, text); host.Children.Add(bar);
        }
        var ready = new List<Task>();
        foreach (var slot in claude.Slots)
        {
            if (AccountText.SlotTitle(slot.Slot) is not { } slotTitle) continue;
            var names = new StackPanel { VerticalAlignment = VerticalAlignment.Center }; names.Children.Add(Text(slotTitle, 14, Ink, FontWeight.SemiBold));
            var lines = new List<(string Text, IBrush Color)>();
            if (AccountText.Login(slot) is { } account) lines.Add((account, Muted));
            lines.AddRange(slot.Limits.Select(item => (AccountText.LimitText(item.Scope, item.ResetAt, now), Orange)));
            if (AccountText.Seats(slot, workspace.MemberName) is { } seats) lines.Add((seats, Muted));
            // The contract asks that the Owner sees a slot whose history could not be shared (harness-accounts `history: separate`); the Mac has no line for it yet.
            if (slot.History == "separate") lines.Add(("会話の履歴は1stアカウントと分かれています", Muted));
            foreach (var (value, color) in lines) names.Children.Add(Text(value, 12, color, null, new Thickness(0, 2, 0, 0)));
            var (row, state) = AuthRow(names, harness, auth, slot.Slot, Reload, token); row.Margin = new Thickness(0, 8, 0, 0);
            AutomationProperties.SetName(row, slotTitle); host.Children.Add(row); ready.Add(state);
        }
        await Task.WhenAll(ready);
    }

    private async Task LoadSummaryAsync(StackPanel card, CancellationToken token)
    {
        var line = Loading("読み込んでいます…"); card.Children.Add(line);
        try
        {
            var record = await workspace.Planning.BackgroundAgentAsync(token); token.ThrowIfCancellationRequested(); card.Children.Remove(line);
            var text = Text(record?.Summary ?? "このサーバーの版では設定できません。", 13, Ink);
            var row = FillRow(text, record is null ? null : () => _ = OpenBackgroundAgentAsync(record)); row.Margin = new Thickness(0, 12, 0, 0); row.Padding = new Thickness(12);
            if (record is null) text.Foreground = Muted;
            AutomationProperties.SetName(row, "仕事の要約を書くAI");
            card.Children.Add(row);
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
        catch (Exception error) { card.Children.Remove(line); card.Children.Add(Text(error.Message, 13, Red, null, new Thickness(0, 10, 0, 0))); }
    }

    // The summary-AI editor (Mac BackgroundAgentEditor): CLI, model and effort pickers drawn only from the model catalog.
    private async Task OpenBackgroundAgentAsync(BackgroundAgentRecord first)
    {
        var token = lifetime?.Token ?? Token;
        var form = NewPage(null, scroll: false); ShowSubPage("仕事の要約を書くAI", new ScrollViewer { Content = form, VerticalScrollBarVisibility = ScrollBarVisibility.Auto }, Reopen);
        var record = first; var catalog = new Dictionary<string, HarnessModels>();
        string harness = record.Selection?.Harness ?? "codex", model = record.Selection?.Model ?? "", effort = record.Selection?.ReasoningEffort ?? "";
        string? savedText = null, errorText = null; var loading = true; var saving = false;
        void Render()
        {
            form.Children.Clear();
            if (loading) { form.Children.Add(Loading("モデル候補を読み込んでいます…")); return; }
            var draft = new BackgroundAgentSelection(harness, model, effort); var problem = BackgroundAgentChoices.Problem(catalog, draft);
            var efforts = BackgroundAgentChoices.Efforts(catalog, harness, model);
            var cli = Picker("CLI", BackgroundAgentChoices.Harnesses.Select(item => new FormOption(item.Id, item.Label)).ToArray(), harness, value => { harness = value; model = ""; effort = ""; Render(); });
            var models = new List<FormOption> { new("", "選んでください") }; models.AddRange(BackgroundAgentChoices.Models(catalog, harness).Select(item => new FormOption(item.Id, item.Label)));
            if (model.Length != 0 && models.All(item => item.Id != model)) models.Add(new(model, $"{model}（現在の候補にありません）"));
            var modelPicker = Picker("モデル", models.ToArray(), model, value => { model = value; if (!BackgroundAgentChoices.Efforts(catalog, harness, value).Contains(effort)) effort = ""; Render(); });
            var effortOptions = new List<FormOption> { new("", efforts.Length == 0 ? "CLIの既定（エフォート指定なし）" : "選んでください") }; effortOptions.AddRange(efforts.Select(item => new FormOption(item, item)));
            if (effort.Length != 0 && effortOptions.All(item => item.Id != effort)) effortOptions.Add(new(effort, $"{effort}（現在の候補にありません）"));
            var effortPicker = Picker("エフォート", effortOptions.ToArray(), effort, value => { effort = value; Render(); });
            form.Children.Add(FormSection(null, new GroupCard(cli, modelPicker, effortPicker), "保存しても、要約がすぐ作られるとは限りません。要約の状態はメンバー一覧で確かめてください。"));
            if (problem is not null) form.Children.Add(Text(problem, 13, Red, null, new Thickness(20, 10, 20, 0)));
            if (record.Selection is { } stored && stored != draft) form.Children.Add(Text("保存されている設定：" + BackgroundAgentRecord.Describe(stored), 13, Muted, null, new Thickness(20, 10, 20, 0)));
            var save = Capsule("保存", Violet, Brushes.White, 8, 13, new Thickness(18, 7)); save.HorizontalAlignment = HorizontalAlignment.Left; save.Margin = new Thickness(20, 14, 0, 0); save.IsEnabled = !saving && problem is null;
            save.Click += async (_, _) => await SaveAsync(draft); form.Children.Add(save);
            if (savedText is not null) form.Children.Add(Text(savedText, 13, Muted, null, new Thickness(20, 10, 20, 0)));
            if (errorText is not null)
            {
                form.Children.Add(Text(errorText, 13, Red, null, new Thickness(20, 12, 20, 0)));
                var reload = QuietButton("再読み込み", () => _ = LoadAsync(), new Thickness(20, 8, 0, 0)); reload.IsEnabled = !loading;
                form.Children.Add(reload);
            }
        }
        async Task LoadAsync()
        {
            loading = true; Render();
            try
            {
                var current = await workspace.Planning.BackgroundAgentAsync(token) ?? throw new BellApiException("このサーバーの版では設定できません。");
                catalog = (await workspace.Management.Api.GetAsync<ModelsResponse>("/api/models", token)).Models; token.ThrowIfCancellationRequested();
                record = current; if (current.Selection is { } selection) { harness = selection.Harness; model = selection.Model; effort = selection.ReasoningEffort; }
                errorText = null;
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested) { return; }
            catch (Exception error) { errorText = error.Message; }
            loading = false; Render();
        }
        async Task SaveAsync(BackgroundAgentSelection draft)
        {
            if (saving || Busy) return;
            saving = true; Busy = true; errorText = null; savedText = null; Render();
            try { record = await workspace.Planning.SaveBackgroundAgentAsync(record, draft, Token); savedText = "保存しました。"; }
            catch (OperationCanceledException) when (Token.IsCancellationRequested) { return; }
            catch (Exception error)
            {
                errorText = ErrorText(error);
                // A conflict (another screen saved) or a 5xx (saved, apply unconfirmed): show the stored value, keep the draft.
                if (error is BellApiException { Status: { } status } && ((int)status == 409 || (int)status >= 500))
                    try { record = await workspace.Planning.BackgroundAgentAsync(Token) ?? record; } catch (Exception) { /* the save error above stays; the stored value could not be re-read */ }
            }
            finally { saving = false; Busy = false; }
            Render();
        }
        await LoadAsync();
    }
    private static Border Picker(string label, FormOption[] options, string selected, Action<string> changed)
    {
        var grid = new Grid { VerticalAlignment = VerticalAlignment.Center, ColumnDefinitions = new ColumnDefinitions("110,*") };
        var caption = Text(label, 13); caption.VerticalAlignment = VerticalAlignment.Center; grid.Children.Add(caption);
        var combo = EditorFormView.Popup(label, options, selected); combo.HorizontalAlignment = HorizontalAlignment.Right; combo.MinWidth = 220;
        combo.SelectionChanged += (_, _) => { if (combo.SelectedItem is FormOption { Id: var value } && value != selected) changed(value); };
        Grid.SetColumn(combo, 1); grid.Children.Add(combo);
        return Row(grid);
    }

    // ---- 追加機能 ----
    private async Task FeaturesPageAsync(CancellationToken token)
    {
        var page = NewPage(SettingsPage.Features);
        var card = new StackPanel(); card.Children.Add(CardTitle(SettingsIcons.Sliders, "追加機能"));
        card.Children.Add(Text("未設定の機能は無効です。案内役との会話でも設定できます。", 14, Muted, null, new Thickness(0, 10, 0, 0)));
        var holder = Card(card); holder.Margin = new Thickness(0, 16, 0, 0); page.Children.Add(holder);
        var line = Loading("読み込んでいます…"); card.Children.Add(line);
        try
        {
            var features = await workspace.Planning.FeaturesAsync(token); token.ThrowIfCancellationRequested(); card.Children.Remove(line);
            foreach (var feature in features)
            {
                var grid = new Grid { ColumnDefinitions = new ColumnDefinitions("*,Auto") };
                grid.Children.Add(Text(feature.Title, 13));
                // 1Password連携 shows its connection badge and the plain failure text instead of the generic state (Mac FeatureSettingsList).
                var onePassword = feature.Id == OnePasswordItem.Id;
                Control status = onePassword ? OnePasswordView.Badge(OnePasswordItem.State(feature)) : Text(feature.StatusText, 13, feature.ApplyFailed ? Red : Muted); status.Margin = new Thickness(12, 0, 0, 0); Grid.SetColumn(status, 1); grid.Children.Add(status);
                var content = new StackPanel { Children = { grid } }; if (onePassword && feature.ApplyFailed) content.Children.Add(Text(feature.ErrorMessage, 12, Red, null, new Thickness(0, 5, 0, 0)));
                var row = FillRow(content, () => _ = OpenFeatureAsync(feature)); AutomationProperties.SetName(row, feature.Title); card.Children.Add(row);
            }
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
        catch (Exception error) { card.Children.Remove(line); card.Children.Add(Text(error.Message, 13, Red, null, new Thickness(0, 10, 0, 0))); }
    }

    // The existing FeatureEditor, hosted in the pane. Secrets are cleared when the app window loses focus and when the editor closes.
    private async Task OpenFeatureAsync(FeatureSetting feature)
    {
        if (feature.Id == OnePasswordItem.Id) { await OpenOnePasswordAsync(feature); return; }
        var editor = new FeatureEditor(workspace, feature.Id, feature.Title); embedded = editor;
        var content = editor.AsPage(Reopen, keepActions: true);
        ShowSubPage(feature.Title, content, Reopen);
        if (TopLevel.GetTopLevel(pane) is Window host) { EventHandler clear = (_, _) => editor.ClearSecrets(); host.Deactivated += clear; editor.PageClosed += () => host.Deactivated -= clear; }
        await editor.InitializeAsync();
    }

    // The 1Password連携 page (Mac OnePasswordSettingEditor). The token is cleared when the page goes away (lifetime) and when the app window loses focus.
    private OnePasswordView? onePassword;
    private async Task OpenOnePasswordAsync(FeatureSetting feature)
    {
        var token = lifetime?.Token ?? Token;
        var form = NewPage(null, scroll: false); ShowSubPage(feature.Title, new ScrollViewer { Content = form, VerticalScrollBarVisibility = ScrollBarVisibility.Auto }, Reopen);
        var view = onePassword = new OnePasswordView(workspace, feature, form, token, busy => Busy = busy);
        if (TopLevel.GetTopLevel(pane) is Window host) { EventHandler clear = (_, _) => view.ClearToken(); host.Deactivated += clear; token.Register(() => host.Deactivated -= clear); }
        await view.Ready;
    }
    // Render seam: opens the page of the mock's onePassword item in a named state ("checking" and "success" need a PATCH the mock never serves).
    internal async Task OpenOnePasswordForRender(string scene)
    {
        await SelectAsync(SettingsPage.Features);
        var feature = (await workspace.Planning.FeaturesAsync(Token)).Single(item => item.Id == OnePasswordItem.Id);
        await OpenOnePasswordAsync(feature); onePassword!.ShowForRender(scene);
    }

    // ---- 通知 ----
    private Task NotificationsPage()
    {
        var page = NewPage(SettingsPage.Notifications);
        var group = new GroupCard();
        if (notifications is null) { group.Add(Row(LabeledRow("状態", "この画面では通知を設定できません。"))); page.Children.Add(FormSection("この端末", group)); return Task.CompletedTask; }
        var status = LabeledRow("状態", notifications.Status, notifications.Error is null ? Secondary : Red); group.Add(Row(status));
        var toggle = Switch("#34C759"); toggle.IsChecked = notifications.Enabled; AutomationProperties.SetName(toggle, "この端末で通知を受け取る");
        var line = new Grid { ColumnDefinitions = new ColumnDefinitions("*,Auto") }; line.Children.Add(Text("この端末で通知を受け取る", 13, Violet, null)); Grid.SetColumn(toggle, 1); line.Children.Add(toggle);
        group.Add(Row(line));
        toggle.Click += async (_, _) =>
        {
            var next = toggle.IsChecked; toggle.IsEnabled = false;
            await notifications.SetEnabledAsync(next);
            toggle.IsChecked = notifications.Enabled; toggle.IsEnabled = true;
            var text = (TextBlock)status.Children[1]; text.Text = notifications.Status; text.Foreground = notifications.Error is null ? Secondary : Red;
        };
        page.Children.Add(FormSection("この端末", group));
        return Task.CompletedTask;
    }

    // ---- 接続 ----
    private Task ConnectionPage()
    {
        var page = NewPage(SettingsPage.Connection);
        var host = new Uri(workspace.Server).Host; var cloudflare = workspace.AuthMode == "cloudflare";
        page.Children.Add(FormSection("いまの接続", new GroupCard(Row(LabeledRow("サーバー", host.Length == 0 ? "未設定" : host)), Row(LabeledRow("ログイン方法", cloudflare ? "Cloudflare Access" : "同じネットワークから直接")))));
        page.Children.Add(FormSection(null, new GroupCard(Row(IconButtonRow(SettingsIcons.Refresh, "別のサーバーにつなぎ直す", Violet, changeServer))), "接続先を選び直す画面に戻ります。サーバーにある会話や設定は消えません。"));
        if (cloudflare) page.Children.Add(FormSection(null, new GroupCard(Row(IconButtonRow(SettingsIcons.SignOut, "ログアウト", Red, signOut)))));
        return Task.CompletedTask;
    }

    // ---- 表示 ----
    private Task DisplayPage()
    {
        var page = NewPage(SettingsPage.Display);
        var store = new SettingsStore(SettingsStore.UserDirectory); var notice = new StackPanel();
        ConversationOpening current;
        try { current = store.Load().ConversationOpening; }
        catch (Exception error) { current = ConversationOpening.Rise; notice.Children.Add(Banner("このPCの設定を読み取れませんでした。" + error.Message)); }
        var group = new GroupCard(Row(Text("会話の開き方", 13)));
        var checks = new Dictionary<ConversationOpening, Control>();
        foreach (var (option, label) in new[] { (ConversationOpening.Rise, "下から順に浮き上がる"), (ConversationOpening.Fade, "フェードインだけ") })
        {
            var line = new Grid { Background = Brushes.Transparent, Cursor = Hand, ColumnDefinitions = new ColumnDefinitions("*,Auto") };
            line.Children.Add(Text(label, 13)); var check = Glyph(Icons.Check, 16, Violet); check.Opacity = option == current ? 1 : 0; Grid.SetColumn(check, 1); line.Children.Add(check); checks[option] = check;
            AutomationProperties.SetName(line, label);
            line.PointerReleased += (_, args) =>
            {
                if (args.InitialPressMouseButton != MouseButton.Left) return;
                notice.Children.Clear();
                try { store.Save(store.Load() with { ConversationOpening = option }); DisplayPreference.Current = option; foreach (var (key, mark) in checks) mark.Opacity = key == option ? 1 : 0; }
                catch (Exception error) { notice.Children.Add(Banner("この設定を保存できませんでした。" + error.Message)); }
            };
            group.Add(Row(line));
        }
        page.Children.Add(FormSection("会話の開き方", group, "会話を開き直すと反映します。")); page.Children.Add(notice);
        return Task.CompletedTask;
    }

    // ---- 利用と課金 ----
    private Task BillingPage()
    {
        var page = NewPage(SettingsPage.Billing);
        var card = new StackPanel(); card.Children.Add(CardTitle(SettingsIcons.Card, "BellTeamの利用", 17));
        card.Children.Add(Text("Web版とWindows版は無料です。サーバーとAIは、ご自身の契約で利用します。", 14, Muted, null, new Thickness(0, 14, 0, 6)));
        var notice = new StackPanel();
        card.Children.Add(OpenLink("プライバシー方針", PrivacyPolicyUrl, message => { notice.Children.Clear(); notice.Children.Add(Banner(message)); }));
        card.Children.Add(OpenLink("サポート", SupportUrl, message => { notice.Children.Clear(); notice.Children.Add(Banner(message)); }));
        card.Children.Add(notice);
        var holder = Card(card); holder.Margin = new Thickness(0, 16, 0, 0); page.Children.Add(holder);
        return Task.CompletedTask;
    }

    // ---- アップデート ----
    // Placeholder: the アップデート port replaces this call in SelectAsync with the hosted UpdateContent.
    private Task UpdatePagePlaceholder()
    {
        var page = NewPage(SettingsPage.Update);
        page.Children.Add(FormSection(null, new GroupCard(Row(Text("アップデートはLinux版ではまだ使えません。", 13, Secondary)))));
        return Task.CompletedTask;
    }

    // ---- このアプリについて ----
    private Task AboutPage()
    {
        var page = NewPage(SettingsPage.About);
        var host = new Uri(workspace.Server).Host;
        page.Children.Add(FormSection(null, new GroupCard(Row(LabeledRow("アプリの版", typeof(MainWindow).Assembly.GetName().Version?.ToString(3) ?? "-")), Row(LabeledRow("接続先", host.Length == 0 ? "未設定" : host)))));
        return Task.CompletedTask;
    }

    // ---- 全体停止 ----
    private async Task StopPageAsync(CancellationToken token)
    {
        var page = NewPage(SettingsPage.Stop); var area = new StackPanel(); page.Children.Add(area);
        var api = workspace.Planning; var current = control; var loading = true; var updating = false; string? readError = null, actionNote = null;
        void Render()
        {
            area.Children.Clear(); var group = new GroupCard();
            if (current is { } now)
            {
                var toggle = Switch("#FF3B30"); toggle.IsChecked = now.Paused; toggle.IsEnabled = !updating; AutomationProperties.SetName(toggle, "全員のAIを止める");
                var title = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center, Spacing = 8 };
                var mark = new Grid { Width = 16, Height = 16 }; mark.Children.Add(new Avalonia.Controls.Shapes.Ellipse { Fill = Red }); mark.Children.Add(new Border { Width = 6, Height = 6, CornerRadius = new CornerRadius(1), Background = Brushes.White });
                title.Children.Add(mark); title.Children.Add(Text("全員のAIを止める", 13, Red, FontWeight.SemiBold)); ((TextBlock)title.Children[1]).VerticalAlignment = VerticalAlignment.Center;
                var line = new Grid { ColumnDefinitions = new ColumnDefinitions("*,Auto") }; line.Children.Add(title); Grid.SetColumn(toggle, 1); line.Children.Add(toggle);
                toggle.Click += async (_, _) => await SetAsync(toggle.IsChecked);
                group.Add(Row(line)); group.Add(Row(Text(now.StatusText, 14, now.Alert ? Red : Secondary)));
                if (now.UnconfirmedText is { } members) group.Add(Row(Text(members, 14, Red)));
                if (now.CanRefresh) { var refresh = Capsule("状態を更新", Brushes.Transparent, Violet, 8, 13, new Thickness(0, 4)); refresh.HorizontalAlignment = HorizontalAlignment.Left; refresh.IsEnabled = !loading && !updating; refresh.Click += async (_, _) => await ReadAsync(); group.Add(Row(refresh)); }
            }
            else if (!loading)
            {
                var failure = new StackPanel(); failure.Children.Add(Banner("全体停止の状態を読み込めませんでした。接続を確かめて、再確認してください。"));
                if (readError is not null) failure.Children.Add(Text(readError, 12, Secondary, null, new Thickness(0, 4, 0, 0)));
                group.Add(Row(failure));
                var again = Capsule("状態を再確認", Brushes.Transparent, Violet, 8, 13, new Thickness(0, 4)); again.HorizontalAlignment = HorizontalAlignment.Left; again.Click += async (_, _) => await ReadAsync(); group.Add(Row(again));
            }
            if (loading || updating) group.Add(Row(Text("読み込んでいます…", 13, Secondary)));
            if (actionNote is not null) { var failure = new StackPanel(); failure.Children.Add(Banner("操作できませんでした。少し待ってから、もう一度試してください。")); failure.Children.Add(Text(actionNote, 12, Secondary, null, new Thickness(0, 4, 0, 0))); group.Add(Row(failure)); }
            if (current is not null && readError is not null) group.Add(Row(Banner("状態を更新できませんでした。" + readError)));
            area.Children.Add(FormSection(null, group, "ONにすると全メンバーへ停止の指示を送り、新しい依頼を受け付けなくなります。会話を読むことはできます。"));
        }
        async Task ReadAsync()
        {
            loading = true; readError = null; Render();
            try { current = (await api.AiControlAsync(token)).Control; token.ThrowIfCancellationRequested(); ShowControl(current); }
            catch (OperationCanceledException) when (token.IsCancellationRequested) { return; }
            catch (Exception error) { readError = error.Message; }
            loading = false; Render();
        }
        async Task SetAsync(bool paused)
        {
            if (updating || current is null || current.Paused == paused) { Render(); return; }
            updating = true; actionNote = null; Render();
            try { current = (await api.SetAiControlAsync(paused, token)).Control; ShowControl(current); }
            catch (OperationCanceledException) when (token.IsCancellationRequested) { return; }
            catch (Exception error)
            {
                // The PATCH is not resent; only the current value is read again.
                try { current = (await api.AiControlAsync(token)).Control; ShowControl(current); actionNote = AiControl.FailureNote((int?)(error as BellApiException)?.Status, current.State); }
                catch (OperationCanceledException) when (token.IsCancellationRequested) { return; }
                catch (Exception) { actionNote = error.Message; }
            }
            updating = false; Render();
        }
        if (current is not null) { loading = false; Render(); }
        await ReadAsync();
    }
}
