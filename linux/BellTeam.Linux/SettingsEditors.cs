using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Controls.Primitives;
using Avalonia.Input;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Threading;
using BellTeam.Core;

namespace BellTeam.Linux;

// The Mac settings: a 300-wide category list on the left, the chosen page on the right. Page bodies live in SettingsPages.cs.
public sealed partial class SettingsWindow : EditorWindow, IPageBack
{
    private readonly LinuxWorkspace workspace;
    private readonly Action? changeServer;
    private readonly Action? signOut;
    private readonly INotificationSwitch? notifications;
    private readonly Dictionary<SettingsPage, Border> rows = [];
    private readonly List<(SettingsPage Page, TextBlock Text, IBrush Original)> rowLabels = [];
    private readonly TextBlock profileName = SettingsUi.Text(LinuxStrings.SettingsEditors_profileName_1, 15, SettingsUi.Ink, FontWeight.SemiBold);
    private readonly AvatarTile profileAvatar = new() { Width = 36, Height = 36 };
    // Each list row's live line and badge (Mac SettingsHomeState), drawn from the Core SettingsSummary by RefreshRows.
    private readonly Dictionary<SettingsPage, (TextBlock Line, ContentControl Badge)> rowStates = [];
    private readonly ContentControl pane = new();
    private readonly ContentControl toolbarLeft = new();
    private readonly ContentControl toolbarRight = new();
    private readonly TextBlock toolbarTitle = SettingsUi.Text("", 13, SettingsUi.Secondary, FontWeight.SemiBold);
    private SettingsPage selected = SettingsPage.Profile;
    private CancellationTokenSource? lifetime;
    private EditorWindow? embedded;
    private UpdateContent? updateContent;
    private bool inSubPage;
    // A phone shows the page list, then one page at a time (the Android shell sets these before Show). HiddenPages are pages the app covers itself.
    internal bool Compact { get; set; }
    internal HashSet<SettingsPage> HiddenPages { get; } = [];
    private bool showingPane, initializing;
    private Grid? layout; private Control? sidebar, divider, rightPane;
    private AiControl? control;
    // The 要対応 band (Mac SettingsHome), and what the home knows about every item (a452). Read when settings open, when the window comes back to the front and after a page changed something.
    private readonly StackPanel attentionBand = new();
    private List<AIAuthEntry>? aiEntries;
    private bool aiAnswered, controlUnreadable, rulesUnreadable, homeReading, homePending;
    private FeatureSetting[]? features;
    private BackgroundAgentRecord? backgroundAgent;
    private Dictionary<string, HarnessModels> modelCatalog = [];
    private string? rulesText;
    private (UpdateKind Kind, string Title)? update;
    private Window? host;

