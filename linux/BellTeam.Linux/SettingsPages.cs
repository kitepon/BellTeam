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
    private const string PrivacyPolicyUrl = "https://kitepon.dev/privacy/";
    private const string SupportUrl = "https://kitepon.dev/support/";

    protected override Window? DialogOwner => OwnerWindow.Of(pane);
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
        var content = new StackPanel(); page.Children.Add(content); content.Children.Add(Loading(LinuxStrings.FeatureEditor_InitializeAsync_1));
        var save = Capsule(LinuxStrings.EditorForm_SaveLabel_1, new SolidColorBrush(Color.FromRgb(0xE9, 0xE9, 0xEE)), Ink, 15, 13, new Thickness(14, 5)); save.IsEnabled = false;
        SetToolbar(null, null, save);
        try
        {
            var api = workspace.Planning;
            var original = (await api.OwnerAsync(token)).Owner; var originalRules = (await api.RulesAsync(token)).Text; token.ThrowIfCancellationRequested();
            UpdateProfileRow(original); content.Children.Clear();
            var avatar = new AvatarPicker(original.Avatar, name: original.Name, quiet: true) { HorizontalAlignment = HorizontalAlignment.Center }; InitialLoads.Add(avatar.LoadAsync());
            var name = Field(LinuxStrings.MemberEditors_Build_1, original.Name); var profile = Field(LinuxStrings.MemberEditors_Build_16, original.Profile, multiline: true);
            content.Children.Add(FormSection(LinuxStrings.SettingsEditors_profileName_1, new GroupCard(Row(avatar, 0), Row(name.Element), Row(profile.Element))));
            var x = Field(LinuxStrings.SettingsPages_ProfilePageAsync_6, original.XUrl); var github = Field(LinuxStrings.SettingsPages_ProfilePageAsync_7, original.GithubUrl);
            var group = new GroupCard(Row(x.Element), Row(github.Element));
            var links = new List<(TextBox Label, TextBox Url)>();
            group.Add(Row(IconButtonRow(Icons.PlusCircle, LinuxStrings.SettingsPages_ProfilePageAsync_8, Violet, () => AddLink(new("", "")))));
            void AddLink(OwnerLink value)
            {
                var label = Field(LinuxStrings.MemberEditors_Build_1, value.Label); var url = Field("URL", value.Url);
                var fields = new StackPanel(); fields.Children.Add(label.Element); fields.Children.Add(new Border { Height = 1, Background = Hairline, Margin = new Thickness(0, 8) }); fields.Children.Add(url.Element);
                var line = new Grid { ColumnDefinitions = new ColumnDefinitions("*,Auto") }; line.Children.Add(fields);
                var delete = Capsule("", Brushes.Transparent, Red, 8, 14, new Thickness(8, 4)); delete.Content = Glyph(SettingsIcons.Trash, 18, Red); delete.Margin = new Thickness(8, 0, 0, 0); delete.VerticalAlignment = VerticalAlignment.Center; AutomationProperties.SetName(delete, LinuxStrings.SettingsPages_ProfilePageAsync_10);
                Grid.SetColumn(delete, 1); line.Children.Add(delete);
                var holder = Row(line); links.Add((label.Box, url.Box));
                delete.Click += (_, _) => { links.Remove((label.Box, url.Box)); group.Remove(holder); };
                group.Insert(group.Count - 1, holder);
            }
            foreach (var link in original.Links) AddLink(link);
            content.Children.Add(FormSection(LinuxStrings.SettingsPages_ProfilePageAsync_11, group));
            var rules = Field(LinuxStrings.SettingsPages_ProfilePageAsync_12, originalRules, multiline: true, minHeight: 180);
            content.Children.Add(FormSection(LinuxStrings.SettingsPages_ProfilePageAsync_12, new GroupCard(Row(rules.Element)), LinuxStrings.SettingsPages_ProfilePageAsync_14));
            var notice = new StackPanel(); content.Children.Add(notice);
            save.IsEnabled = true;
            save.Click += async (_, _) =>
            {
                if (Busy) return;
                notice.Children.Clear();
                if (string.IsNullOrWhiteSpace(name.Box.Text)) { notice.Children.Add(Banner(LinuxStrings.SettingsPages_ProfilePageAsync_15)); return; }
                Busy = true; save.IsEnabled = false;
                try
                {
                    var edited = original with { Name = name.Box.Text ?? "", Profile = profile.Box.Text ?? "", Avatar = avatar.Value, XUrl = x.Box.Text ?? "", GithubUrl = github.Box.Text ?? "", Links = links.Select(link => new OwnerLink(link.Label.Text ?? "", link.Url.Text ?? "")).ToArray() };
                    var changes = edited.ChangesFrom(original);
                    if (changes.Count != 0) { await api.SaveOwnerAsync(changes, Token); original = edited; UpdateProfileRow(edited); }
                    if (TextContent.Normalize(rules.Box.Text ?? "") != TextContent.Normalize(originalRules))
                    {
                        try { originalRules = (await api.SaveRulesAsync(rules.Box.Text ?? "", Token)).Text; }
                        catch (Exception error) when (error is not OperationCanceledException) { notice.Children.Add(Banner(LinuxStrings.SettingsPages_ProfilePageAsync_16(error.Message))); return; }
                    }
                    var saved = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6, Margin = new Thickness(0, 10, 0, 0), Children = { Glyph(Icons.Check, 16, Green), Text(LinuxStrings.SettingsPages_ProfilePageAsync_17, 14, Green) } }; notice.Children.Add(saved);
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
        var auth = new StackPanel(); auth.Children.Add(CardTitle(SettingsIcons.Person, LinuxStrings.SettingsPages_AiPageAsync_1));
        auth.Children.Add(Text(LinuxStrings.SettingsPages_AiPageAsync_2, 14, Muted, null, new Thickness(0, 10, 0, 0)));
        var list = new StackPanel(); auth.Children.Add(list);
        var summary = new StackPanel(); summary.Children.Add(CardTitle(SettingsIcons.List, LinuxStrings.SettingsEditors_RefreshRows_1));
        summary.Children.Add(Text(LinuxStrings.SettingsPages_AiPageAsync_4, 14, Muted, null, new Thickness(0, 10, 0, 0)));
        var authCard = Card(auth); authCard.Margin = new Thickness(0, 16, 0, 0); var summaryCard = Card(summary); summaryCard.Margin = new Thickness(0, 16, 0, 0);
        page.Children.Add(authCard); page.Children.Add(summaryCard);
        await Task.WhenAll(LoadHarnessesAsync(list, token), LoadSummaryAsync(summary, token));
    }

    private async Task LoadHarnessesAsync(StackPanel list, CancellationToken token)
    {
        list.Children.Clear(); list.Children.Add(Loading(LinuxStrings.SettingsPages_LoadHarnessesAsync_1));
        try
        {
            var api = new HarnessAuthenticationApi(workspace.Management.Api);
            var harnesses = (await api.ListAsync(token)).Harnesses; token.ThrowIfCancellationRequested(); list.Children.Clear();
            var states = new List<Task>();
            foreach (var harness in harnesses)
            {
                var panel = harness.Install is { } install ? InstallPanel(harness, install, api, () => LoadHarnessesAsync(list, token), token) : null;
                if (harness.Id == "claude") { var host = new StackPanel(); list.Children.Add(host); states.Add(LoadClaudeAsync(host, harness, api, token, panel)); continue; }
                var names = new StackPanel { VerticalAlignment = VerticalAlignment.Center }; names.Children.Add(Text(harness.Name, 14, Ink)); names.Children.Add(Text(harness.UsageText, 12, Muted, null, new Thickness(0, 2, 0, 0)));
                var (row, ready) = AuthRow(names, harness, api, null, null, token, panel); list.Children.Add(row); states.Add(ready);
            }
            await Task.WhenAll(states);
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
        catch (Exception error)
        {
            list.Children.Clear(); list.Children.Add(Text(LinuxStrings.SettingsPages_LoadHarnessesAsync_2(error.Message), 13, Red, null, new Thickness(0, 10, 0, 0)));
            list.Children.Add(QuietButton(LinuxStrings.SettingsPages_LoadHarnessesAsync_3, () => _ = LoadHarnessesAsync(list, token), new Thickness(0, 10, 0, 0)));
        }
    }

    // a451: the install message and 「最新版を入れる」 of one AI. A change of readiness (installed or not) reloads the whole list from the server, so every row follows the server's state.
    private HarnessInstallPanel InstallPanel(HarnessAuthenticationOption harness, HarnessCliInstall install, HarnessAuthenticationApi api, Func<Task> reload, CancellationToken token)
    {
        var panel = new HarnessInstallPanel(api, harness.Id, harness.Name, install, token); var ready = HarnessCliInstall.Ready(install);
        panel.Changed += next => { if (HarnessCliInstall.Ready(next) == ready) return; ready = !ready; panel.Stop(); _ = reload(); _ = ReloadHomeAsync(); };
        return panel;
    }

    // One AI-authentication row: names | state | action. slot is the Claude account slot ("1st"/"2nd") whose login the row reads and starts; null is the single login.
    // afterDialog replaces the row's own state re-read when the login window closes.
    // panel: the install message and button under the row (a451); an AI that cannot run shows its install state instead of a login action.
    private (StackPanel Row, Task Ready) AuthRow(Control names, HarnessAuthenticationOption harness, HarnessAuthenticationApi api, string? slot, Func<Task>? afterDialog, CancellationToken token, HarnessInstallPanel? panel = null)
    {
        var runs = HarnessCliInstall.Ready(harness.Install);
        var row = new Grid { Margin = new Thickness(0, 10, 0, 0), ColumnDefinitions = new ColumnDefinitions("*,Auto,Auto") };
        var state = Text("", 12, Muted, FontWeight.SemiBold, new Thickness(10, 0)); state.VerticalAlignment = VerticalAlignment.Center; Grid.SetColumn(state, 1);
        var action = Capsule("", Violet, Brushes.White); Grid.SetColumn(action, 2); action.VerticalAlignment = VerticalAlignment.Center;
        row.Children.Add(names); row.Children.Add(state); row.Children.Add(action);
        void Show(HarnessRowState value) { state.Text = value.Title; state.Foreground = Tone(value.Tone); action.Content = value.Action; }
        async Task ReadStateAsync()
        {
            if (!runs) { Show(HarnessRowState.FromInstall(harness.Install!)); action.IsVisible = false; return; }
            Show(HarnessRowState.Checking);
            try { var status = (await api.StatusAsync(harness.Id, token, slot)).Auth?.Status; Show(slot is null ? HarnessRowState.From(status, harness.ReloginSupported) : HarnessRowState.FromSlot(status)); }
            catch (OperationCanceledException) when (token.IsCancellationRequested) { }
            catch (Exception) { Show(HarnessRowState.Unavailable); }
        }
        action.Click += async (_, _) =>
        {
            var dialog = new HarnessAuthenticationWindow(workspace, harness, slot: slot); _ = dialog.InitializeAsync();
            if (DialogOwner is { } owner) await dialog.ShowDialog(owner); else dialog.Show();
            await (afterDialog?.Invoke() ?? ReadStateAsync()); _ = ReloadHomeAsync();
        };
        AutomationProperties.SetName(action, slot is null ? harness.Name : harness.Name + " " + AccountText.SlotName(slot));
        var holder = new StackPanel { Margin = new Thickness(0, 10, 0, 0) }; holder.Children.Add(row); row.Margin = default;
        if (panel is not null) { panel.Margin = new Thickness(0, 4, 0, 0); panel.MoveTo(holder); }
        return (holder, ReadStateAsync());
    }

    // Claude: the two account slots when the server lists accounts, the old single row when GET /api/accounts answers 404 (older server),
    // and for any other read failure the reason with 一覧を更新 (never the old row, which would hide that the slots exist).
    private async Task LoadClaudeAsync(StackPanel host, HarnessAuthenticationOption harness, HarnessAuthenticationApi auth, CancellationToken token, HarnessInstallPanel? panel = null)
    {
        host.Children.Clear();
        var accounts = new HarnessAccountsApi(workspace.Management.Api);
        Task Reload() => LoadClaudeAsync(host, harness, auth, token, panel);
        void Failed(string message) { host.Children.Clear(); host.Children.Add(Text(LinuxStrings.SettingsPages_LoadClaudeAsync_1(message), 13, Red, null, new Thickness(0, 10, 0, 0))); host.Children.Add(QuietButton(LinuxStrings.SettingsPages_LoadHarnessesAsync_3, () => _ = Reload(), new Thickness(0, 10, 0, 0))); }
        AccountsResponse? list;
        try { list = await accounts.ReadAsync(token); token.ThrowIfCancellationRequested(); }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { return; }
        catch (Exception error) { Failed(error.Message); return; }
        if (list is null)
        {
            var oldNames = new StackPanel { VerticalAlignment = VerticalAlignment.Center }; oldNames.Children.Add(Text(harness.Name, 14, Ink)); oldNames.Children.Add(Text(harness.UsageText, 12, Muted, null, new Thickness(0, 2, 0, 0)));
            var (single, oldReady) = AuthRow(oldNames, harness, auth, null, null, token, panel); host.Children.Add(single); await oldReady; return;
        }
        if (list.Claude is not { } claude) { Failed(LinuxStrings.SettingsPages_LoadClaudeAsync_3); return; }
        var now = DateTimeOffset.Now;
        // Mac ClaudeAccountsCard: the harness name with its usage on the right, the both-limited lines, then the slots as plain rows like the other AI rows.
        var heading = new Grid { Margin = new Thickness(0, 10, 0, 0), ColumnDefinitions = new ColumnDefinitions("*,Auto") };
        var usage = Text(harness.UsageText, 12, Muted); usage.VerticalAlignment = VerticalAlignment.Center; Grid.SetColumn(usage, 1);
        heading.Children.Add(Text(harness.Name, 14, Ink)); heading.Children.Add(usage); host.Children.Add(heading);
        if (panel is not null) { panel.Margin = new Thickness(0, 4, 0, 0); panel.MoveTo(host); }
        foreach (var text in AccountText.CardBannerTexts(list, now))
        {
            var bar = Text("⚠ " + text, 12, Orange, null, new Thickness(0, 6, 0, 0)); AutomationProperties.SetName(bar, text); host.Children.Add(bar);
        }
        var seats = workspace.Bots.Select(bot => bot.Account).ToList();
        var ready = new List<Task>();
        foreach (var slot in claude.Slots)
        {
            if (slot.Slot is not ("1st" or "2nd")) continue;
            var slotTitle = AccountText.SlotName(slot.Slot);
            var names = new StackPanel { VerticalAlignment = VerticalAlignment.Center }; names.Children.Add(Text(slotTitle, 14, Ink, FontWeight.SemiBold));
            var lines = new List<(string Text, IBrush Color)>();
            if (AccountText.Login(slot) is { } account) lines.Add((account, Muted));
            if (AccountText.LimitLine(claude, slot, now) is { } limit) lines.Add((limit, Orange));
            if (AccountText.UsersLine(seats, "claude", slot) is { } users) lines.Add((users, Muted));
            // The contract asks that the Owner sees a slot whose history could not be shared (harness-accounts `history: separate`); the Mac has no line for it yet.
            if (slot.History == "separate") lines.Add((LinuxStrings.SettingsPages_LoadClaudeAsync_4, Muted));
            foreach (var (value, color) in lines) names.Children.Add(Text(value, 12, color, null, new Thickness(0, 2, 0, 0)));
            var (row, state) = AuthRow(names, harness, auth, slot.Slot, Reload, token); row.Margin = new Thickness(0, 8, 0, 0);
            AutomationProperties.SetName(row, slotTitle); host.Children.Add(row); ready.Add(state);
        }
        await Task.WhenAll(ready);
    }

    private async Task LoadSummaryAsync(StackPanel card, CancellationToken token)
    {
        var line = Loading(LinuxStrings.FeatureEditor_InitializeAsync_1); card.Children.Add(line);
        try
        {
            var record = await workspace.Planning.BackgroundAgentAsync(token); token.ThrowIfCancellationRequested(); card.Children.Remove(line);
            var text = Text(record?.Summary ?? LinuxStrings.SettingsPages_LoadSummaryAsync_2, 13, Ink);
            var row = FillRow(text, record is null ? null : () => _ = OpenBackgroundAgentAsync(record)); row.Margin = new Thickness(0, 12, 0, 0); row.Padding = new Thickness(12);
            if (record is null) text.Foreground = Muted;
            AutomationProperties.SetName(row, LinuxStrings.SettingsEditors_RefreshRows_1);
            card.Children.Add(row);
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
        catch (Exception error) { card.Children.Remove(line); card.Children.Add(Text(error.Message, 13, Red, null, new Thickness(0, 10, 0, 0))); }
    }

    // The summary-AI editor (Mac BackgroundAgentEditor): CLI, model and effort pickers drawn only from the model catalog.
    private async Task OpenBackgroundAgentAsync(BackgroundAgentRecord first)
    {
        var token = lifetime?.Token ?? Token;
        var form = NewPage(null, scroll: false); ShowSubPage(LinuxStrings.SettingsEditors_RefreshRows_1, new ScrollViewer { Content = form, VerticalScrollBarVisibility = ScrollBarVisibility.Auto }, Reopen);
        var record = first; var catalog = new Dictionary<string, HarnessModels>();
        string harness = record.Selection?.Harness ?? "codex", model = record.Selection?.Model ?? "", effort = record.Selection?.ReasoningEffort ?? "";
        string? savedText = null, errorText = null; var loading = true; var saving = false;
        void Render()
        {
            form.Children.Clear();
            if (loading) { form.Children.Add(Loading(LinuxStrings.SettingsPages_OpenBackgroundAgentAsync_2)); return; }
            var draft = new BackgroundAgentSelection(harness, model, effort); var problem = BackgroundAgentChoices.Problem(catalog, draft);
            var efforts = BackgroundAgentChoices.Efforts(catalog, harness, model);
            if (record.Notice is { } retired) form.Children.Add(Text(retired, 13, Orange, null, new Thickness(20, 0, 20, 4)));
            var clis = BackgroundAgentChoices.Harnesses.Select(item => new FormOption(item.Id, item.Label)).ToList(); if (harness.Length == 0) clis.Insert(0, new("", LinuxStrings.SettingsPages_OpenBackgroundAgentAsync_3));
            var cli = Picker("CLI", clis.ToArray(), harness, value => { harness = value; model = ""; effort = ""; Render(); });
            var models = new List<FormOption> { new("", LinuxStrings.SettingsPages_OpenBackgroundAgentAsync_3) }; models.AddRange(BackgroundAgentChoices.Models(catalog, harness).Select(item => new FormOption(item.Id, item.Label)));
            if (model.Length != 0 && models.All(item => item.Id != model)) models.Add(new(model, LinuxStrings.SettingsPages_OpenBackgroundAgentAsync_5(model)));
            var modelPicker = Picker(LinuxStrings.MemberEditors_ModelPicker_2, models.ToArray(), model, value => { model = value; if (!BackgroundAgentChoices.Efforts(catalog, harness, value).Contains(effort)) effort = ""; Render(); });
            var effortOptions = new List<FormOption> { new("", efforts.Length == 0 ? LinuxStrings.SettingsPages_OpenBackgroundAgentAsync_7 : LinuxStrings.SettingsPages_OpenBackgroundAgentAsync_3) }; effortOptions.AddRange(efforts.Select(item => new FormOption(item, item)));
            if (effort.Length != 0 && effortOptions.All(item => item.Id != effort)) effortOptions.Add(new(effort, LinuxStrings.SettingsPages_OpenBackgroundAgentAsync_5(effort)));
            var effortPicker = Picker(LinuxStrings.MemberEditors_ModelPicker_3, effortOptions.ToArray(), effort, value => { effort = value; Render(); });
            form.Children.Add(FormSection(null, new GroupCard(cli, modelPicker, effortPicker), LinuxStrings.SettingsPages_OpenBackgroundAgentAsync_11));
            if (problem is not null) form.Children.Add(Text(problem, 13, Red, null, new Thickness(20, 10, 20, 0)));
            if (record.Selection is { } stored && stored != draft) form.Children.Add(Text(LinuxStrings.SettingsPages_OpenBackgroundAgentAsync_12(BackgroundAgentRecord.Describe(stored)), 13, Muted, null, new Thickness(20, 10, 20, 0)));
            var save = Capsule(LinuxStrings.EditorForm_SaveLabel_1, Violet, Brushes.White, 8, 13, new Thickness(18, 7)); save.HorizontalAlignment = HorizontalAlignment.Left; save.Margin = new Thickness(20, 14, 0, 0); save.IsEnabled = !saving && problem is null;
            save.Click += async (_, _) => await SaveAsync(draft); form.Children.Add(save);
            if (savedText is not null) form.Children.Add(Text(savedText, 13, Muted, null, new Thickness(20, 10, 20, 0)));
            if (errorText is not null)
            {
                form.Children.Add(Text(errorText, 13, Red, null, new Thickness(20, 12, 20, 0)));
                var reload = QuietButton(LinuxStrings.MainWindow_BuildConversation_13, () => _ = LoadAsync(), new Thickness(20, 8, 0, 0)); reload.IsEnabled = !loading;
                form.Children.Add(reload);
            }
        }
        async Task LoadAsync()
        {
            loading = true; Render();
            try
            {
                var current = await workspace.Planning.BackgroundAgentAsync(token) ?? throw new BellApiException(LinuxStrings.SettingsPages_LoadSummaryAsync_2);
                catalog = (await workspace.Management.Api.GetAsync<ModelsResponse>("/api/models", token)).Models; token.ThrowIfCancellationRequested();
                record = current;
                // A retired stored choice starts the form empty so the user picks one of the four; nothing is saved until they do (a366).
                if (current.Notice is not null) { harness = ""; model = ""; effort = ""; }
                else if (current.Selection is { } selection) { harness = selection.Harness; model = selection.Model; effort = selection.ReasoningEffort; }
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
            try { record = await workspace.Planning.SaveBackgroundAgentAsync(record, draft, Token); savedText = LinuxStrings.SettingsPages_OpenBackgroundAgentAsync_16; }
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
        var card = new StackPanel(); card.Children.Add(CardTitle(SettingsIcons.Sliders, LinuxStrings.SettingsPages_FeaturesPageAsync_1));
        card.Children.Add(Text(LinuxStrings.SettingsPages_FeaturesPageAsync_2, 14, Muted, null, new Thickness(0, 10, 0, 0)));
        var holder = Card(card); holder.Margin = new Thickness(0, 16, 0, 0); page.Children.Add(holder);
        var line = Loading(LinuxStrings.FeatureEditor_InitializeAsync_1); card.Children.Add(line);
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
        if (OwnerWindow.Of(pane) is { } host) { EventHandler clear = (_, _) => editor.ClearSecrets(); host.Deactivated += clear; editor.PageClosed += () => host.Deactivated -= clear; }
        await editor.InitializeAsync();
    }

    // The 1Password連携 page (Mac OnePasswordSettingEditor). The token is cleared when the page goes away (lifetime) and when the app window loses focus.
    private OnePasswordView? onePassword;
    private async Task OpenOnePasswordAsync(FeatureSetting feature)
    {
        var token = lifetime?.Token ?? Token;
        var form = NewPage(null, scroll: false); ShowSubPage(feature.Title, new ScrollViewer { Content = form, VerticalScrollBarVisibility = ScrollBarVisibility.Auto }, Reopen);
        var view = onePassword = new OnePasswordView(workspace, feature, form, token, busy => Busy = busy);
        if (OwnerWindow.Of(pane) is { } host) { EventHandler clear = (_, _) => view.ClearToken(); host.Deactivated += clear; token.Register(() => host.Deactivated -= clear); }
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
        if (notifications is null) { group.Add(Row(LabeledRow(LinuxStrings.SettingsPages_NotificationsPage_1, LinuxStrings.SettingsPages_NotificationsPage_2))); page.Children.Add(FormSection(LinuxStrings.SettingsPages_NotificationsPage_3, group)); return Task.CompletedTask; }
        var status = LabeledRow(LinuxStrings.SettingsPages_NotificationsPage_1, notifications.Status, notifications.Error is null ? Secondary : Red); group.Add(Row(status));
        var toggle = Switch("#34C759"); toggle.IsChecked = notifications.Enabled; AutomationProperties.SetName(toggle, LinuxStrings.SettingsPages_NotificationsPage_5);
        var line = new Grid { ColumnDefinitions = new ColumnDefinitions("*,Auto") }; line.Children.Add(Text(LinuxStrings.SettingsPages_NotificationsPage_5, 13, Violet, null)); Grid.SetColumn(toggle, 1); line.Children.Add(toggle);
        group.Add(Row(line));
        toggle.Click += async (_, _) =>
        {
            var next = toggle.IsChecked; toggle.IsEnabled = false;
            await notifications.SetEnabledAsync(next);
            toggle.IsChecked = notifications.Enabled; toggle.IsEnabled = true;
            var text = (TextBlock)status.Children[1]; text.Text = notifications.Status; text.Foreground = notifications.Error is null ? Secondary : Red;
        };
        page.Children.Add(FormSection(LinuxStrings.SettingsPages_NotificationsPage_3, group));
        return Task.CompletedTask;
    }

    // ---- 接続 ----
    private Task ConnectionPage()
    {
        var page = NewPage(SettingsPage.Connection);
        var host = new Uri(workspace.Server).Host; var cloudflare = workspace.AuthMode == "cloudflare";
        page.Children.Add(FormSection(LinuxStrings.SettingsPages_ConnectionPage_1, new GroupCard(Row(LabeledRow(LinuxStrings.SettingsPages_ConnectionPage_2, host.Length == 0 ? LinuxStrings.FeatureEditor_InitializeAsync_7 : host)), Row(LabeledRow(LinuxStrings.SettingsPages_ConnectionPage_4, cloudflare ? "Cloudflare Access" : LinuxStrings.SettingsPages_ConnectionPage_5)))));
        page.Children.Add(FormSection(null, new GroupCard(Row(IconButtonRow(SettingsIcons.Refresh, LinuxStrings.SettingsPages_ConnectionPage_6, Violet, changeServer))), LinuxStrings.SettingsPages_ConnectionPage_7));
        if (cloudflare) page.Children.Add(FormSection(null, new GroupCard(Row(IconButtonRow(SettingsIcons.SignOut, LinuxStrings.SettingsPages_ConnectionPage_8, Red, signOut)))));
        return Task.CompletedTask;
    }

    // ---- 表示 ----
    private Task DisplayPage()
    {
        var page = NewPage(SettingsPage.Display);
        var store = new SettingsStore(SettingsStore.UserDirectory); var notice = new StackPanel();
        ConversationOpening current;
        try { current = store.Load().ConversationOpening; }
        catch (Exception error) { current = ConversationOpening.Rise; notice.Children.Add(Banner(LinuxStrings.SettingsPages_DisplayPage_1(error.Message))); }
        var group = new GroupCard(Row(Text(LinuxStrings.SettingsPages_DisplayPage_2, 13)));
        var checks = new Dictionary<ConversationOpening, Control>();
        foreach (var (option, label) in new[] { (ConversationOpening.Rise, LinuxStrings.SettingsEditors_DisplayChoiceText_2), (ConversationOpening.Fade, LinuxStrings.SettingsEditors_DisplayChoiceText_1) })
        {
            var line = new Grid { Background = Brushes.Transparent, Cursor = Hand, ColumnDefinitions = new ColumnDefinitions("*,Auto") };
            line.Children.Add(Text(label, 13)); var check = Glyph(Icons.Check, 16, Violet); check.Opacity = option == current ? 1 : 0; Grid.SetColumn(check, 1); line.Children.Add(check); checks[option] = check;
            AutomationProperties.SetName(line, label);
            line.PointerReleased += (_, args) =>
            {
                if (args.InitialPressMouseButton != MouseButton.Left) return;
                notice.Children.Clear();
                try { store.Save(store.Load() with { ConversationOpening = option }); DisplayPreference.Current = option; foreach (var (key, mark) in checks) mark.Opacity = key == option ? 1 : 0; }
                catch (Exception error) { notice.Children.Add(Banner(LinuxStrings.SettingsPages_DisplayPage_5(error.Message))); }
            };
            group.Add(Row(line));
        }
        page.Children.Add(FormSection(LinuxStrings.SettingsPages_DisplayPage_2, group, LinuxStrings.SettingsPages_DisplayPage_7)); page.Children.Add(notice);
        return Task.CompletedTask;
    }

    // ---- 利用と課金 ----
    // The Linux app sets this at start: the account card (a485) comes from its own files, which Android does not link.
    internal static Func<CancellationToken, Control>? AccountEntry { get; set; }

    private Task BillingPage()
    {
        // a485: no purchase here; the entry shows the server's plan or the one sentence, and hides itself on a developer server.
        var purchase = new PurchaseEntry(new SubscriptionApi(workspace.Management.Api), lifetime!.Token);
        var page = NewPage(SettingsPage.Billing);
        if (AccountEntry?.Invoke(lifetime!.Token) is { } account) page.Children.Add(Card(account));
        var card = new StackPanel(); card.Children.Add(CardTitle(SettingsIcons.Card, LinuxStrings.SettingsPages_BillingPage_1, 17));
        card.Children.Add(Text(LinuxStrings.SettingsPages_BillingPage_2, 14, Muted, null, new Thickness(0, 14, 0, 6)));
        card.Children.Add(purchase);
        var notice = new StackPanel();
        card.Children.Add(OpenLink(LinuxStrings.SettingsPages_BillingPage_3, PrivacyPolicyUrl, message => { notice.Children.Clear(); notice.Children.Add(Banner(message)); }));
        card.Children.Add(OpenLink(LinuxStrings.SettingsPages_BillingPage_4, SupportUrl, message => { notice.Children.Clear(); notice.Children.Add(Banner(message)); }));
        card.Children.Add(notice);
        var holder = Card(card); holder.Margin = new Thickness(0, 16, 0, 0); page.Children.Add(holder);
        return purchase.LoadAsync();
    }

    // ---- アップデート ----
    // Placeholder: the アップデート port replaces this call in SelectAsync with the hosted UpdateContent.
    private Task UpdatePageAsync()
    {
        var content = new UpdateContent(workspace); updateContent = content; pane.Content = content;
        return content.RefreshAsync();
    }

    // ---- このアプリについて ----
    private Task AboutPage()
    {
        var page = NewPage(SettingsPage.About);
        var host = new Uri(workspace.Server).Host;
        page.Children.Add(FormSection(null, new GroupCard(Row(LabeledRow(LinuxStrings.SettingsPages_AboutPage_1, typeof(SettingsWindow).Assembly.GetName().Version?.ToString(3) ?? "-")), Row(LabeledRow(LinuxStrings.MainWindow_MainWindow_9, host.Length == 0 ? LinuxStrings.FeatureEditor_InitializeAsync_7 : host)))));
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
                var toggle = Switch("#FF3B30"); toggle.IsChecked = now.Paused; toggle.IsEnabled = !updating; AutomationProperties.SetName(toggle, LinuxStrings.SettingsPages_StopPageAsync_1);
                var title = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center, Spacing = 8 };
                var mark = new Grid { Width = 16, Height = 16 }; mark.Children.Add(new Avalonia.Controls.Shapes.Ellipse { Fill = Red }); mark.Children.Add(new Border { Width = 6, Height = 6, CornerRadius = new CornerRadius(1), Background = Brushes.White });
                title.Children.Add(mark); title.Children.Add(Text(LinuxStrings.SettingsPages_StopPageAsync_1, 13, Red, FontWeight.SemiBold)); ((TextBlock)title.Children[1]).VerticalAlignment = VerticalAlignment.Center;
                var line = new Grid { ColumnDefinitions = new ColumnDefinitions("*,Auto") }; line.Children.Add(title); Grid.SetColumn(toggle, 1); line.Children.Add(toggle);
                toggle.Click += async (_, _) => await SetAsync(toggle.IsChecked);
                group.Add(Row(line)); group.Add(Row(Text(now.StatusText, 14, now.Alert ? Red : Secondary)));
                if (now.UnconfirmedText is { } members) group.Add(Row(Text(members, 14, Red)));
                if (now.CanRefresh) { var refresh = Capsule(LinuxStrings.GoalViews_Render_12, Brushes.Transparent, Violet, 8, 13, new Thickness(0, 4)); refresh.HorizontalAlignment = HorizontalAlignment.Left; refresh.IsEnabled = !loading && !updating; refresh.Click += async (_, _) => await ReadAsync(); group.Add(Row(refresh)); }
            }
            else if (!loading)
            {
                var failure = new StackPanel(); failure.Children.Add(Banner(LinuxStrings.SettingsPages_StopPageAsync_4));
                if (readError is not null) failure.Children.Add(Text(readError, 12, Secondary, null, new Thickness(0, 4, 0, 0)));
                group.Add(Row(failure));
                var again = Capsule(LinuxStrings.SettingsPages_StopPageAsync_5, Brushes.Transparent, Violet, 8, 13, new Thickness(0, 4)); again.HorizontalAlignment = HorizontalAlignment.Left; again.Click += async (_, _) => await ReadAsync(); group.Add(Row(again));
            }
            if (loading || updating) group.Add(Row(Text(LinuxStrings.FeatureEditor_InitializeAsync_1, 13, Secondary)));
            if (actionNote is not null) { var failure = new StackPanel(); failure.Children.Add(Banner(LinuxStrings.SettingsPages_StopPageAsync_7)); failure.Children.Add(Text(actionNote, 12, Secondary, null, new Thickness(0, 4, 0, 0))); group.Add(Row(failure)); }
            if (current is not null && readError is not null) group.Add(Row(Banner(LinuxStrings.SettingsPages_StopPageAsync_8(readError))));
            area.Children.Add(FormSection(null, group, LinuxStrings.SettingsPages_StopPageAsync_9));
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
