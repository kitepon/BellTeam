using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using BellTeam.Core;

namespace BellTeam.App;

// The Mac settings (apple/settings-user-flow.md): a 300-wide item list on the left, each row with its live line and badge and a 要対応 band on top,
// and the chosen page on the right. Page bodies live in SettingsPages.cs; the line and badge of each item come from Core SettingsSummary.
public sealed partial class SettingsWindow : EditorWindow
{
    private readonly Workspace workspace;
    private readonly Action? changeServer;
    private readonly Action? signOut;
    private readonly DesktopNotifications? notifications;
    private readonly Dictionary<SettingsPage, Border> rows = [];
    private readonly Dictionary<SettingsPage, (TextBlock Line, ContentControl Badge)> rowStates = [];
    private readonly StackPanel attentionBand = new();
    private UpdateContent? updateContent;
    private readonly TextBlock profileName = SettingsUi.Text("あなた", 15, SettingsUi.Ink, FontWeights.SemiBold);
    private readonly AvatarTile profileAvatar = new() { Width = 36, Height = 36 };
    private readonly ContentControl pane = new();
    private readonly ContentControl toolbarLeft = new();
    private readonly ContentControl toolbarRight = new();
    private readonly TextBlock toolbarTitle = SettingsUi.Text("", 13, SettingsUi.Secondary, FontWeights.SemiBold);
    private SettingsPage selected = SettingsPage.Profile;
    private CancellationTokenSource? lifetime;
    private EditorWindow? embedded;
    private bool inSubPage;
    // The item page on screen, whose head is redrawn whenever the home state changes; null under a sub page.
    private StackPanel? headPage;
    private SettingsPage headItem;
    private AiControl? control;

    // What the home knows about every item (Mac SettingsHomeState). Read when settings open and when the app comes back to the front.
    private List<AIAuthEntry>? aiEntries;
    private bool aiAnswered, controlUnreadable, rulesUnreadable, homeReading, homePending;
    private FeatureSetting[]? features;
    private BackgroundAgentRecord? backgroundAgent;
    private Dictionary<string, HarnessModels> modelCatalog = [];
    private string? rulesText;
    private (UpdateKind Kind, string Title)? update;
    private Window? host;