    public SettingsWindow(LinuxWorkspace workspace, Action? changeServer = null, INotificationSwitch? notifications = null, Action? signOut = null, SettingsPage[]? compactHidden = null) : base(LinuxStrings.FeatureEditor_InitializeAsync_5, workspace.ConnectionToken)
    {
        // compactHidden != null is the phone shape (see ApplyCompact): the pages in it are drawn by the app itself and left out of the list.
        if (compactHidden is not null) { Compact = true; foreach (var page in compactHidden) HiddenPages.Add(page); }
        this.workspace = workspace; this.changeServer = changeServer; this.notifications = notifications; this.signOut = signOut;
        profileName.Text = workspace.OwnerName;
        layout = new Grid { Background = SettingsUi.Canvas, ColumnDefinitions = new ColumnDefinitions("300,1,*") };
        sidebar = BuildSidebar(); layout.Children.Add(sidebar);
        divider = new Border { Background = SettingsUi.Hairline }; Grid.SetColumn(divider, 1); layout.Children.Add(divider);
        var right = new Grid { RowDefinitions = new RowDefinitions("44,*") };
        var bar = new Grid { Margin = new Thickness(12, 0), ColumnDefinitions = new ColumnDefinitions("Auto,*,Auto") };
        toolbarTitle.HorizontalAlignment = HorizontalAlignment.Center; toolbarTitle.VerticalAlignment = VerticalAlignment.Center; Grid.SetColumn(toolbarTitle, 1);
        toolbarRight.VerticalAlignment = VerticalAlignment.Center; Grid.SetColumn(toolbarRight, 2); toolbarLeft.VerticalAlignment = VerticalAlignment.Center;
        bar.Children.Add(toolbarLeft); bar.Children.Add(toolbarTitle); bar.Children.Add(toolbarRight); right.Children.Add(bar);
        Grid.SetRow(pane, 1); pane.HorizontalContentAlignment = HorizontalAlignment.Stretch; pane.VerticalContentAlignment = VerticalAlignment.Stretch; right.Children.Add(pane); Grid.SetColumn(right, 2); layout.Children.Add(right); rightPane = right;
        Content = layout; ApplyCompact();
        if (notifications is not null) notifications.PropertyChanged += NotificationsChanged;
        workspace.UpdatesChanged += UpdatesChanged; workspace.Terminals.Changed += TerminalsChanged;
        // Coming back to the front re-reads the home, as the Mac does on foreground.
        AttachedToVisualTree += (_, _) => { if (host is null && OwnerWindow.Of(this) is { } window && window != this) { host = window; host.Activated += HostActivated; } };
        PageClosed += () =>
        {
            if (notifications is not null) notifications.PropertyChanged -= NotificationsChanged;
            workspace.UpdatesChanged -= UpdatesChanged; workspace.Terminals.Changed -= TerminalsChanged; if (host is not null) host.Activated -= HostActivated;
            lifetime?.Cancel(); embedded?.ClosePage(); updateContent?.Dispose();
        };
        RefreshRows();
    }

    // Leaving the page is blocked while a save here is still in progress.
    public override bool CanNavigateAway => base.CanNavigateAway && embedded?.CanNavigateAway != false && updateContent?.Busy != true;
    public override void ScrollToEndForRender() { if (pane.Content is TerminalDetailView detail) { detail.Scroller.UpdateLayout(); detail.Scroller.ScrollToEnd(); detail.Scroller.UpdateLayout(); } else if (pane.Content is ScrollViewer scroller) { scroller.UpdateLayout(); scroller.ScrollToEnd(); scroller.UpdateLayout(); } }
    public SettingsPage Selected => selected;

    // The phone shape: only the page list, or only the chosen page.
    private void ApplyCompact()
    {
        if (!Compact) return;
        layout!.ColumnDefinitions = new ColumnDefinitions("*"); Grid.SetColumn(sidebar!, 0); Grid.SetColumn(divider!, 0); Grid.SetColumn(rightPane!, 0);
        sidebar!.IsVisible = !showingPane; divider!.IsVisible = false; rightPane!.IsVisible = showingPane;
    }
    // The back key of a phone page: from a page back to the list, then the window closes.
    public bool GoBack() { if (!Compact || !showingPane) return false; showingPane = false; ApplyCompact(); return true; }

    public async Task InitializeAsync(SettingsPage page = SettingsPage.Profile)
    {
        var loads = new List<Task> { ReloadHomeAsync() };
        // The profile page reads the owner itself and updates the list row from that.
        if (page != SettingsPage.Profile) loads.Add(LoadOwnerAsync());
        initializing = true;
        try { loads.Add(SelectAsync(page)); await Task.WhenAll(loads); } finally { initializing = false; }
    }

