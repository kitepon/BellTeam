using System.Diagnostics;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using BellTeam.Core;
using static BellTeam.App.SettingsUi;

namespace BellTeam.App;

// Page bodies of the Mac settings. Each loader catches its own failures and shows them with the reason; nothing is retried.
public sealed partial class SettingsWindow
{
    private const string PrivacyPolicyUrl = "https://bellteam-subscriptions.kitepon.workers.dev/privacy";
    private const string SupportUrl = "https://bellteam-subscriptions.kitepon.workers.dev/support";

    private static StackPanel CardTitle(string glyph, string title, double size = 13)
    {
        var line = new StackPanel { Orientation = Orientation.Horizontal };
        line.Children.Add(Glyph(glyph, size, Ink)); line.Children.Add(Text(title, size, Ink, FontWeights.SemiBold, new Thickness(8, 0, 0, 0)));
        return line;
    }
    private static Border FillRow(UIElement content, Action? click)
    {
        var row = new Border { Child = content, Background = Fill, CornerRadius = new CornerRadius(8), Padding = new Thickness(12, 10, 12, 10), Margin = new Thickness(0, 8, 0, 0), Cursor = click is null ? null : System.Windows.Input.Cursors.Hand };
        if (click is not null) row.MouseLeftButtonUp += (_, _) => click();
        return row;
    }
    private static Button OpenLink(string label, string url, Action<string> failed)
    {
        var button = Capsule(label, Fill, Ink, 8, 13, new Thickness(12, 6, 12, 6)); button.HorizontalAlignment = HorizontalAlignment.Left; button.Margin = new Thickness(0, 8, 0, 0); button.FontWeight = FontWeights.Normal;
        button.Click += (_, _) => { try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); } catch (Exception error) { failed("ページを開けませんでした。" + error.Message); } };
        return button;
    }
    private static TextBlock Loading(string text) => Text(text, 13, Secondary, null, new Thickness(0, 10, 0, 0));

    // ---- プロフィール ----
    // Saves the Owner only; the team rules are their own item (settings-user-flow B13).
    private async Task ProfilePageAsync(CancellationToken token)
    {
        var page = NewPage(SettingsPage.Profile);
        var content = new StackPanel(); page.Children.Add(content); content.Children.Add(Loading("読み込んでいます…"));
        try
        {
            var api = workspace.Planning;
            var original = (await api.OwnerAsync(token)).Owner; token.ThrowIfCancellationRequested();
            UpdateProfileRow(original); content.Children.Clear();
            var avatar = new AvatarPicker(original.Avatar, name: original.Name, quiet: true) { HorizontalAlignment = HorizontalAlignment.Center }; InitialLoads.Add(avatar.LoadAsync());
            var name = Field("名前", original.Name); var profile = Field("プロフィール", original.Profile, multiline: true);
            content.Children.Add(FormSection("あなた", new GroupCard(Row(avatar, 0), Row(name.Element), Row(profile.Element))));
            var x = Field("XのURL", original.XUrl); var github = Field("GitHubのURL", original.GithubUrl);
            var group = new GroupCard(Row(x.Element), Row(github.Element));
            var links = new List<(TextBox Label, TextBox Url)>();
            group.Add(Row(IconButtonRow("\uE710", "リンクを追加", Violet, () => AddLink(new("", "")))));
            void AddLink(OwnerLink value)
            {
                var label = Field("名前", value.Label); var url = Field("URL", value.Url);
                var fields = new StackPanel(); fields.Children.Add(label.Element); fields.Children.Add(new Border { Height = 1, Background = Hairline, Margin = new Thickness(0, 8, 0, 8) }); fields.Children.Add(url.Element);
                var line = new Grid(); line.ColumnDefinitions.Add(new ColumnDefinition()); line.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto }); line.Children.Add(fields);
                var delete = Capsule("\uE74D", Brushes.Transparent, Red, 8, 14, new Thickness(8, 4, 8, 4)); delete.FontFamily = Icons; delete.Margin = new Thickness(8, 0, 0, 0); delete.VerticalAlignment = VerticalAlignment.Center; System.Windows.Automation.AutomationProperties.SetName(delete, "リンクを削除");
                Grid.SetColumn(delete, 1); line.Children.Add(delete);
                var holder = Row(line); links.Add((label.Box, url.Box));
                delete.Click += (_, _) => { links.Remove((label.Box, url.Box)); group.Remove(holder); };
                group.Insert(group.Count - 1, holder);
            }
            foreach (var link in original.Links) AddLink(link);
            content.Children.Add(FormSection("リンク", group));
            var save = MainButton("保存"); content.Children.Add(save);
            var notice = new StackPanel(); content.Children.Add(notice);
            save.Click += async (_, _) =>
            {
                if (Busy) return;
                notice.Children.Clear();
                if (string.IsNullOrWhiteSpace(name.Box.Text)) { notice.Children.Add(Banner("名前を入力してください。")); return; }
                Busy = true; save.IsEnabled = false; save.Content = "保存しています…";
                try
                {
                    var edited = original with { Name = name.Box.Text, Profile = profile.Box.Text, Avatar = avatar.Value, XUrl = x.Box.Text, GithubUrl = github.Box.Text, Links = links.Select(link => new OwnerLink(link.Label.Text, link.Url.Text)).ToArray() };
                    var changes = edited.ChangesFrom(original);
                    if (changes.Count != 0) { await api.SaveOwnerAsync(changes, Token); original = edited; UpdateProfileRow(edited); }
                    var saved = Text("", 14, Green, null, new Thickness(0, 10, 0, 0)); saved.Inlines.Add(new System.Windows.Documents.Run("\uE73E ") { FontFamily = Icons }); saved.Inlines.Add("保存しました"); notice.Children.Add(saved);
                }
                catch (OperationCanceledException) when (Token.IsCancellationRequested) { }
                catch (Exception error) { notice.Children.Add(Banner("プロフィールを保存できませんでした。入力は残っています。\n" + ErrorText(error))); }
                finally { Busy = false; save.IsEnabled = true; save.Content = "保存"; }
            };
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
        catch (Exception error) { content.Children.Clear(); content.Children.Add(Banner(error.Message)); }
    }

    // ---- チームの決まり ----
    // One card per rule (headline = PURPOSE or the first clause, the id never shown), and 編集する opens the full text (Mac UserRulesView).
    private async Task RulesPageAsync(CancellationToken token)
    {
        var page = NewPage(SettingsPage.Rules);
        var edit = MainButton("編集する"); edit.IsEnabled = false; page.Children.Add(edit);
        var content = new StackPanel(); page.Children.Add(content); content.Children.Add(Loading("読み込んでいます…"));
        try
        {
            var text = (await workspace.Planning.RulesAsync(token)).Text; token.ThrowIfCancellationRequested();
            // The head was drawn before the read; redraw it with the count just read.
            RulesSaved(text);
            content.Children.Clear();
            var document = UserRulesDocument.Parse(text);
            if (document.IsEmpty) content.Children.Add(Text("まだ決まりがありません。「編集する」から書き足せます。", 14, Secondary, null, new Thickness(0, 14, 0, 0)));
            foreach (var section in document.Sections)
                foreach (var rule in section.Rules)
                {
                    var card = new StackPanel();
                    if (rule.Headline is { } headline) card.Children.Add(Text(headline.Text, 14, Ink, FontWeights.SemiBold));
                    foreach (var clause in rule.Details)
                    {
                        var line = new Grid { Margin = new Thickness(0, 8, 0, 0) }; line.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto }); line.ColumnDefinitions.Add(new ColumnDefinition());
                        var kind = SettingsUi.Badge(clause.Label, clause.Keyword is "NEVER" ? SettingsTone.Orange : clause.Keyword is "FACT" or "WHY" or "PURPOSE" ? SettingsTone.Violet : SettingsTone.Gray); kind.VerticalAlignment = VerticalAlignment.Top; kind.Margin = new Thickness(0, 0, 10, 0);
                        var body = Text(clause.Text, 14, Ink); Grid.SetColumn(body, 1);
                        line.Children.Add(kind); line.Children.Add(body); card.Children.Add(line);
                    }
                    var holder = Card(card); holder.Margin = new Thickness(0, 14, 0, 0); content.Children.Add(holder);
                }
            if (document.PlainLines.Count != 0) { var plain = Card(Text(string.Join("\n", document.PlainLines), 13, Ink)); plain.Margin = new Thickness(0, 14, 0, 0); content.Children.Add(plain); }
            edit.IsEnabled = true; edit.Click += (_, _) => OpenRulesEditor(text);
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
        catch (Exception error)
        {
            if (rulesText is null) { rulesUnreadable = true; RefreshRows(); }
            content.Children.Clear(); content.Children.Add(Banner("決まりを読み込めませんでした。" + error.Message));
            var again = Capsule("読み直す", Fill, Ink, 8, 13, new Thickness(12, 6, 12, 6)); again.HorizontalAlignment = HorizontalAlignment.Left; again.Margin = new Thickness(0, 10, 0, 0); again.FontWeight = FontWeights.Normal;
            again.Click += (_, _) => Reopen(); content.Children.Add(again);
        }
    }

    // The full text, as written; while the PUT is out the text box is locked so nothing typed after pressing is lost (settings-user-flow 5.1).
    private void OpenRulesEditor(string original)
    {
        var form = NewPage(null, scroll: false);
        var head = new Grid(); head.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto }); head.ColumnDefinitions.Add(new ColumnDefinition());
        head.Children.Add(Tile(SettingsPage.Rules, 36));
        var words = new StackPanel { Margin = new Thickness(12, 0, 0, 0), VerticalAlignment = VerticalAlignment.Center }; words.Children.Add(Text("チームの決まり", 16, Ink, FontWeights.SemiBold)); words.Children.Add(Text("全文を書き換えます。チーム全員が、あなたについて守る指示です。", 13, Secondary, null, new Thickness(0, 2, 0, 0)));
        Grid.SetColumn(words, 1); head.Children.Add(words); form.Children.Add(head);
        var box = Field("決まりの全文", original, multiline: true, minHeight: 360);
        form.Children.Add(FormSection("決まりの全文", new GroupCard(Row(box.Element))));
        var save = MainButton("保存"); form.Children.Add(save);
        var notice = new StackPanel(); form.Children.Add(notice);
        save.Click += async (_, _) =>
        {
            if (Busy) return;
            notice.Children.Clear(); Busy = true; save.IsEnabled = false; save.Content = "保存しています…"; box.Box.IsReadOnly = true;
            try { RulesSaved((await workspace.Planning.SaveRulesAsync(box.Box.Text, Token)).Text); Busy = false; Reopen(); return; }
            catch (OperationCanceledException) when (Token.IsCancellationRequested) { return; }
            catch (Exception error) { notice.Children.Add(Banner("決まりを保存できませんでした。入力は残っています。プロフィールには影響しません。\n" + ErrorText(error))); }
            Busy = false; save.IsEnabled = true; save.Content = "保存"; box.Box.IsReadOnly = false;
        };
        ShowSubPage("チームの決まり", new ScrollViewer { Content = form, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled }, Reopen);
    }

    // ---- AIの認証 ----
    // One card of AI rows (Mac AIの認証 list). Each row: name, who runs on it, an optional limit line, the stage badge and a chevron;
    // a filled button only where the Owner has something to do (ログインが必要・失敗・途中, settings-user-flow B18). The row opens the login window.
    private async Task AiPageAsync(CancellationToken token)
    {
        var page = NewPage(SettingsPage.Ai);
        var list = new StackPanel(); var card = Card(list); card.Margin = new Thickness(0, 6, 0, 0); page.Children.Add(card);
        await LoadHarnessesAsync(list, token);
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
                var (row, ready) = AuthRow(harness.Name, [(harness.UsageText, Muted)], harness, api, null, false, null, token); list.Children.Add(row); states.Add(ready);
            }
            await Task.WhenAll(states);
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
        catch (Exception error)
        {
            list.Children.Clear(); list.Children.Add(Text("AIの種類を確認できませんでした。\n" + error.Message, 13, Red, null, new Thickness(0, 10, 0, 0)));
            var retry = Capsule("一覧を更新", Fill, Ink, 8, 13, new Thickness(12, 6, 12, 6)); retry.HorizontalAlignment = HorizontalAlignment.Left; retry.Margin = new Thickness(0, 10, 0, 0); retry.FontWeight = FontWeights.Normal;
            retry.Click += (_, _) => _ = LoadHarnessesAsync(list, token); list.Children.Add(retry);
        }
    }

    // One AI-authentication row: names and lines | badge | (button) | chevron. slot is the Claude account slot the row reads ("2nd"; the first reads without a slot) and starts.
    // afterDialog replaces the row's own state re-read when the login window closes.
    private (Grid Row, Task Ready) AuthRow(string name, IReadOnlyList<(string Text, Brush Color)> lines, HarnessAuthenticationOption harness, HarnessAuthenticationApi api, string? slot, bool signedOut, Func<Task>? afterDialog, CancellationToken token)
    {
        var row = new Grid { Margin = new Thickness(0, 6, 0, 6), Background = Brushes.Transparent, Cursor = System.Windows.Input.Cursors.Hand };
        foreach (var width in new[] { new GridLength(1, GridUnitType.Star), GridLength.Auto, GridLength.Auto, GridLength.Auto }) row.ColumnDefinitions.Add(new ColumnDefinition { Width = width });
        var names = new StackPanel { VerticalAlignment = VerticalAlignment.Center }; names.Children.Add(Text(name, 14, Ink, FontWeights.SemiBold));
        foreach (var (value, color) in lines) names.Children.Add(Text(value, 12, color, null, new Thickness(0, 2, 0, 0)));
        var badge = new ContentControl { VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(10, 0, 0, 0), Focusable = false }; Grid.SetColumn(badge, 1);
        var action = Capsule("", Violet, Brushes.White); action.VerticalAlignment = VerticalAlignment.Center; action.Margin = new Thickness(10, 0, 0, 0); Grid.SetColumn(action, 2);
        var chevron = Glyph("\uE76C", 12, Secondary); chevron.Margin = new Thickness(10, 0, 0, 0); Grid.SetColumn(chevron, 3);
        row.Children.Add(names); row.Children.Add(badge); row.Children.Add(action); row.Children.Add(chevron);
        System.Windows.Automation.AutomationProperties.SetName(row, name); System.Windows.Automation.AutomationProperties.SetName(action, name);
        void Show(AuthenticationProgress value)
        {
            badge.Content = SettingsUi.Badge(value.Badge, value.Tone);
            action.Content = value.Action; action.Visibility = value.Action is null ? Visibility.Collapsed : Visibility.Visible;
        }
        async Task ReadStateAsync()
        {
            Show(AuthenticationProgress.Checking);
            try { Show(AuthenticationProgress.From((await api.StatusAsync(harness.Id, token, slot)).Auth, loaded: true, signedOut: signedOut)); }
            catch (OperationCanceledException) when (token.IsCancellationRequested) { }
            catch (Exception) { Show(AuthenticationProgress.Unknown); }
        }
        async Task OpenAsync()
        {
            var dialog = new HarnessAuthenticationWindow(workspace, harness, slot: slot) { Owner = DialogOwner }; _ = dialog.InitializeAsync(); dialog.ShowDialog();
            await (afterDialog?.Invoke() ?? ReadStateAsync()); _ = ReloadHomeAsync();
        }
        action.Click += async (_, args) => { args.Handled = true; await OpenAsync(); };
        row.MouseLeftButtonUp += async (_, _) => await OpenAsync();
        return (row, ReadStateAsync());
    }

    // Claude: the two account slots when the server lists accounts, the old single row when GET /api/accounts answers 404 (older server),
    // and for any other read failure the reason with 一覧を更新 (never the old row, which would hide that the slots exist).
    private async Task LoadClaudeAsync(StackPanel host, HarnessAuthenticationOption harness, HarnessAuthenticationApi auth, CancellationToken token)
    {
        host.Children.Clear();
        var accounts = new HarnessAccountsApi(workspace.Management.Api);
        Task Reload() => LoadClaudeAsync(host, harness, auth, token);
        Button Retry()
        {
            var retry = Capsule("一覧を更新", Fill, Ink, 8, 13, new Thickness(12, 6, 12, 6)); retry.HorizontalAlignment = HorizontalAlignment.Left; retry.Margin = new Thickness(0, 10, 0, 0); retry.FontWeight = FontWeights.Normal;
            retry.Click += (_, _) => _ = Reload(); return retry;
        }
        void Failed(string message) { host.Children.Clear(); host.Children.Add(Text("Claudeのアカウントを確認できませんでした。\n" + message, 13, Red, null, new Thickness(0, 10, 0, 0))); host.Children.Add(Retry()); }
        AccountsResponse? list;
        try { list = await accounts.ReadAsync(token); token.ThrowIfCancellationRequested(); }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { return; }
        catch (Exception error) { Failed(error.Message); return; }
        if (list is null)
        {
            var (single, oldReady) = AuthRow(harness.Name, [(harness.UsageText, Muted)], harness, auth, null, false, null, token); host.Children.Add(single); await oldReady; return;
        }
        if (list.Claude is not { } claude) { Failed("アカウントの一覧にClaudeの項目がありません。"); return; }
        var now = DateTimeOffset.Now;
        // Mac ClaudeAccountsCard: the harness name with its member count on the right, the both-limited lines, then the slots as rows.
        var heading = new Grid { Margin = new Thickness(0, 6, 0, 0) }; heading.ColumnDefinitions.Add(new ColumnDefinition()); heading.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var usage = Text(harness.UsageText, 12, Muted); usage.VerticalAlignment = VerticalAlignment.Center; Grid.SetColumn(usage, 1);
        heading.Children.Add(Text(harness.Name, 14, Ink)); heading.Children.Add(usage); host.Children.Add(heading);
        foreach (var text in AccountText.CardBannerTexts(list, now))
        {
            var bar = Text("\u26A0 " + text, 12, Orange, null, new Thickness(0, 6, 0, 0)); System.Windows.Automation.AutomationProperties.SetName(bar, text); host.Children.Add(bar);
        }
        var seats = workspace.Bots.Select(bot => bot.Account).ToList();
        var ready = new List<Task>();
        foreach (var slot in claude.Slots)
        {
            if (slot.Slot is not ("1st" or "2nd")) continue;
            var lines = new List<(string Text, Brush Color)>();
            // #1117: the count of members running on this slot now, so 1つ目 + 2つ目 = the header; an older body without bot accounts says how many seats used it.
            lines.Add((AccountText.SlotUsers(seats, "claude", slot.Slot) is { } count ? AccountText.SlotUsersLine(count) : AccountText.SeatsCount(slot), Muted));
            if (AccountText.LimitLine(claude, slot, now) is { } limit) lines.Add((limit, Orange));
            // The contract asks that the Owner sees a slot whose history could not be shared (harness-accounts `history: separate`); the Mac has no line for it yet.
            if (slot.History == "separate") lines.Add(("会話の履歴は1つ目のアカウントと分かれています", Muted));
            var (row, state) = AuthRow(AccountText.SlotName(slot.Slot), lines, harness, auth, slot.Slot == "1st" ? null : slot.Slot, slot.SignedOutAt is not null, Reload, token);
            host.Children.Add(row); ready.Add(state);
        }
        await Task.WhenAll(ready);
    }

    // ---- 仕事の要約を書くAI ----
    // The summary-AI editor (Mac BackgroundAgentEditor): CLI, model and effort pickers drawn only from the model catalog.
    private async Task SummaryPageAsync(CancellationToken token)
    {
        var page = NewPage(SettingsPage.Summary); var form = new StackPanel(); page.Children.Add(form);
        var record = backgroundAgent ?? new BackgroundAgentRecord(null, null); var catalog = new Dictionary<string, HarnessModels>();
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
            var effortOptions = new List<FormOption> { new("", efforts.Length == 0 ? "CLIの既定（エフォート指定なし）" : "選んでください") }; effortOptions.AddRange(efforts.Select(item => new FormOption(item, EffortText.Label(item))));
            if (effort.Length != 0 && effortOptions.All(item => item.Id != effort)) effortOptions.Add(new(effort, $"{effort}（現在の候補にありません）"));
            var effortPicker = Picker("エフォート", effortOptions.ToArray(), effort, value => { effort = value; Render(); });
            form.Children.Add(FormSection(null, new GroupCard(cli, modelPicker, effortPicker), "保存しても、要約がすぐ作られるとは限りません。要約の状態はメンバー一覧で確かめてください。"));
            if (problem is not null) form.Children.Add(Text(problem, 13, Red, null, new Thickness(20, 10, 20, 0)));
            if (record.Selection is { } stored && stored != draft) form.Children.Add(Text("保存されている設定：" + BackgroundAgentRecord.Describe(stored), 13, Muted, null, new Thickness(20, 10, 20, 0)));
            var save = MainButton(saving ? "保存しています…" : "保存"); save.IsEnabled = !saving && problem is null;
            save.Click += async (_, _) => await SaveAsync(draft); form.Children.Add(save);
            if (savedText is not null) form.Children.Add(Text(savedText, 13, Muted, null, new Thickness(20, 10, 20, 0)));
            if (errorText is not null)
            {
                form.Children.Add(Text(errorText, 13, Red, null, new Thickness(20, 12, 20, 0)));
                var reload = Capsule("再読み込み", Fill, Ink, 8, 13, new Thickness(12, 6, 12, 6)); reload.HorizontalAlignment = HorizontalAlignment.Left; reload.Margin = new Thickness(20, 8, 0, 0); reload.FontWeight = FontWeights.Normal; reload.IsEnabled = !loading;
                reload.Click += async (_, _) => await LoadAsync(); form.Children.Add(reload);
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
            try { record = await workspace.Planning.SaveBackgroundAgentAsync(record, draft, Token); savedText = "保存しました。"; backgroundAgent = record; RefreshRows(); }
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
        var grid = new Grid { VerticalAlignment = VerticalAlignment.Center };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(110) }); grid.ColumnDefinitions.Add(new ColumnDefinition());
        var caption = Text(label, 13); caption.VerticalAlignment = VerticalAlignment.Center; grid.Children.Add(caption);
        var combo = new ComboBox { ItemsSource = options, DisplayMemberPath = nameof(FormOption.Label), SelectedValuePath = nameof(FormOption.Id), SelectedValue = selected, FontSize = 13, Padding = new Thickness(10, 5, 10, 5), HorizontalAlignment = HorizontalAlignment.Right, MinWidth = 220, MaxWidth = 360 };
        System.Windows.Automation.AutomationProperties.SetName(combo, label);
        combo.SelectionChanged += (_, _) => { if (combo.SelectedValue is string value && value != selected) changed(value); };
        Grid.SetColumn(combo, 1); grid.Children.Add(combo);
        return Row(grid);
    }

    // ---- 追加機能 ----
    // Every feature but 1Password (its own item, B8): name, one line, the state badge and a chevron.
    private async Task FeaturesPageAsync(CancellationToken token)
    {
        var page = NewPage(SettingsPage.Features);
        var card = new StackPanel(); card.Children.Add(Text("未設定の機能は無効です。案内役との会話でも設定できます。", 14, Muted));
        var holder = Card(card); holder.Margin = new Thickness(0, 6, 0, 0); page.Children.Add(holder);
        var line = Loading("読み込んでいます…"); card.Children.Add(line);
        try
        {
            var list = await workspace.Planning.FeaturesAsync(token); token.ThrowIfCancellationRequested(); card.Children.Remove(line);
            features = list; RefreshRows();
            foreach (var feature in list.Where(item => item.Id != OnePasswordItem.Id))
            {
                var grid = new Grid(); grid.ColumnDefinitions.Add(new ColumnDefinition()); grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto }); grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
                var names = new StackPanel { VerticalAlignment = VerticalAlignment.Center }; names.Children.Add(Text(feature.Title, 14, Ink));
                if (feature.ApplyFailed) names.Children.Add(Text(feature.ErrorMessage, 12, Red, null, new Thickness(0, 3, 0, 0)));
                grid.Children.Add(names);
                var (badgeText, tone) = feature.ApplyFailed ? ("失敗", SettingsTone.Orange) : feature.Status == "enabled" ? ("使用中", SettingsTone.Green) : feature.Status == "disabled" ? ("オフ", SettingsTone.Gray) : ("未設定", SettingsTone.Gray);
                var badge = SettingsUi.Badge(badgeText, tone); badge.Margin = new Thickness(10, 0, 0, 0); Grid.SetColumn(badge, 1); grid.Children.Add(badge);
                var chevron = Glyph("\uE76C", 12, Secondary); chevron.Margin = new Thickness(10, 0, 0, 0); Grid.SetColumn(chevron, 2); grid.Children.Add(chevron);
                var row = FillRow(grid, () => _ = OpenFeatureAsync(feature)); System.Windows.Automation.AutomationProperties.SetName(row, feature.Title); card.Children.Add(row);
            }
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
        catch (Exception error) { card.Children.Remove(line); card.Children.Add(Text(error.Message, 13, Red, null, new Thickness(0, 10, 0, 0))); }
    }

    // The existing FeatureEditor, hosted in the pane. Secrets are cleared when the app window loses focus and when the editor closes.
    private async Task OpenFeatureAsync(FeatureSetting feature)
    {
        var editor = new FeatureEditor(workspace, feature.Id, feature.Title); embedded = editor;
        var content = editor.AsPage(Reopen, keepActions: true);
        ShowSubPage(feature.Title, content, Reopen);
        if (Window.GetWindow(pane) is { } host) { EventHandler clear = (_, _) => editor.ClearSecrets(); host.Deactivated += clear; editor.Closed += (_, _) => host.Deactivated -= clear; }
        await editor.InitializeAsync();
    }

    // ---- 1Password ----
    // Its own item (B8). The token is cleared when the page goes away (lifetime) and when the app window loses focus.
    private OnePasswordView? onePassword;
    private async Task OnePasswordPageAsync(CancellationToken token)
    {
        var page = NewPage(SettingsPage.OnePassword); var form = new StackPanel(); page.Children.Add(form);
        FeatureSetting? feature;
        try { features = await workspace.Planning.FeaturesAsync(token); feature = features.FirstOrDefault(item => item.Id == OnePasswordItem.Id); token.ThrowIfCancellationRequested(); }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { return; }
        catch (Exception error) { form.Children.Add(Banner("1Passwordの設定を読み込めませんでした。" + error.Message)); return; }
        RefreshRows();
        if (feature is null) { form.Children.Add(Text("このサーバーの版では1Passwordと連携できません。", 14, Secondary, null, new Thickness(0, 10, 0, 0))); return; }
        var view = onePassword = new OnePasswordView(workspace, feature, form, token, busy => Busy = busy);
        EventHandler clear = (_, _) => view.ClearToken(); Deactivated += clear; token.Register(() => Deactivated -= clear);
        await view.Ready;
    }
    // Render seam: opens the 1Password page in a named state ("checking" and "success" need a PATCH the mock never serves).
    internal async Task OpenOnePasswordForRender(string scene)
    {
        await SelectAsync(SettingsPage.OnePassword);
        onePassword!.ShowForRender(scene);
    }

    // ---- 通知 ----
    // Windows has no push registration: this PC gets toasts while the app runs. So two of the Mac's four states apply (B9):
    // 届きます with no button, or 届きません with the one main button 「この端末で受け取る」 (and its failure right under it).
    private Task NotificationsPage()
    {
        var page = NewPage(SettingsPage.Notifications);
        if (notifications is null) { page.Children.Add(Text("この画面では通知を設定できません。", 14, Secondary, null, new Thickness(0, 6, 0, 0))); return Task.CompletedTask; }
        var area = new StackPanel(); page.Children.Add(area);
        void Render()
        {
            RefreshRows(); area.Children.Clear();
            if (notifications.Enabled)
            {
                area.Children.Add(Text("アプリが起きている間、メンバーからの連絡をこのPCの通知で知らせます。", 14, Secondary, null, new Thickness(0, 6, 0, 0)));
                var off = Capsule("この端末で受け取るのをやめる", Brushes.Transparent, Red, 8, 13, new Thickness(0, 4, 0, 4)); off.HorizontalAlignment = HorizontalAlignment.Left; off.Margin = new Thickness(0, 10, 0, 0);
                off.Click += async (_, _) => { off.IsEnabled = false; await notifications.SetEnabledAsync(false); Render(); };
                area.Children.Add(off); return;
            }
            var receive = MainButton("この端末で受け取る");
            receive.Click += async (_, _) => { receive.IsEnabled = false; receive.Content = "登録しています…"; await notifications.SetEnabledAsync(true); Render(); };
            area.Children.Add(receive);
            if (notifications.Error is { } error) area.Children.Add(Banner(error));
        }
        Render();
        return Task.CompletedTask;
    }

    // ---- 接続 ----
    private Task ConnectionPage()
    {
        var page = NewPage(SettingsPage.Connection);
        var host = new Uri(workspace.Server).Host; var cloudflare = workspace.AuthMode == "cloudflare";
        page.Children.Add(FormSection("いまの接続", new GroupCard(Row(LabeledRow("サーバー", host.Length == 0 ? "未設定" : host)), Row(LabeledRow("ログイン方法", cloudflare ? "Cloudflare Access" : "同じネットワークから直接")))));
        // B15: changing the server also stops this PC's notifications, so it asks first.
        Action? change = changeServer is null ? null : () => { if (new ConfirmationWindow("接続", "接続先を変えますか？ この端末の通知も止まります。サーバーの会話や設定は消えません。", "接続先を変える") { Owner = DialogOwner }.ShowDialog() == true) changeServer(); };
        page.Children.Add(FormSection(null, new GroupCard(Row(IconButtonRow("\uE895", "別のサーバーにつなぎ直す", Violet, change))), "接続先を選び直す画面に戻ります。サーバーにある会話や設定は消えません。"));
        if (cloudflare) page.Children.Add(FormSection(null, new GroupCard(Row(IconButtonRow("", "ログアウト", Red, signOut)))));
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
        var checks = new Dictionary<ConversationOpening, TextBlock>();
        foreach (var (option, label) in new[] { (ConversationOpening.Rise, "下から順に浮き上がる"), (ConversationOpening.Fade, "フェードインだけ") })
        {
            var line = new Grid { Background = Brushes.Transparent, Cursor = System.Windows.Input.Cursors.Hand }; line.ColumnDefinitions.Add(new ColumnDefinition()); line.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            line.Children.Add(Text(label, 13)); var check = Glyph("", 14, Violet); check.Visibility = option == current ? Visibility.Visible : Visibility.Hidden; Grid.SetColumn(check, 1); line.Children.Add(check); checks[option] = check;
            System.Windows.Automation.AutomationProperties.SetName(line, label);
            line.MouseLeftButtonUp += (_, _) =>
            {
                notice.Children.Clear();
                try { store.Save(store.Load() with { ConversationOpening = option }); DisplayPreference.Current = option; foreach (var (key, mark) in checks) mark.Visibility = key == option ? Visibility.Visible : Visibility.Hidden; }
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
        var card = new StackPanel(); card.Children.Add(CardTitle("", "BellTeamの利用", 17));
        card.Children.Add(Text("Web版とWindows版は無料です。サーバーとAIは、ご自身の契約で利用します。", 14, Muted, null, new Thickness(0, 14, 0, 6)));
        var notice = new StackPanel();
        card.Children.Add(OpenLink("プライバシー方針", PrivacyPolicyUrl, message => { notice.Children.Clear(); notice.Children.Add(Banner(message)); }));
        card.Children.Add(OpenLink("サポート", SupportUrl, message => { notice.Children.Clear(); notice.Children.Add(Banner(message)); }));
        card.Children.Add(notice);
        var holder = Card(card); holder.Margin = new Thickness(0, 16, 0, 0); page.Children.Add(holder);
        return Task.CompletedTask;
    }

    // ---- アップデート ----
    private Task UpdatePageAsync()
    {
        var content = new UpdateContent(workspace); updateContent = content; pane.Content = content;
        return content.RefreshAsync();
    }

    // ---- このアプリについて ----
    private Task AboutPage()
    {
        var page = NewPage(SettingsPage.About);
        // B16: the server is shown on 接続 only.
        page.Children.Add(FormSection(null, new GroupCard(Row(LabeledRow("アプリの版", VersionText)))));
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
                var toggle = Switch("#FF3B30"); toggle.IsChecked = now.Paused; toggle.IsEnabled = !updating; System.Windows.Automation.AutomationProperties.SetName(toggle, "全員のAIを止める");
                var title = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };
                var mark = new Grid { Width = 16, Height = 16 }; mark.Children.Add(new System.Windows.Shapes.Ellipse { Fill = Red }); mark.Children.Add(new Border { Width = 6, Height = 6, CornerRadius = new CornerRadius(1), Background = Brushes.White });
                title.Children.Add(mark); title.Children.Add(Text("全員のAIを止める", 13, Red, FontWeights.SemiBold, new Thickness(8, 0, 0, 0)));
                var line = new Grid(); line.ColumnDefinitions.Add(new ColumnDefinition()); line.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto }); line.Children.Add(title); Grid.SetColumn(toggle, 1); line.Children.Add(toggle);
                toggle.Click += async (_, _) => await SetAsync(toggle.IsChecked == true);
                group.Add(Row(line)); group.Add(Row(Text(now.StatusText, 14, now.Alert ? Red : Secondary)));
                if (now.UnconfirmedText is { } members) group.Add(Row(Text(members, 14, Red)));
                if (now.CanRefresh) { var refresh = Capsule("状態を更新", Brushes.Transparent, Violet, 8, 13, new Thickness(0, 4, 0, 4)); refresh.HorizontalAlignment = HorizontalAlignment.Left; refresh.IsEnabled = !loading && !updating; refresh.Click += async (_, _) => await ReadAsync(); group.Add(Row(refresh)); }
            }
            else if (!loading)
            {
                var failure = new StackPanel(); failure.Children.Add(Banner("全体停止の状態を読み込めませんでした。接続を確かめて、再確認してください。"));
                if (readError is not null) failure.Children.Add(Text(readError, 12, Secondary, null, new Thickness(0, 4, 0, 0)));
                group.Add(Row(failure));
                var again = Capsule("状態を再確認", Brushes.Transparent, Violet, 8, 13, new Thickness(0, 4, 0, 4)); again.HorizontalAlignment = HorizontalAlignment.Left; again.Click += async (_, _) => await ReadAsync(); group.Add(Row(again));
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