    public SettingsWindow(Workspace workspace, Action? changeServer = null, DesktopNotifications? notifications = null, Action? signOut = null) : base("設定", workspace.ConnectionToken)
    {
        this.workspace = workspace; this.changeServer = changeServer; this.notifications = notifications; this.signOut = signOut;
        profileName.Text = workspace.OwnerName;
        var layout = new Grid { Background = SettingsUi.Canvas };
        layout.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(300) }); layout.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1) }); layout.ColumnDefinitions.Add(new ColumnDefinition());
        layout.Children.Add(BuildSidebar());
        var divider = new Border { Background = SettingsUi.Hairline }; Grid.SetColumn(divider, 1); layout.Children.Add(divider);
        var right = new Grid(); right.RowDefinitions.Add(new RowDefinition { Height = new GridLength(44) }); right.RowDefinitions.Add(new RowDefinition());
        var bar = new Grid { Margin = new Thickness(12, 0, 12, 0) }; bar.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto }); bar.ColumnDefinitions.Add(new ColumnDefinition()); bar.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        toolbarTitle.HorizontalAlignment = HorizontalAlignment.Center; toolbarTitle.VerticalAlignment = VerticalAlignment.Center; Grid.SetColumn(toolbarTitle, 1);
        toolbarRight.VerticalAlignment = VerticalAlignment.Center; Grid.SetColumn(toolbarRight, 2); toolbarLeft.VerticalAlignment = VerticalAlignment.Center;
        bar.Children.Add(toolbarLeft); bar.Children.Add(toolbarTitle); bar.Children.Add(toolbarRight); right.Children.Add(bar);
        Grid.SetRow(pane, 1); right.Children.Add(pane); Grid.SetColumn(right, 2); layout.Children.Add(right);
        Content = layout;
        if (notifications is not null) notifications.PropertyChanged += NotificationsChanged;
        workspace.UpdatesChanged += UpdatesChanged; workspace.Terminals.Changed += TerminalsChanged;
        // The page is hosted in the main window: coming back to the front re-reads the home, as the Mac does on foreground.
        pane.Loaded += (_, _) => { if (host is null && Window.GetWindow(pane) is { } window && window != this) { host = window; host.Activated += HostActivated; } };
        Closed += (_, _) =>
        {
            if (notifications is not null) notifications.PropertyChanged -= NotificationsChanged;
            workspace.UpdatesChanged -= UpdatesChanged; workspace.Terminals.Changed -= TerminalsChanged; if (host is not null) host.Activated -= HostActivated;
            lifetime?.Cancel(); embedded?.Close(); updateContent?.Dispose();
        };
        RefreshRows();
    }

    // Leaving the page is blocked while a save here, or an update running in the hosted pane, is still in progress.
    public override bool CanNavigateAway => base.CanNavigateAway && embedded?.CanNavigateAway != false && updateContent?.Busy != true;
    public override void ScrollToEndForRender() { if (pane.Content is UpdateContent content) content.ScrollToEnd(); else if (pane.Content is TerminalDetailView detail) { detail.Scroller.UpdateLayout(); detail.Scroller.ScrollToEnd(); detail.Scroller.UpdateLayout(); } else if (pane.Content is ScrollViewer scroller) { scroller.ScrollToEnd(); scroller.UpdateLayout(); } }
    public SettingsPage Selected => selected;

    public async Task InitializeAsync(SettingsPage page = SettingsPage.Profile)
    {
        var loads = new List<Task> { ReloadHomeAsync() };
        // The profile page reads the owner itself and updates the list row from that.
        if (page != SettingsPage.Profile) loads.Add(LoadOwnerAsync());
        loads.Add(SelectAsync(page));
        await Task.WhenAll(loads);
    }

    public async Task SelectAsync(SettingsPage page)
    {
        if (page == selected && !inSubPage && pane.Content is not null) return;
        if (embedded?.CanNavigateAway == false || updateContent?.Busy == true) { workspace.ReportActionError("操作が終わってから画面を切り替えてください。"); return; }
        lifetime?.Cancel(); lifetime?.Dispose(); embedded?.Close(); embedded = null; updateContent?.Dispose(); updateContent = null; inSubPage = false;
        selected = page; headPage = null; Highlight(); SetToolbar(null, null, null);
        lifetime = CancellationTokenSource.CreateLinkedTokenSource(Token); var token = lifetime.Token;
        try
        {
            await (page switch
            {
                SettingsPage.Profile => ProfilePageAsync(token), SettingsPage.Ai => AiPageAsync(token), SettingsPage.Summary => SummaryPageAsync(token), SettingsPage.Terminals => TerminalsPageAsync(token), SettingsPage.Exclusions => ExclusionsPageAsync(token),
                SettingsPage.OnePassword => OnePasswordPageAsync(token), SettingsPage.Notifications => NotificationsPage(), SettingsPage.Rules => RulesPageAsync(token), SettingsPage.Features => FeaturesPageAsync(token),
                SettingsPage.Connection => ConnectionPage(), SettingsPage.Display => DisplayPage(), SettingsPage.Billing => BillingPage(), SettingsPage.Update => UpdatePageAsync(), SettingsPage.About => AboutPage(), _ => StopPageAsync(token)
            });
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
    }

    // A 要対応 row opens its item, or for an AI login straight into that AI's login window.
    private async Task OpenRouteAsync(SettingsRoute route)
    {
        await SelectAsync(route.Page);
        if (route.Harness is not { } id || selected != SettingsPage.Ai) return;
        try
        {
            var harness = (await new HarnessAuthenticationApi(workspace.Management.Api).ListAsync(Token)).Harnesses.FirstOrDefault(item => item.Id == id);
            if (harness is null) return;
            var entry = aiEntries?.FirstOrDefault(item => item.HarnessId == id && item.Slot == route.Slot);
            await OpenLoginAsync(harness, route.Slot, entry?.Name ?? harness.Name, entry?.AccountLabel, entry?.LimitLine, entry?.SignedOut ?? false);
        }
        catch (OperationCanceledException) when (Token.IsCancellationRequested) { }
        catch (Exception) { /* the AI page shows its own read failure; the band stays as read */ }
    }
    // The login of one AI as a page in the right pane; going back re-reads the AI rows and the home.
    private async Task OpenLoginAsync(HarnessAuthenticationOption harness, string? slot, string name, string? accountLabel, string? limitLine, bool signedOut)
    {
        var login = new HarnessAuthenticationWindow(workspace, harness, slot: slot, name: name, accountLabel: accountLabel, limitLine: limitLine, signedOut: signedOut); embedded = login;
        void Back() { Reopen(); _ = ReloadHomeAsync(); }
        ShowSubPage(name, new ScrollViewer { Content = login.AsPage(Back), VerticalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled }, Back);
        await login.InitializeAsync();
    }

    private UIElement BuildSidebar()
    {
        var list = new StackPanel { Margin = new Thickness(0, 50, 0, 16) };
        list.Children.Add(attentionBand);
        profileAvatar.Entry = OwnerEntry(null); profileAvatar.Workspace = workspace;
        var profile = new Grid(); profile.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(36) }); profile.ColumnDefinitions.Add(new ColumnDefinition());
        profile.Children.Add(profileAvatar);
        var text = new StackPanel { Margin = new Thickness(14, 0, 0, 0), VerticalAlignment = VerticalAlignment.Center }; text.Children.Add(profileName); text.Children.Add(SettingsUi.Text(SettingsPageInfo.Title(SettingsPage.Profile), 12, SettingsUi.Secondary, null, new Thickness(0, 2, 0, 0)));
        Grid.SetColumn(text, 1); profile.Children.Add(text);
        list.Children.Add(CategoryRow(SettingsPage.Profile, SettingsPageInfo.Title(SettingsPage.Profile) + " " + workspace.OwnerName, profile, new Thickness(0, 2, 0, 0)));
        foreach (var group in SettingsPageInfo.Groups)
        {
            var first = true;
            foreach (var page in group)
            {
                var grid = new Grid(); grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(30) }); grid.ColumnDefinitions.Add(new ColumnDefinition()); grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
                grid.Children.Add(SettingsUi.Tile(page, 30));
                var labels = new StackPanel { Margin = new Thickness(12, 0, 6, 0), VerticalAlignment = VerticalAlignment.Center };
                var title = SettingsUi.Text(SettingsPageInfo.Title(page), 14, page == SettingsPage.Stop ? SettingsUi.Red : SettingsUi.Ink, FontWeights.Medium);
                // Every row is one title line and one state line, so all rows have the same height; the page head shows the full line.
                var line = SettingsUi.Text(SettingsPageInfo.Detail(page), 12, SettingsUi.Secondary, null, new Thickness(0, 2, 0, 0)); line.TextWrapping = TextWrapping.NoWrap; line.TextTrimming = TextTrimming.CharacterEllipsis;
                title.TextWrapping = TextWrapping.NoWrap; title.TextTrimming = TextTrimming.CharacterEllipsis;
                labels.Children.Add(title); labels.Children.Add(line);
                Grid.SetColumn(labels, 1); grid.Children.Add(labels);
                var badge = new ContentControl { VerticalAlignment = VerticalAlignment.Center, Focusable = false }; Grid.SetColumn(badge, 2); grid.Children.Add(badge);
                rowStates[page] = (line, badge);
                list.Children.Add(CategoryRow(page, SettingsPageInfo.Title(page), grid, new Thickness(0, first ? 10 : 0, 0, 0))); first = false;
            }
        }
        return new ScrollViewer { Content = list, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled };
    }

    private Border CategoryRow(SettingsPage page, string name, UIElement content, Thickness margin)
    {
        var row = new Border { Child = content, Margin = new Thickness(10, margin.Top, 10, 0), Padding = new Thickness(8, 5, 10, 5), CornerRadius = new CornerRadius(8), Background = Brushes.Transparent, Focusable = true, Cursor = Cursors.Hand };
        System.Windows.Automation.AutomationProperties.SetName(row, name); System.Windows.Automation.AutomationProperties.SetAutomationId(row, "settings-row-" + page.ToString().ToLowerInvariant());
        row.MouseLeftButtonUp += (_, _) => _ = SelectAsync(page);
        row.KeyDown += (_, args) => { if (args.Key is Key.Enter or Key.Space) { _ = SelectAsync(page); args.Handled = true; } };
        rows[page] = row; return row;
    }
    // Mac settings list selection (rebuilt settings): a light grey rounded row; titles and badges keep their colours.
    private void Highlight() { foreach (var (page, row) in rows) row.Background = page == selected ? SettingsUi.Selection : Brushes.Transparent; }

    // ---- home state ----
    // nil for the items that show their own value (profile, 表示): Mac SettingsHomeState.status(for:).
    internal SettingsStatus ItemStatus(SettingsPage page) => page switch
    {
        SettingsPage.Ai => aiAnswered ? SettingsSummary.Ai(aiEntries) : new(SettingsPageInfo.Detail(page)),
        SettingsPage.Summary => SettingsSummary.SummaryAgent(backgroundAgent, modelCatalog),
        SettingsPage.Terminals => SettingsSummary.Terminals(workspace.Terminals.State, workspace.Terminals.Terminals),
        SettingsPage.Exclusions => SettingsSummary.Exclusions(exclusions, exclusionsUnreadable),
        SettingsPage.OnePassword => SettingsSummary.OnePassword(features?.FirstOrDefault(item => item.Id == OnePasswordItem.Id)),
        SettingsPage.Notifications => notifications is null ? new(SettingsPageInfo.Detail(page)) : SettingsSummary.Notifications(notifications.Enabled ? NotificationState.Registered : NotificationState.Unregistered, failed: notifications.Error is not null),
        SettingsPage.Rules => SettingsSummary.Rules(rulesText, rulesUnreadable),
        SettingsPage.Features => SettingsSummary.Features(features ?? []),
        SettingsPage.Connection => new(ServerHost),
        SettingsPage.Display => new(DisplayChoiceText),
        SettingsPage.Update => update is { } known ? SettingsSummary.Update(known.Kind, known.Title) : new(SettingsPageInfo.Detail(page)),
        SettingsPage.About => new(VersionText),
        SettingsPage.Stop => SettingsSummary.Stop(control, controlUnreadable),
        _ => new(SettingsPageInfo.Detail(page))
    };
    private string ServerHost { get { var value = Uri.TryCreate(workspace.Server, UriKind.Absolute, out var uri) ? uri.Host : ""; return value.Length == 0 ? "未設定" : value; } }
    private static string VersionText => typeof(MainWindow).Assembly.GetName().Version?.ToString(3) ?? "-";
    private static string DisplayChoiceText { get { try { return new SettingsStore(SettingsStore.UserDirectory).Load().ConversationOpening == ConversationOpening.Fade ? "フェードインだけ" : "下から順に浮き上がる"; } catch (Exception) { return SettingsPageInfo.Detail(SettingsPage.Display); } } }

    private void RefreshRows()
    {
        foreach (var (page, (line, badge)) in rowStates)
        {
            var status = ItemStatus(page);
            line.Text = status.Line; badge.Content = status.Badge is { } text ? SettingsUi.Badge(text, status.Tone) : null;
        }
        if (headPage is not null) RedrawHead(headPage, headItem);
        attentionBand.Children.Clear();
        var attention = SettingsPageInfo.Groups.SelectMany(group => group).Select(page => (Page: page, Status: ItemStatus(page))).Where(item => item.Status.NeedsAttention).ToList();
        if (attention.Count == 0) return;
        attentionBand.Children.Add(SettingsUi.Text("要対応", 12, SettingsUi.Secondary, FontWeights.SemiBold, new Thickness(20, 0, 0, 4)));
        foreach (var (page, status) in attention)
        {
            var grid = new Grid(); grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(30) }); grid.ColumnDefinitions.Add(new ColumnDefinition()); grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            grid.Children.Add(SettingsUi.Tile(page, 30));
            var labels = new StackPanel { Margin = new Thickness(12, 0, 6, 0), VerticalAlignment = VerticalAlignment.Center };
            var title = SettingsUi.Text(SettingsPageInfo.Title(page), 14, SettingsUi.Ink, FontWeights.Medium); title.TextWrapping = TextWrapping.NoWrap;
            var line = SettingsUi.Text(status.Line, 12, SettingsUi.Orange, null, new Thickness(0, 2, 0, 0)); line.TextWrapping = TextWrapping.NoWrap; line.TextTrimming = TextTrimming.CharacterEllipsis;
            labels.Children.Add(title); labels.Children.Add(line); Grid.SetColumn(labels, 1); grid.Children.Add(labels);
            if (status.Badge is { } text) { var badge = SettingsUi.Badge(text, status.Tone); Grid.SetColumn(badge, 2); grid.Children.Add(badge); }
            var route = status.AttentionRoute ?? new SettingsRoute(page);
            var row = new Border { Child = grid, Margin = new Thickness(10, 0, 10, 2), Padding = new Thickness(8, 5, 10, 5), CornerRadius = new CornerRadius(8), Background = new SolidColorBrush(Color.FromArgb(0x1A, 0xFF, 0x95, 0x00)), Focusable = true, Cursor = Cursors.Hand };
            System.Windows.Automation.AutomationProperties.SetName(row, SettingsPageInfo.Title(page) + " " + status.Line); System.Windows.Automation.AutomationProperties.SetAutomationId(row, "settings-attention-" + page.ToString().ToLowerInvariant());
            row.MouseLeftButtonUp += (_, _) => _ = OpenRouteAsync(route);
            row.KeyDown += (_, args) => { if (args.Key is Key.Enter or Key.Space) { _ = OpenRouteAsync(route); args.Handled = true; } };
            attentionBand.Children.Add(row);
        }
        attentionBand.Children.Add(new Border { Height = 1, Background = SettingsUi.Hairline, Margin = new Thickness(20, 8, 20, 4) });
    }

    // Opening settings and coming back to the front read every item; a read that arrives while one runs is done once more afterwards.
    private async Task ReloadHomeAsync()
    {
        if (homeReading) { homePending = true; return; }
        homeReading = true;
        try
        {
            do
            {
                homePending = false;
                await Task.WhenAll(LoadAiAsync(), LoadSettingsAsync(), LoadModelsAsync(), LoadRulesAsync(), LoadControlAsync(), LoadUpdateAsync(), LoadExclusionsAsync(), workspace.Terminals.RefreshAsync(Token));
                RefreshRows();
            } while (homePending && !Token.IsCancellationRequested);
        }
        catch (OperationCanceledException) when (Token.IsCancellationRequested) { }
        finally { homeReading = false; }
    }
    private void HostActivated(object? sender, EventArgs args) => _ = ReloadHomeAsync();
    private void UpdatesChanged() => Dispatcher.BeginInvoke(() => _ = LoadUpdateAsync().ContinueWith(_ => Dispatcher.BeginInvoke(RefreshRows), TaskScheduler.Default));
    private void TerminalsChanged() => Dispatcher.BeginInvoke(RefreshRows);

    // Every harness, and Claude's accounts when /api/accounts lists them; each login read with its own GET like the AI page does.
    private async Task LoadAiAsync()
    {
        try
        {
            var auth = new HarnessAuthenticationApi(workspace.Management.Api);
            var harnesses = (await auth.ListAsync(Token)).Harnesses;
            AccountHarness? claude = null; var accounts = ClaudeAccountsRead.Listed;
            try { claude = (await new HarnessAccountsApi(workspace.Management.Api).ReadAsync(Token))?.Claude; if (claude is null) accounts = ClaudeAccountsRead.OldServer; }
            catch (OperationCanceledException) when (Token.IsCancellationRequested) { throw; }
            catch (Exception error) { accounts = ClaudeAccountsReads.Failure(error); }
            var now = DateTimeOffset.Now; var reads = new List<Task<AIAuthEntry>>();
            foreach (var harness in harnesses)
            {
                if (harness.Id == "claude" && claude is not null)
                    foreach (var slot in claude.Slots) reads.Add(ReadEntryAsync(auth, harness, slot.Slot == "1st" ? null : slot.Slot, harness.Name + " " + AccountText.SlotName(slot.Slot), slot.SignedOutAt is not null, slot.Label, AccountText.LimitLine(claude, slot, now)));
                else reads.Add(ReadEntryAsync(auth, harness, null, harness.Name, false, null, null));
            }
            var entries = (await Task.WhenAll(reads)).ToList();
            if (accounts == ClaudeAccountsRead.Unreadable && harnesses.Any(item => item.Id == "claude")) entries.Add(ClaudeAccountsReads.UnreadableEntry);
            aiEntries = entries; aiAnswered = true;
        }
        catch (OperationCanceledException) when (Token.IsCancellationRequested) { throw; }
        catch (Exception) { aiEntries = null; aiAnswered = true; }
    }
    private async Task<AIAuthEntry> ReadEntryAsync(HarnessAuthenticationApi auth, HarnessAuthenticationOption harness, string? slot, string name, bool signedOut, string? label, string? limitLine)
    {
        var progress = AuthenticationProgress.From(null, loaded: true);
        try { progress = AuthenticationProgress.From((await auth.StatusAsync(harness.Id, Token, slot)).Auth, loaded: true, signedOut: signedOut); }
        catch (OperationCanceledException) when (Token.IsCancellationRequested) { throw; }
        catch (Exception) { /* unreadable: the entry says 確認できません */ }
        return new AIAuthEntry(harness.Id, name, slot, progress) { AccountLabel = label, LimitLine = limitLine, SignedOut = signedOut };
    }
    private async Task LoadSettingsAsync()
    {
        try { features = await workspace.Planning.FeaturesAsync(Token); } catch (OperationCanceledException) when (Token.IsCancellationRequested) { throw; } catch (Exception) { /* keeps the last list; the page shows the reason */ }
        try { backgroundAgent = await workspace.Planning.BackgroundAgentAsync(Token); } catch (OperationCanceledException) when (Token.IsCancellationRequested) { throw; } catch (Exception) { /* keeps the last value; the page shows the reason */ }
    }
    // Only for display names; a failure keeps the last names (the editor reads the list itself and says so).
    private async Task LoadModelsAsync()
    {
        try { modelCatalog = (await workspace.Management.Api.GetAsync<ModelsResponse>("/api/models", Token)).Models; }
        catch (OperationCanceledException) when (Token.IsCancellationRequested) { throw; }
        catch (Exception) { }
    }
    private async Task LoadRulesAsync()
    {
        try { rulesText = (await workspace.Planning.RulesAsync(Token)).Text; rulesUnreadable = false; }
        catch (OperationCanceledException) when (Token.IsCancellationRequested) { throw; }
        catch (Exception) { rulesUnreadable = rulesText is null; }
    }
    private void RulesSaved(string text) { rulesText = text; rulesUnreadable = false; RefreshRows(); }
    private async Task LoadUpdateAsync()
    {
        try
        {
            var center = new UpdateCenter(workspace.Management.Api, new SettingsStore(SettingsStore.UserDirectory));
            var inventory = await center.InventoryAsync(Token); var current = UpdateScreen.Current(inventory, center.Requests);
            var kind = UpdateScreen.Kind(inventory, false, current, UpdateScreen.HasUnreadRequest(center.Requests));
            update = (kind, UpdateScreen.Hero(kind, inventory, current).Title);
        }
        catch (OperationCanceledException) when (Token.IsCancellationRequested) { throw; }
        catch (Exception) { update = (UpdateKind.Unreachable, UpdateScreen.Hero(UpdateKind.Unreachable, null, null).Title); }
    }

    private ConversationEntry OwnerEntry(OwnerProfile? owner) => new(new("owner", false), owner?.Name ?? workspace.OwnerName, "", DateTimeOffset.MinValue, new Bot { Id = "owner", Name = owner?.Name ?? workspace.OwnerName, DisplayName = owner?.Name ?? workspace.OwnerName, Avatar = owner?.Avatar ?? "" }, null);
    private void UpdateProfileRow(OwnerProfile owner) { profileName.Text = owner.Name; profileAvatar.Entry = OwnerEntry(owner); }
    private async Task LoadOwnerAsync()
    {
        try { var owner = (await workspace.Planning.OwnerAsync(Token)).Owner; UpdateProfileRow(owner); }
        catch (OperationCanceledException) when (Token.IsCancellationRequested) { }
        catch (Exception) { /* the row keeps the owner name already known to the workspace; the profile page shows the reason */ }
    }

    private void NotificationsChanged(object? sender, System.ComponentModel.PropertyChangedEventArgs args) { if (args.PropertyName is nameof(DesktopNotifications.Enabled) or nameof(DesktopNotifications.Error)) Dispatcher.BeginInvoke(RefreshRows); }
    private void ShowControl(AiControl? value) { control = value; controlUnreadable = false; RefreshRows(); }
    private async Task LoadControlAsync()
    {
        try { control = (await workspace.Planning.AiControlAsync(Token)).Control; controlUnreadable = false; }
        catch (OperationCanceledException) when (Token.IsCancellationRequested) { throw; }
        catch (Exception) { controlUnreadable = control is null; }
    }

    private StackPanel NewPage(SettingsPage? page, bool scroll = true)
    {
        var stack = new StackPanel { Margin = new Thickness(20, 28, 20, 24), MaxWidth = 720 };
        if (page is { } known) { stack.Children.Add(SettingsUi.Header(known, ItemStatus(known))); headPage = stack; headItem = known; }
        if (scroll) pane.Content = new ScrollViewer { Content = stack, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled };
        return stack;
    }
    // A page head drawn before its item was read is drawn again with the state just read (the head is always the page's first child).
    private void RedrawHead(StackPanel page, SettingsPage item) { page.Children.RemoveAt(0); page.Children.Insert(0, SettingsUi.Header(item, ItemStatus(item))); }
    private void SetToolbar(UIElement? left, string? title, UIElement? right) { toolbarLeft.Content = left; toolbarTitle.Text = title ?? ""; toolbarRight.Content = right; }
    // A page opened from inside a page (a feature, a terminal): the toolbar gets a back control that returns to the item.
    private void ShowSubPage(string title, UIElement content, Action back)
    {
        inSubPage = true; headPage = null;
        var button = SettingsUi.Capsule("‹ " + SettingsPageInfo.Title(selected), Brushes.Transparent, SettingsUi.Violet, 8, 13, new Thickness(8, 4, 8, 4));
        button.Click += (_, _) => back();
        SetToolbar(button, title, null); pane.Content = content;
    }
    private void Reopen() { var page = selected; inSubPage = true; _ = SelectAsync(page); }
    private static string ErrorText(Exception error) => error is BellApiException { Status: not null } ? error.Message : "操作の結果を確認できませんでした。現在の状態を確認してください。\n" + error.Message;
}