    public async Task SelectAsync(SettingsPage page)
    {
        if (page == selected && !inSubPage && pane.Content is not null) return;
        if (embedded?.CanNavigateAway == false || updateContent?.Busy == true) { workspace.ReportActionError(LinuxStrings.MainWindow_LeavePage_1); return; }
        lifetime?.Cancel(); lifetime?.Dispose(); embedded?.ClosePage(); embedded = null; updateContent?.Dispose(); updateContent = null; inSubPage = false;
        if (Compact && !initializing) { showingPane = true; ApplyCompact(); }
        // Leaving a page re-reads what it may have changed (the per-AI login reads wait for the AI page's own events).
        if (!initializing && pane.Content is not null && page != selected) _ = ReloadHomeAsync(withAi: false);
        selected = page; Highlight(); SetToolbar(null, null, null);
        lifetime = CancellationTokenSource.CreateLinkedTokenSource(Token); var token = lifetime.Token;
        try
        {
            await (page switch
            {
                SettingsPage.Profile => ProfilePageAsync(token), SettingsPage.Ai => AiPageAsync(token), SettingsPage.Terminals => TerminalsPageAsync(token), SettingsPage.Features => FeaturesPageAsync(token),
                SettingsPage.Notifications => NotificationsPage(), SettingsPage.Connection => ConnectionPage(), SettingsPage.Display => DisplayPage(),
                SettingsPage.Billing => BillingPage(), SettingsPage.Update => UpdatePageAsync(), SettingsPage.About => AboutPage(), _ => StopPageAsync(token)
            });
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
    }

    private Control BuildSidebar()
    {
        var list = new StackPanel { Margin = new Thickness(0, 50, 0, 16) };
        profileAvatar.Entry = OwnerEntry(null); profileAvatar.Workspace = workspace;
        var profile = new Grid { ColumnDefinitions = new ColumnDefinitions("36,*") };
        profile.Children.Add(profileAvatar);
        var text = new StackPanel { Margin = new Thickness(14, 0, 0, 0), VerticalAlignment = VerticalAlignment.Center }; text.Children.Add(profileName); var profileDetail = SettingsUi.Text(LinuxStrings.SettingsEditors_BuildSidebar_1, 12, SettingsUi.Secondary, null, new Thickness(0, 2, 0, 0)); text.Children.Add(profileDetail); Track(SettingsPage.Profile, profileName, profileDetail);
        Grid.SetColumn(text, 1); profile.Children.Add(text);
        list.Children.Add(CategoryRow(SettingsPage.Profile, SettingsPageInfo.Title(SettingsPage.Profile) + " " + workspace.OwnerName, profile, new Thickness(0, 2, 0, 0)));
        list.Children.Add(attentionBand);
        foreach (var group in SettingsPageInfo.Groups)
        {
            var first = true;
            foreach (var page in group)
            {
                if (HiddenPages.Contains(page)) continue;
                var grid = new Grid { ColumnDefinitions = new ColumnDefinitions("30,*,Auto") };
                var tile = SettingsUi.Tile(page, 30); tile.VerticalAlignment = VerticalAlignment.Center; grid.Children.Add(tile);
                var labels = new StackPanel { Margin = new Thickness(12, 0, 6, 0), VerticalAlignment = VerticalAlignment.Center };
                var title = SettingsUi.Text(SettingsPageInfo.Title(page), 14, page == SettingsPage.Stop ? SettingsUi.Red : SettingsUi.Ink, FontWeight.Medium);
                // Every row is one title line and one state line, so all rows have the same height.
                var detail = SettingsUi.Text(SettingsPageInfo.Detail(page), 12, SettingsUi.Secondary, null, new Thickness(0, 2, 0, 0)); detail.TextWrapping = TextWrapping.NoWrap; detail.TextTrimming = TextTrimming.CharacterEllipsis;
                labels.Children.Add(title); labels.Children.Add(detail); Track(page, title, detail);
                Grid.SetColumn(labels, 1); grid.Children.Add(labels);
                var badge = new ContentControl { VerticalAlignment = VerticalAlignment.Center, Focusable = false }; Grid.SetColumn(badge, 2); grid.Children.Add(badge);
                rowStates[page] = (detail, badge);
                list.Children.Add(CategoryRow(page, SettingsPageInfo.Title(page), grid, new Thickness(0, first ? 10 : 0, 0, 0))); first = false;
            }
        }
        return new ScrollViewer { Content = list, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled };
    }

    private Border CategoryRow(SettingsPage page, string name, Control content, Thickness margin)
    {
        var row = new Border { Child = content, Margin = new Thickness(10, margin.Top, 10, 0), Padding = new Thickness(8, 5, 10, 5), CornerRadius = new CornerRadius(8), Background = Brushes.Transparent, Focusable = true, Cursor = SettingsUi.Hand };
        AutomationProperties.SetName(row, name);
        row.PointerReleased += (_, args) => { if (args.InitialPressMouseButton == MouseButton.Left) _ = SelectAsync(page); };
        row.KeyDown += (_, args) => { if (args.Key is Key.Enter or Key.Space) { _ = SelectAsync(page); args.Handled = true; } };
        rows[page] = row; return row;
    }
    private void Track(SettingsPage page, params TextBlock[] texts) { foreach (var text in texts) rowLabels.Add((page, text, text.Foreground!)); }
    // Mac sidebar selection: a violet rounded row with white title and subtitle.
    private void Highlight()
    {
        foreach (var (page, row) in rows) row.Background = page == selected ? SettingsUi.Violet : Brushes.Transparent;
        foreach (var (page, text, original) in rowLabels) text.Foreground = page == selected ? Brushes.White : original;
    }

    // ---- home state ----
    private static SettingsStatus Calm(SettingsPage page) => new(SettingsPageInfo.Detail(page));
    // The line and badge of each list row (Mac SettingsHomeState.status(for:)); the profile shows its own value.
    internal SettingsStatus ItemStatus(SettingsPage page) => page switch
    {
        SettingsPage.Ai => aiAnswered ? SettingsSummary.Ai(aiEntries) : Calm(page),
        SettingsPage.Terminals => SettingsSummary.Terminals(workspace.Terminals.State, workspace.Terminals.Terminals),
        SettingsPage.Features => features is null ? Calm(page) : SettingsSummary.Features(features),
        SettingsPage.Notifications => notifications is null ? Calm(page) : SettingsSummary.Notifications(notifications.Enabled ? NotificationState.Registered : NotificationState.Unregistered, failed: notifications.Error is not null),
        SettingsPage.Connection => new(ServerHost),
        SettingsPage.Display => new(DisplayChoiceText),
        SettingsPage.Update => update is { } known ? SettingsSummary.Update(known.Kind, known.Title) : Calm(page),
        SettingsPage.About => new(VersionText),
        SettingsPage.Stop => SettingsSummary.Stop(control, controlUnreadable),
        _ => Calm(page)
    };
    private string ServerHost { get { var value = Uri.TryCreate(workspace.Server, UriKind.Absolute, out var uri) ? uri.Host : ""; return value.Length == 0 ? LinuxStrings.FeatureEditor_InitializeAsync_7 : value; } }
    private static string VersionText => typeof(SettingsWindow).Assembly.GetName().Version?.ToString(3) ?? "-";
    private static string DisplayChoiceText { get { try { return new SettingsStore(SettingsStore.UserDirectory).Load().ConversationOpening == ConversationOpening.Fade ? LinuxStrings.SettingsEditors_DisplayChoiceText_1 : LinuxStrings.SettingsEditors_DisplayChoiceText_2; } catch (Exception) { return SettingsPageInfo.Detail(SettingsPage.Display); } } }

    private void RefreshRows()
    {
        foreach (var (page, (line, badge)) in rowStates)
        {
            var status = ItemStatus(page);
            line.Text = status.Line; badge.Content = status.Badge is { } text ? SettingsUi.Badge(text, status.Tone) : null;
        }
        attentionBand.Children.Clear();
        // Every item the Mac counts. The summary AI, 1Password and the rules have no row of their own here: their 要対応 opens the page that holds them.
        var items = new (string Title, SettingsPage Page, SettingsStatus Status)[]
        {
            (SettingsPageInfo.Title(SettingsPage.Ai), SettingsPage.Ai, ItemStatus(SettingsPage.Ai)),
            (LinuxStrings.SettingsEditors_RefreshRows_1, SettingsPage.Ai, SettingsSummary.SummaryAgent(backgroundAgent, modelCatalog)),
            (SettingsPageInfo.Title(SettingsPage.Terminals), SettingsPage.Terminals, ItemStatus(SettingsPage.Terminals)),
            ("1Password", SettingsPage.Features, SettingsSummary.OnePassword(features?.FirstOrDefault(item => item.Id == OnePasswordItem.Id))),
            (SettingsPageInfo.Title(SettingsPage.Notifications), SettingsPage.Notifications, ItemStatus(SettingsPage.Notifications)),
            (SettingsPageInfo.Title(SettingsPage.Features), SettingsPage.Features, ItemStatus(SettingsPage.Features)),
            (LinuxStrings.SettingsEditors_RefreshRows_2, SettingsPage.Profile, SettingsSummary.Rules(rulesText, rulesUnreadable)),
            (SettingsPageInfo.Title(SettingsPage.Update), SettingsPage.Update, ItemStatus(SettingsPage.Update)),
            (SettingsPageInfo.Title(SettingsPage.Stop), SettingsPage.Stop, ItemStatus(SettingsPage.Stop))
        };
        var attention = items.Where(item => item.Status.NeedsAttention && !HiddenPages.Contains(item.Page)).ToList();
        if (attention.Count == 0) return;
        attentionBand.Children.Add(SettingsUi.Text(LinuxStrings.SettingsEditors_RefreshRows_3, 12, SettingsUi.Secondary, FontWeight.SemiBold, new Thickness(20, 12, 0, 4)));
        foreach (var (title, page, status) in attention)
        {
            var grid = new Grid { ColumnDefinitions = new ColumnDefinitions("30,*,Auto") };
            var tile = SettingsUi.Tile(page, 30); tile.VerticalAlignment = VerticalAlignment.Center; grid.Children.Add(tile);
            var labels = new StackPanel { Margin = new Thickness(12, 0, 6, 0), VerticalAlignment = VerticalAlignment.Center };
            var name = SettingsUi.Text(title, 14, SettingsUi.Ink, FontWeight.Medium); name.TextWrapping = TextWrapping.NoWrap;
            var line = SettingsUi.Text(status.Line, 12, SettingsUi.Orange, null, new Thickness(0, 2, 0, 0)); line.TextWrapping = TextWrapping.NoWrap; line.TextTrimming = TextTrimming.CharacterEllipsis;
            labels.Children.Add(name); labels.Children.Add(line); Grid.SetColumn(labels, 1); grid.Children.Add(labels);
            if (status.Badge is { } text) { var badge = SettingsUi.Badge(text, status.Tone); Grid.SetColumn(badge, 2); grid.Children.Add(badge); }
            var row = new Border { Child = grid, Margin = new Thickness(10, 0, 10, 2), Padding = new Thickness(8, 5, 10, 5), CornerRadius = new CornerRadius(8), Background = new SolidColorBrush(Color.FromArgb(0x1A, 0xFF, 0x95, 0x00)), Focusable = true, Cursor = SettingsUi.Hand };
            AutomationProperties.SetName(row, title + " " + status.Line); AutomationProperties.SetAutomationId(row, "settings-attention-" + title);
            row.PointerReleased += (_, args) => { if (args.InitialPressMouseButton == MouseButton.Left) _ = SelectAsync(page); };
            row.KeyDown += (_, args) => { if (args.Key is Key.Enter or Key.Space) { _ = SelectAsync(page); args.Handled = true; } };
            attentionBand.Children.Add(row);
        }
        attentionBand.Children.Add(new Border { Height = 1, Background = SettingsUi.Hairline, Margin = new Thickness(20, 8, 20, 4) });
    }
    internal Control AttentionBand => attentionBand;

    // Opening settings and coming back to the front read every item; a read that arrives while one runs is done once more afterwards.
    // withAi false (leaving a page) skips the per-AI login reads.
    internal async Task ReloadHomeAsync(bool withAi = true)
    {
        if (homeReading) { homePending = true; return; }
        homeReading = true;
        try
        {
            do
            {
                homePending = false;
                await Task.WhenAll(withAi ? LoadAiAsync() : Task.CompletedTask, LoadSettingsAsync(), LoadModelsAsync(), LoadRulesAsync(), LoadControlAsync(), LoadUpdateAsync(), workspace.Terminals.RefreshAsync(Token));
                RefreshRows();
            } while (homePending && !Token.IsCancellationRequested);
        }
        catch (OperationCanceledException) when (Token.IsCancellationRequested) { }
        finally { homeReading = false; }
    }
    private void HostActivated(object? sender, EventArgs args) => _ = ReloadHomeAsync();
    private void UpdatesChanged() => Dispatcher.UIThread.Post(async () => { await LoadUpdateAsync(); RefreshRows(); });
    private void TerminalsChanged() => Dispatcher.UIThread.Post(RefreshRows);

    // Every harness, and Claude's accounts when /api/accounts lists them; each login read with its own GET like the AI page does. An AI that cannot run (a451) is not asked for its login.
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
        if (HarnessCliInstall.Ready(harness.Install))
        {
            try { progress = AuthenticationProgress.From((await auth.StatusAsync(harness.Id, Token, slot)).Auth, loaded: true, signedOut: signedOut); }
            catch (OperationCanceledException) when (Token.IsCancellationRequested) { throw; }
            catch (Exception) { /* unreadable: the entry says 確認できません */ }
        }
        return new AIAuthEntry(harness.Id, name, slot, progress) { AccountLabel = label, LimitLine = limitLine, SignedOut = signedOut, Install = harness.Install };
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

    private void NotificationsChanged(object? sender, System.ComponentModel.PropertyChangedEventArgs args) { if (args.PropertyName is nameof(INotificationSwitch.Enabled) or nameof(INotificationSwitch.Error)) Dispatcher.UIThread.Post(RefreshRows); }
    private void ShowControl(AiControl? value) { control = value; controlUnreadable = false; RefreshRows(); }
    private async Task LoadControlAsync()
    {
        try { control = (await workspace.Planning.AiControlAsync(Token)).Control; controlUnreadable = false; }
        catch (OperationCanceledException) when (Token.IsCancellationRequested) { throw; }
        catch (Exception) { controlUnreadable = control is null; }
    }

    private StackPanel NewPage(SettingsPage? page, bool scroll = true)
    {
        // Mac: card pages sit closer to the top than Form pages.
        var stack = new StackPanel { Margin = new Thickness(20, page is SettingsPage.Ai or SettingsPage.Features or SettingsPage.Billing ? 28 : 44, 20, 24), MaxWidth = 720 };
        if (page is { } known) stack.Children.Add(SettingsUi.Header(known));
        if (scroll) pane.Content = new ScrollViewer { Content = stack, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled };
        return stack;
    }
    private void SetToolbar(Control? left, string? title, Control? right) { toolbarLeft.Content = left; toolbarTitle.Text = title ?? ""; toolbarRight.Content = right; }
    // A page opened from inside a page (a feature, the summary AI): the toolbar gets a back control that returns to the category.
    private void ShowSubPage(string title, Control content, Action back)
    {
        inSubPage = true;
        var button = SettingsUi.Capsule("‹ " + SettingsPageInfo.Title(selected), Brushes.Transparent, SettingsUi.Violet, 8, 13, new Thickness(8, 4));
        button.Click += (_, _) => back();
        SetToolbar(button, title, null); pane.Content = content;
    }
    private void Reopen() { var page = selected; inSubPage = true; _ = SelectAsync(page); }
    private static string ErrorText(Exception error) => error is BellApiException { Status: not null } ? error.Message : LinuxStrings.EditorWindow_RunAsync_1(error.Message);
}
