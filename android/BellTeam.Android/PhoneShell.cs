using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.Templates;
using Avalonia.Input;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Threading;
using BellTeam.Core;
using BellTeam.Linux;
using Window = BellTeam.Linux.Window;

namespace BellTeam.Android;

// The phone shape of the Linux MainWindow (docs/android-architecture.md): one page at a time — the conversation list, then a conversation —
// over the same Workspace, startup views, rows and message cards. Sheets, settings and the separate windows arrive as pages in later steps.
public sealed class PhoneShell : UserControl, IMessageHost
{
    private readonly AccessSession access = new();
    private readonly ISessionTokenStore tokens = new KeystoreSessionTokenStore();
    private readonly LinuxWorkspace model;
    private readonly SettingsStore settings = new(SettingsStore.UserDirectory);
    private readonly Border startupHost = new() { IsVisible = false };
    // Sheets (forward, peer message) and the image gallery cover the page, like the Linux window's sheet and gallery.
    private readonly Grid sheetLayer = new() { Background = BellTheme.Canvas, IsVisible = false, RowDefinitions = new RowDefinitions("52,*") };
    private readonly TextBlock sheetTitle = new() { FontSize = 17, FontWeight = FontWeight.SemiBold, Foreground = BellTheme.Ink, VerticalAlignment = VerticalAlignment.Center, HorizontalAlignment = HorizontalAlignment.Center };
    private readonly ContentControl sheetBody = new();
    private readonly Button sheetSave = new() { Classes = { "plain" }, Background = BellTheme.ProminentFill, Foreground = Brushes.White, HorizontalAlignment = HorizontalAlignment.Right, Margin = new Thickness(0, 0, 12, 0), Padding = new Thickness(16, 6), IsVisible = false };
    private ISheetSave? sheetSaving;
    // The "windows" of the linked Linux screens (approvals, chart, graph) are pages of this stack: Window.Show pushes one, Window.Close pops it.
    private readonly Grid pageLayer = new() { Background = BellTheme.Canvas, IsVisible = false, RowDefinitions = new RowDefinitions("52,*") };
    private readonly TextBlock pageTitle = new() { FontSize = 17, FontWeight = FontWeight.SemiBold, Foreground = BellTheme.Ink, VerticalAlignment = VerticalAlignment.Center, HorizontalAlignment = HorizontalAlignment.Center };
    private readonly ContentControl pageBody = new();
    private readonly List<Window> pages = [];
    private readonly ApprovalsHub approvals;
    private readonly Button approvalsEntry = new() { Classes = { "plain" }, Background = Brushes.White, Foreground = BellTheme.Ink, Padding = new Thickness(14, 8) };
    private readonly Grid galleryLayer = new() { Background = Brushes.Black, IsVisible = false };
    private readonly TextBlock quoteName = new() { FontSize = 13, FontWeight = FontWeight.Bold, Foreground = BellTheme.Violet, TextTrimming = TextTrimming.CharacterEllipsis };
    private readonly TextBlock quoteText = new() { FontSize = 14, Foreground = BellTheme.Muted, TextTrimming = TextTrimming.CharacterEllipsis };
    private readonly Border quoteBar = new() { Background = new SolidColorBrush(Color.FromArgb(166, 0xE8, 0xE0, 0xFF)), CornerRadius = new CornerRadius(16), Padding = new Thickness(14, 6, 6, 6), Margin = new Thickness(0, 0, 0, 8), IsVisible = false };
    private readonly Border root = new() { Background = BellTheme.Canvas };
    private readonly StackPanel list = new();
    private readonly Dictionary<ChatTarget, ConversationRow> rows = [];
    private readonly TextBox search = new() { Classes = { "bare" }, FontSize = 16, PlaceholderText = "メンバー・ルームを検索", MinHeight = 44, VerticalContentAlignment = VerticalAlignment.Center };
    private readonly TextBlock title = new() { FontSize = 17, FontWeight = FontWeight.SemiBold, Foreground = BellTheme.Ink, VerticalAlignment = VerticalAlignment.Center, TextTrimming = TextTrimming.CharacterEllipsis };
    private readonly TextBlock status = new() { FontSize = 13, Foreground = BellTheme.Red, TextWrapping = TextWrapping.Wrap, IsVisible = false, Margin = new Thickness(12, 6) };
    private readonly Grid listPage = new() { RowDefinitions = new RowDefinitions("Auto,Auto,*"), Background = BellTheme.SidebarFill };
    private readonly Grid conversationPage = new() { RowDefinitions = new RowDefinitions("52,*,Auto"), Background = BellTheme.ConversationBackground, IsVisible = false };
    private readonly Grid settingsPage = new() { RowDefinitions = new RowDefinitions("52,*"), Background = BellTheme.ConversationBackground, IsVisible = false };
    private PhoneSettingsPage? settingsBody;
    private CancellationTokenSource? settingsLife;
    private readonly ScrollViewer messageScroll = new() { VerticalScrollBarVisibility = Avalonia.Controls.Primitives.ScrollBarVisibility.Auto };
    private readonly NewestColumn messageColumn = new();
    private bool unreadNew; // a row arrived while the reader was away from the newest
    // The same button as the Linux window (a471-latest-button-android): 最新へ when away from the newest, 新着メッセージ when a row arrived below; a tap returns to the newest and follows again.
    private readonly Button latest = new() { Classes = { "plain" }, Content = "最新へ ↓", HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Bottom, Margin = new Thickness(0, 0, 0, 12), Background = BellTheme.ProminentFill, Foreground = Brushes.White, IsVisible = false };
    private StackPanel? messageStack;
    private readonly TextBox composer = new() { Classes = { "bare" }, AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, MinHeight = 24, MaxHeight = 124, FontSize = 16, PlaceholderText = "メッセージ" };
    private readonly Button send = new() { Classes = { "plain" }, Content = "送信", Background = BellTheme.Violet, Foreground = Brushes.White, Padding = new Thickness(18, 10) };
    private readonly TextBlock sendError = new() { Foreground = BellTheme.Red, FontSize = 14, TextWrapping = TextWrapping.Wrap, IsVisible = false };
    private readonly Button edit;
    private readonly Button attach = new() { Classes = { "plain" }, Content = Icons.Draw(Icons.Paperclip, 22, BellTheme.Violet), Background = Brushes.Transparent, Width = 44, Height = 44, Padding = default, VerticalAlignment = VerticalAlignment.Bottom };
    private readonly StackPanel attachments = new() { Orientation = Orientation.Horizontal };
    private readonly ScrollViewer attachmentScroll = new() { VerticalScrollBarVisibility = Avalonia.Controls.Primitives.ScrollBarVisibility.Disabled, HorizontalScrollBarVisibility = Avalonia.Controls.Primitives.ScrollBarVisibility.Auto, IsVisible = false };
    private string attachmentKey = "";
    private StartupPhase phase = StartupPhase.Ready;
    private int generation, attempt;
    private CancellationTokenSource? retry;
    private bool syncingComposer, listQueued;

    public PhoneShell()
    {
        model = new LinuxWorkspace(origin => new BellApi(origin, cookies: access.Cookies) { SessionToken = tokens.Load(origin) }, access.PrepareAsync);
        approvals = new ApprovalsHub(model); approvals.Changed += UpdateApprovalsEntry;
        PushRegistration.Workspace = () => model; PushRouter.Changed += () => Dispatcher.UIThread.Post(RoutePush);
        Window.Pusher = PushPage; Window.Popper = PopPage;
        MarkdownView.LinkFailed = message => model.ReportActionError(message);
        // Links in messages and guides open in the system browser (there is no shell to execute an address on Android).
        ExternalLink.Opener = uri => MainActivity.Current.StartActivity(new global::Android.Content.Intent(global::Android.Content.Intent.ActionView, global::Android.Net.Uri.Parse(uri.AbsoluteUri)));
        var back = new Button { Classes = { "plain" }, Content = Icons.Draw(Icons.ChevronRight, 22, BellTheme.Ink), Background = Brushes.Transparent, RenderTransform = new ScaleTransform(-1, 1), Width = 52, Height = 52 };
        back.Click += (_, _) => ShowList();
        // A member's conversation has its edit form (profile, AI, schedules) as a page of the linked Linux screen.
        edit = new Button { Classes = { "plain" }, Content = Icons.Draw(Icons.Gear, 22, BellTheme.Ink), Background = Brushes.Transparent, Width = 52, Height = 52, IsVisible = false };
        edit.Click += (_, _) => ShowMemberEditor();
        var header = new Grid { ColumnDefinitions = new ColumnDefinitions("Auto,*,Auto"), Background = BellTheme.BandFill, Children = { back, title, edit } };
        Grid.SetColumn(title, 1); Grid.SetColumn(edit, 2);
        Grid.SetRow(header, 0);
        var settingsButton = new Button { Classes = { "plain" }, Content = Icons.Draw(Icons.Gear, 22, BellTheme.Ink), Background = Brushes.Transparent, Width = 48, Height = 48 };
        settingsButton.Click += (_, _) => ShowSettings();
        var searchBar = new Grid { ColumnDefinitions = new ColumnDefinitions("*,Auto"), Margin = new Thickness(12, 8), Children = { new Border { Background = Brushes.White, CornerRadius = new CornerRadius(12), Padding = new Thickness(12, 0), Child = search }, settingsButton } };
        Grid.SetColumn(settingsButton, 1);
        approvalsEntry.Click += (_, _) => ShowApprovals();
        var chart = SettingsUi.Capsule("工程表", Brushes.White, BellTheme.Ink, 12, 14, new Thickness(14, 8)); chart.Click += (_, _) => ShowLattice();
        var graph = SettingsUi.Capsule("相関図", Brushes.White, BellTheme.Ink, 12, 14, new Thickness(14, 8)); graph.Click += (_, _) => ShowWorkGraph();
        var entries = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, Margin = new Thickness(12, 0, 12, 8), Children = { approvalsEntry, chart, graph } };
        var barAndEntries = new StackPanel { Children = { searchBar, entries } };
        listPage.Children.Add(barAndEntries); Grid.SetRow(status, 1); listPage.Children.Add(status);
        var scroll = new ScrollViewer { Content = list }; Grid.SetRow(scroll, 2); listPage.Children.Add(scroll);
        search.TextChanged += (_, _) => model.Search = search.Text ?? "";

        var messages = new ItemsControl { ItemsSource = model.Messages, ItemTemplate = new FuncDataTemplate<MessageItem>((item, _) => new MessageCard(item, model)) };
        messageScroll.ScrollChanged += (_, args) => { ShowLatestButton(); NoteScrollUp(args); FillScreen(); };
        messageScroll.PropertyChanged += (_, args) => { if (args.Property == ScrollViewer.ViewportProperty) { messageColumn.MinHeight = messageScroll.Viewport.Height; FillScreen(); } };
        messageStack = new StackPanel { VerticalAlignment = VerticalAlignment.Bottom, Margin = new Thickness(12, 12), Children = { messages } };
        messageStack.PropertyChanged += (_, args) => { if (args.Property == BoundsProperty) FillScreen(); };
        messageColumn.Children.Add(messageStack); messageScroll.Content = messageColumn;
        Grid.SetRow(messageScroll, 1); Grid.SetRow(latest, 1);
        latest.Click += (_, _) => { unreadNew = false; messageColumn.FollowNewest(); latest.IsVisible = false; }; Avalonia.Automation.AutomationProperties.SetName(latest, "最新へ");
        composer.TextChanged += (_, _) => { if (syncingComposer) return; syncingComposer = true; try { model.DraftText = composer.Text ?? ""; } finally { syncingComposer = false; } };
        send.Click += (_, _) => _ = model.SendAsync();
        attachmentScroll.Content = attachments;
        attach.Click += async (_, _) => await AttachAsync();
        var input = new Grid { ColumnDefinitions = new ColumnDefinitions("Auto,*,Auto"), Children = { attach, composer, send } };
        Grid.SetColumn(composer, 1); composer.Margin = new Thickness(0, 4, 8, 4); Grid.SetColumn(send, 2); send.VerticalAlignment = VerticalAlignment.Bottom;
        var pill = new Border { Background = BellTheme.Canvas, BorderBrush = BellTheme.Line, BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(24), Padding = new Thickness(14, 4, 6, 4), Child = input };
        var cancelQuote = new Button { Classes = { "plain" }, Width = 40, Height = 40, Padding = default, CornerRadius = new CornerRadius(20), Background = Brushes.Transparent, Content = Icons.Draw(Icons.Close, 16, BellTheme.Muted) };
        cancelQuote.Click += (_, _) => model.CancelQuote(); Grid.SetColumn(cancelQuote, 1);
        quoteBar.Child = new Grid { ColumnDefinitions = new ColumnDefinitions("*,Auto"), Children = { new StackPanel { VerticalAlignment = VerticalAlignment.Center, Children = { quoteName, quoteText } }, cancelQuote } };
        var band = new Border { Background = BellTheme.BandFill, Child = new StackPanel { Margin = new Thickness(12, 8), Children = { sendError, attachmentScroll, quoteBar, pill } } };
        Grid.SetRow(band, 2);
        conversationPage.Children.Add(header); conversationPage.Children.Add(messageScroll); conversationPage.Children.Add(latest); conversationPage.Children.Add(band);

        var settingsBack = new Button { Classes = { "plain" }, Content = Icons.Draw(Icons.ChevronRight, 22, BellTheme.Ink), Background = Brushes.Transparent, RenderTransform = new ScaleTransform(-1, 1), Width = 52, Height = 52 };
        settingsBack.Click += (_, _) => ShowList();
        var settingsHeader = new Grid { ColumnDefinitions = new ColumnDefinitions("Auto,*"), Background = BellTheme.BandFill, Children = { settingsBack, new TextBlock { Text = "設定", FontSize = 17, FontWeight = FontWeight.SemiBold, Foreground = BellTheme.Ink, VerticalAlignment = VerticalAlignment.Center } } };
        Grid.SetColumn(settingsHeader.Children[1], 1); settingsPage.Children.Add(settingsHeader);
        var pageHost = new Grid { Children = { listPage, conversationPage, settingsPage } };
        var column = new Grid { RowDefinitions = new RowDefinitions("*,Auto"), Children = { pageHost } };
        var closeSheet = new Button { Classes = { "plain" }, Content = Icons.Draw(Icons.Close, 20, BellTheme.Ink), Background = Brushes.Transparent, Width = 52, Height = 52, HorizontalAlignment = HorizontalAlignment.Left };
        closeSheet.Click += (_, _) => CloseSheet();
        sheetSave.Click += (_, _) => { if (sheetSaving is { CanSave: true } save) _ = save.SaveAsync(); };
        sheetLayer.Children.Add(new Grid { Background = BellTheme.BandFill, Children = { sheetTitle, closeSheet, sheetSave } }); Grid.SetRow(sheetBody, 1); sheetLayer.Children.Add(sheetBody);
        var pageBack = new Button { Classes = { "plain" }, Content = Icons.Draw(Icons.ChevronRight, 22, BellTheme.Ink), Background = Brushes.Transparent, RenderTransform = new ScaleTransform(-1, 1), Width = 52, Height = 52 };
        pageBack.Click += (_, _) => GoBackPage();
        var pageHeader = new Grid { ColumnDefinitions = new ColumnDefinitions("Auto,*"), Background = BellTheme.BandFill, Children = { pageBack, pageTitle } }; Grid.SetColumn(pageTitle, 1);
        pageLayer.Children.Add(pageHeader); Grid.SetRow(pageBody, 1); pageLayer.Children.Add(pageBody);
        root.Child = new Grid { Children = { column, pageLayer, startupHost, sheetLayer, galleryLayer } };
        Content = root;

        model.PropertyChanged += (_, args) => Dispatcher.UIThread.Post(() => ModelChanged(args.PropertyName));
        model.Entries.CollectionChanged += (_, _) => QueueListRebuild();
        // a471-open-newest-linux: the newest row is the anchor (NewestColumn, shared with the Linux window): opening or sending asks to be at the newest; a row that arrives there is at the newest in the same layout pass, one that arrives while the reader reads older rows leaves the view where it is.
        model.ScrollToBottom += force =>
        {
            if (force) messageColumn.FollowNewest();
            else if (!messageColumn.Following) { unreadNew = true; ShowLatestButton(); }
        };
        model.ThisPc = new NoThisPc();
        // A field that gets focus scrolls into view once the keyboard has taken its space.
        AddHandler(GotFocusEvent, (_, e) => { if (e.Source is TextBox box) { Dispatcher.UIThread.Post(() => Reveal(box), DispatcherPriority.Background); DispatcherTimer.RunOnce(() => Reveal(box), TimeSpan.FromMilliseconds(350)); } });
        AttachedToVisualTree += (_, _) => Attached();
        Loaded += (_, _) => _ = BeginAfterAccountAsync();
    }

    // The whole field plus some room under it, not only the caret line, so the field and the button below it are not left under the keyboard.
    private static void Reveal(Control? field) => field?.BringIntoView(new Rect(0, 0, field.Bounds.Width, field.Bounds.Height + 140));

    private void Attached()
    {
        if (TopLevel.GetTopLevel(this) is not { } top) return;
        // The soft keyboard covers the bottom of the page: lift the page by the height it occupies so the focused field stays visible.
        if (top.InputPane is { } pane) pane.StateChanged += (_, e) =>
        {
            root.Margin = new Thickness(0, 0, 0, e.NewState == Avalonia.Controls.Platform.InputPaneState.Open ? e.EndRect.Height : 0);
            DispatcherTimer.RunOnce(() => Reveal(top.FocusManager?.GetFocusedElement() as Control), TimeSpan.FromMilliseconds(150));
        };
        top.BackRequested += (_, e) =>
        {
            if (galleryLayer.IsVisible) { CloseGallery(); e.Handled = true; }
            else if (sheetLayer.IsVisible) { CloseSheet(); e.Handled = true; }
            else if (pages.Count != 0) { GoBackPage(); e.Handled = true; }
            else if (conversationPage.IsVisible || settingsPage.IsVisible) { ShowList(); e.Handled = true; }
        };
    }

    // First run order (app-sessions.md 7e): the account (this phone's own Play purchase, or the QR answered by a paying phone, contract 1.36 s10) comes before any server. A phone whose purchase or kept period holds goes
    // straight on; when the form is not configured (LocalFormIds) or Play cannot be asked, the app goes on too: an unknown state is not a reason to stop.
    private async Task BeginAfterAccountAsync()
    {
        if (AccountStore.Local is not { } local) { Begin(); return; }
        try
        {
            if (local.PaidUntil() is not null || (await local.OwnPurchasesAsync()).Any(purchase => purchase.Products.Contains(LocalFormIds.ProductId))) { Begin(); return; }
        }
        catch (Kitepon.LoginBilling.LoginBillingException) { Begin(); return; }
        startupHost.Child = new AccountGate(() => Begin(), CancellationToken.None); startupHost.IsVisible = true;
    }

    private void Begin()
    {
        var saved = settings.Load().ServerUrl;
        if (StartupRoute.Initial(saved, signedIn: true) != StartupPhase.Checking) ShowStartup(StartupPhase.Setup); else _ = ConnectAsync(saved!);   // the account gate has run before Begin
    }

    // ---- the pages of the linked screens ----
    private void ShowMemberEditor()
    {
        if (model.Selected is not { IsMember: true } member) return;
        var window = new MemberEditorWindow(model, member.Target.Id);
        window.Show(); _ = window.InitializeAsync();
    }
    private void ShowDetailedSettings() => _ = ShowDetailedSettingsAsync(null);
    private async Task ShowDetailedSettingsAsync(BellTeam.Linux.SettingsPage? open)
    {
        if (!model.Connected) return;
        var window = new SettingsWindow(model, () => { CloseAllPages(); ShowStartup(StartupPhase.Setup); }, new StoredNotificationSwitch(settings), async () => { CloseAllPages(); await PushRegistration.UnregisterAsync(model); access.SignOut(); ShowList(); model.SignOut(); },
            // The app draws these itself (Google Play rows, the sign-in, the version); notifications are desktop (freedesktop) only.
            [BellTeam.Linux.SettingsPage.Connection, BellTeam.Linux.SettingsPage.Billing, BellTeam.Linux.SettingsPage.About, BellTeam.Linux.SettingsPage.Notifications]);
        window.Show(); await window.InitializeAsync();
        if (open is { } page) await window.SelectAsync(page);
    }

    private void PushPage(Window window)
    {
        if (pages.Contains(window)) return;
        // The screens were drawn for a desktop window: here they fill the page.
        window.Width = window.Height = double.NaN; window.MinWidth = window.MinHeight = 0; window.MaxWidth = window.MaxHeight = double.PositiveInfinity;
        pages.Add(window); ShowTopPage();
    }
    private void PopPage(Window window) { pages.Remove(window); ShowTopPage(); }
    private void ShowTopPage()
    {
        UpdateViewing();
        if (pages.Count == 0) { pageBody.Content = null; pageLayer.IsVisible = false; return; }
        var top = pages[^1]; pageTitle.Text = top.Title ?? ""; pageBody.Content = top; pageLayer.IsVisible = true;
    }
    private void GoBackPage() { if (pages.Count == 0) return; var top = pages[^1]; if (top is IPageBack back && back.GoBack()) return; top.Close(); }
    private void CloseAllPages() { foreach (var window in pages.ToArray()) window.Close(); }

    private void ShowApprovals(string? decisionId = null)
    {
        if (!model.Connected) return;
        var window = ApprovalsWindow.Open(approvals, model, (project, card) => ShowLattice()?.OpenCard(project, card), botId => _ = OpenChatAsync(botId, "決裁のメンバーの会話が見つかりません。メンバーとルームの一覧を更新してください。"));
        window.Compact = true; window.Show(); if (decisionId is not null) window.Select(decisionId);
    }
    private LatticeWindow? ShowLattice()
    {
        if (!model.Connected) return null;
        var window = LatticeWindow.Open(model, botId => OpenChatAsync(botId, "工程表のメンバーの会話が見つかりません。メンバーとルームの一覧を更新してください。"), id => ShowApprovals(id));
        LatticeWindow.Compact = true; window.Show(); return window;
    }
    private void ShowWorkGraph()
    {
        if (!model.Connected) return;
        WorkGraphWindow.Open(model, botId => OpenChatAsync(botId, "相関図のメンバーの会話が見つかりません。メンバーとルームの一覧を更新してください。")).Show();
    }
    // A member's chat opens over the pages, as from a notification.
    private async Task OpenChatAsync(string botId, string missing)
    {
        var entry = model.Conversations.FirstOrDefault(item => item.Target == new ChatTarget(botId, false));
        if (entry is null) { model.ReportActionError(missing); return; }
        CloseAllPages(); ShowConversation(); await model.SelectAsync(entry);
    }
    private void UpdateApprovalsEntry()
    {
        var view = Approvals.EntryView(approvals.Feed?.Summary, approvals.Feed?.Failure);
        approvalsEntry.Content = view.Pending > 0 ? $"決裁箱 {view.Pending}" : "決裁箱"; approvalsEntry.IsEnabled = model.Connected;
        Avalonia.Automation.AutomationProperties.SetName(approvalsEntry, view.Label);
    }

    private void UpdateQuoteBar()
    {
        var quote = model.Quote;
        quoteBar.IsVisible = quote is not null;
        if (quote is null) return;
        quoteName.Text = (quote.SenderName ?? "") + (quote.Part ? "の発言の一部への返信" : "への返信"); quoteText.Text = Timeline.QuoteBody(quote).ReplaceLineEndings(" ");
        composer.Focus();
    }

    // The system picker hands over content URIs, not paths: each chosen image is copied to the app's cache and attached from there (Workspace reads files by path).
    private async Task AttachAsync()
    {
        if (TopLevel.GetTopLevel(this) is not { } top) return;
        try
        {
            var files = await top.StorageProvider.OpenFilePickerAsync(new Avalonia.Platform.Storage.FilePickerOpenOptions { Title = "画像を添付", AllowMultiple = true, FileTypeFilter = [Avalonia.Platform.Storage.FilePickerFileTypes.ImageAll] });
            var paths = new List<string>();
            foreach (var file in files)
            {
                var path = Path.Combine(Path.GetTempPath(), $"{Guid.NewGuid():N}-{file.Name}");
                await using (var source = await file.OpenReadAsync()) await using (var target = File.Create(path)) await source.CopyToAsync(target);
                paths.Add(path);
            }
            if (paths.Count != 0) await model.AttachFilesAsync(paths.ToArray());
        }
        catch (Exception error) { model.ReportDraftError("画像を添付できませんでした。" + error.Message); }
    }

    private void UpdateAttachments()
    {
        attach.IsEnabled = model.CanAttach;
        var previews = model.Attachments; var key = string.Join('|', previews.Select(item => item.Data.GetHashCode()));
        attachmentScroll.IsVisible = previews.Length != 0;
        if (key == attachmentKey) return;
        attachmentKey = key; attachments.Children.Clear();
        foreach (var item in previews)
        {
            var remove = new Button { Classes = { "plain" }, Width = 24, Height = 24, Padding = default, CornerRadius = new CornerRadius(12), Background = new SolidColorBrush(Color.Parse("#BF21293D")), BorderBrush = Brushes.White, BorderThickness = new Thickness(1.5), HorizontalAlignment = HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Top, Content = Icons.Draw(Icons.Close, 10, Brushes.White) };
            var data = item.Data; remove.Click += (_, _) => model.RemoveAttachment(data);
            var tile = new Border { CornerRadius = new CornerRadius(12), ClipToBounds = true, Width = 64, Height = 64, Child = new Image { Source = item.Preview, Stretch = Stretch.UniformToFill } };
            attachments.Children.Add(new Grid { Margin = new Thickness(0, 4, 10, 8), Width = 64, Height = 64, Children = { tile, remove } });
        }
    }

    // ---- IMessageHost: the cards of the conversation ask the shell for these ----
    // A sheet that saves (the forward sheet's 転送) shows its own button label in the header and enables it as the sheet says.
    public void OpenSheet(string heading, Control content)
    {
        CloseSheet();
        sheetTitle.Text = heading; sheetBody.Content = content; sheetLayer.IsVisible = true;
        if (content is ISheetSave save) { sheetSaving = save; save.CanSaveChanged += SheetSaveChanged; sheetSave.IsVisible = true; SheetSaveChanged(); }
    }
    private void SheetSaveChanged() { if (sheetSaving is { } save) { sheetSave.IsEnabled = save.CanSave; sheetSave.Content = save.SaveLabel; } }
    public void CloseSheet()
    {
        if (sheetSaving is { } save) save.CanSaveChanged -= SheetSaveChanged;
        sheetSaving = null; sheetSave.IsVisible = false; sheetBody.Content = null; sheetLayer.IsVisible = false;
    }
    public DestinationSheet ShowForwardSheet(TimelineMessage message) { CloseSheet(); var view = DestinationSheet.Forward(model, message, CloseSheet); OpenSheet("転送", view); return view; }
    public void ShowPeerSheet(TimelineMessage message) { CloseSheet(); OpenSheet("メンバー間の連絡", new PeerMessageView(model, message)); }
    public ImageGallery ShowGallery(string[] paths, int initial)
    {
        galleryLayer.Children.Clear();
        var gallery = new ImageGallery(model, paths, initial, CloseGallery); galleryLayer.Children.Add(gallery); galleryLayer.IsVisible = true;
        return gallery;
    }
    private void CloseGallery() { galleryLayer.Children.Clear(); galleryLayer.IsVisible = false; }

    private void ShowList() { conversationPage.IsVisible = false; settingsPage.IsVisible = false; listPage.IsVisible = true; EndSettings(); UpdateViewing(); }
    private void ShowConversation() { listPage.IsVisible = false; settingsPage.IsVisible = false; conversationPage.IsVisible = true; UpdateViewing(); }
    // A notification for the conversation on screen shows no banner (iOS rule); anything over it (a page, a sheet) is not that conversation.
    private void UpdateViewing() => PushRouter.Viewing = conversationPage.IsVisible && pages.Count == 0 && model.Selected is { } entry ? entry.Target : null;

    // A tap on a notification (or a message that arrived before the connection): open its conversation once connected; another server's message is dropped.
    private async void RoutePush()
    {
        if (!model.Connected) return;
        var target = PushRouter.Take();
        if (target is null) return;
        if (!PushRouter.IsCurrentServer(target.Server)) return;
        // The update notice (kind update): the Update page of the settings, nothing is updated by itself.
        if (target.Kind == "update") { CloseAllPages(); CloseSheet(); await ShowDetailedSettingsAsync(BellTeam.Linux.SettingsPage.Update); return; }
        if (target.Conversation is not { } conversation) return;
        var entry = model.Conversations.FirstOrDefault(item => item.Target == conversation);
        if (entry is null) { model.ReportActionError("通知の会話が見つかりません。メンバーとルームの一覧を更新してください。"); return; }
        CloseAllPages(); CloseSheet(); ShowConversation(); await model.SelectAsync(entry);
    }
    private void ShowSettings()
    {
        if (!model.Connected) { ShowStartup(StartupPhase.Setup); return; }
        EndSettings();
        settingsLife = CancellationTokenSource.CreateLinkedTokenSource(model.ConnectionToken);
        settingsBody = new PhoneSettingsPage(model, () => ShowStartup(StartupPhase.Setup), async () => { await PushRegistration.UnregisterAsync(model); access.SignOut(); ShowList(); model.SignOut(); }, ShowDetailedSettings, settingsLife.Token); Grid.SetRow(settingsBody, 1); settingsPage.Children.Add(settingsBody);
        listPage.IsVisible = false; conversationPage.IsVisible = false; settingsPage.IsVisible = true;
    }
    // The page's reads end when it is left.
    private void EndSettings() { settingsLife?.Cancel(); settingsLife = null; if (settingsBody is not null) { settingsPage.Children.Remove(settingsBody); settingsBody = null; } }

    // a471-linux-android-older-button: there is no button; older pages are read from the scroll motion (machine-stream.md "History pages of a long stream", the same spec and the same
    // HistoryPaging as the Linux window): while less than max(1 screen, 2 s of the scroll speed) of drawn height is above the view (the open reads one only while the drawn rows do not fill one screen). Fullness is what is drawn (the Fill rule): a page of folded rows draws almost nothing but still adds rows, so it does not end the loop. A failed page leaves its error and the next scroll movement asks again.
    private double scrollSpeed; private long lastScrollUp; private bool loadingOlder, prefetching;
    private void NoteScrollUp(ScrollChangedEventArgs args)
    {
        if (args.OffsetDelta.Y >= 0 || args.ExtentDelta.Y != 0) return;   // a move that comes with an extent change is the anchor or a new row, not the Owner's
        var now = Environment.TickCount64; var seconds = Math.Max(0.016, (now - lastScrollUp) / 1000.0);
        scrollSpeed = (ScrollSpeed - args.OffsetDelta.Y / seconds) / 2; lastScrollUp = now;
    }
    private double ScrollSpeed => Environment.TickCount64 - lastScrollUp < 500 ? scrollSpeed : 0;
    private void ShowLatestButton()
    {
        var atBottom = messageScroll.Extent.Height - messageScroll.Viewport.Height - messageScroll.Offset.Y < 80;
        if (atBottom) unreadNew = false;
        latest.Content = unreadNew ? "新着メッセージ ↓" : "最新へ ↓";
        latest.IsVisible = !(atBottom && !unreadNew) && model.HasSelection && model.Messages.Count != 0;
    }
    private bool CanReadOlder() => model.HasSelection && model.HasMore && !model.Loading;
    private void FillScreen() => _ = PrefetchOlderAsync();
    private async Task PrefetchOlderAsync()
    {
        if (loadingOlder || prefetching) return;
        prefetching = true;
        try
        {
            while (CanReadOlder() && NeedsOlder())
            {
                var before = model.Messages.Count;
                await LoadOlderPreservingPositionAsync();
                await Dispatcher.UIThread.InvokeAsync(() => { }, DispatcherPriority.Background);   // the new rows are laid out and input is handled before the next page
                if (model.Messages.Count == before) break;
            }
        }
        finally { prefetching = false; }
    }
    // At the newest (the open, nothing scrolled) an older page is read only while the drawn rows do not fill one screen; once the reader scrolls up, the margin rule applies (machine-stream.md "Fill rule").
    private bool NeedsOlder() => messageColumn.Following
        ? HistoryPaging.NeedsFirstScreen(messageStack?.Bounds.Height ?? 0, messageScroll.Viewport.Height)
        : HistoryPaging.NeedsOlderPage(messageScroll.Offset.Y, messageScroll.Viewport.Height, ScrollSpeed);
    private async Task LoadOlderPreservingPositionAsync()
    {
        if (loadingOlder) return;
        loadingOlder = true; var count = model.Messages.Count;
        // a471-scroll-jump: the rows are added above the view and the scroll view's anchor (each MessageCard registers) keeps the row being looked at where it is, whatever the Owner scrolled while the page was on its way.
        try { await model.LoadOlderAsync(); messageScroll.UpdateLayout(); }
        finally { loadingOlder = false; }
        if (model.Messages.Count != count) FillScreen();
    }

    private void ModelChanged(string? name)
    {
        switch (name)
        {
            case nameof(LinuxWorkspace.Connected): UpdateApprovalsEntry(); if (model.Connected) { approvals.Sync(); PushRouter.CurrentServer = model.Server; _ = PushRegistration.RegisterAsync(model); RoutePush(); } break;
            case nameof(LinuxWorkspace.Selected): unreadNew = false; title.Text = model.Selected?.Name ?? ""; edit.IsVisible = model.Selected is { IsMember: true }; UpdateViewing(); break;
            case nameof(LinuxWorkspace.Quote): UpdateQuoteBar(); break;
            case nameof(LinuxWorkspace.Attachments) or nameof(LinuxWorkspace.CanAttach): UpdateAttachments(); break;
            case nameof(LinuxWorkspace.NeedsLogin):
                if (!model.NeedsLogin || phase == StartupPhase.SignIn) break;
                ShowStartup(StartupPhase.SignIn); break;
            case nameof(LinuxWorkspace.ConnectionError) or nameof(LinuxWorkspace.ActionError): { var text = model.ActionError ?? model.ConnectionError; status.Text = text; status.IsVisible = !string.IsNullOrEmpty(text); break; }
            case nameof(LinuxWorkspace.Loading): if (!model.Loading && !loadingOlder) Dispatcher.UIThread.Post(async () => await PrefetchOlderAsync(), DispatcherPriority.Background); break;
            case nameof(LinuxWorkspace.SendError): sendError.Text = model.SendError; sendError.IsVisible = !string.IsNullOrEmpty(model.SendError); break;
            case nameof(LinuxWorkspace.DraftText): if (!syncingComposer) { syncingComposer = true; try { composer.Text = model.DraftText; } finally { syncingComposer = false; } } break;
            case nameof(LinuxWorkspace.CanSend) or nameof(LinuxWorkspace.SendLabel): send.IsEnabled = model.CanSend; send.Content = model.SendLabel; break;
        }
    }

    private void QueueListRebuild()
    {
        if (listQueued) return; listQueued = true;
        Dispatcher.UIThread.Post(() => { listQueued = false; RebuildList(); }, DispatcherPriority.Background);
    }
    private void RebuildList()
    {
        list.Children.Clear();
        string? group = null;
        foreach (var entry in model.Entries)
        {
            if (entry.Group != group) { group = entry.Group; list.Children.Add(BellTheme.Text(group, 13, BellTheme.Muted, FontWeight.SemiBold, new Thickness(18, 12, 0, 2))); }
            if (!rows.TryGetValue(entry.Target, out var row)) rows[entry.Target] = row = new ConversationRow(model, entry, Select); else row.Update(entry);
            list.Children.Add(row);
        }
    }
    private async void Select(ConversationEntry entry)
    {
        ShowConversation();
        if (model.Selected?.Target != entry.Target) await model.SelectAsync(entry);
    }

    // ---- startup: the phases of the Linux MainWindow, without its separate windows ----
    private void ShowStartup(StartupPhase next, string? message = null, SetupState? setup = null)
    {
        phase = next;
        if (next != StartupPhase.Failure) { retry?.Cancel(); retry = null; }
        (startupHost.Child as IDisposable)?.Dispose(); (startupHost.Child as AccessLoginPage)?.End();
        startupHost.Child = next switch
        {
            StartupPhase.Ready => null,
            StartupPhase.Checking => new StartupOpeningView(),
            StartupPhase.Failure => new StartupFailureView(message, () => _ = ConnectAsync(model.Server), () => ShowStartup(StartupPhase.Setup)),
            StartupPhase.Setup => new ServerSetupView(ConnectToAddress, () => { }, model.Server),
            StartupPhase.Paywall => new PaywallView(() => _ = ConnectAsync(model.Server), () => ShowStartup(StartupPhase.Setup)),
            StartupPhase.SignIn => model.SessionLoginRequired ? SessionSignIn() : new AccessLoginPage(access, ServerOrigin.Parse(model.Server), () => _ = ConnectAsync(model.Server), () => ShowStartup(StartupPhase.Setup)),
            _ => new OnboardingView(new SetupApi(model.Management.Api), setup!, async ready => { await model.ReconnectAsync(); await EnterAsync(generation, ready); }, () => ShowStartup(StartupPhase.Setup), model.ConnectionToken)
        };
        startupHost.IsVisible = next != StartupPhase.Ready;
    }
    // a485: the server's own login (the code screen); the token it refused is deleted, a token it merely could not judge (503) never reaches here.
    private Control SessionSignIn()
    {
        var origin = ServerOrigin.Parse(model.Server); tokens.Clear(origin);
        return new ConnectView(new LoginApi(model.Management.Api), "android", origin, tokens, () => _ = ConnectAsync(model.Server), () => ShowStartup(StartupPhase.Setup));
    }
    private async void ConnectToAddress(string text)
    {
        var origin = ServerOrigin.Parse(text);
        settings.Save(settings.Load() with { ServerUrl = origin.AbsoluteUri });
        await PushRegistration.UnregisterAsync(model); // the old server's connection is still open here
        model.SignOut();
        _ = ConnectAsync(origin.AbsoluteUri);
    }
    private async Task ConnectAsync(string address, bool automatic = false)
    {
        retry?.Cancel();
        var mine = ++generation;
        if (!(automatic && phase == StartupPhase.Failure)) ShowStartup(StartupPhase.Checking);
        try
        {
            ServerOrigin.Parse(address);   // a bad address throws before the connection starts
            await model.ConnectAsync(address);
            await EnterAsync(mine);
        }
        catch (ArgumentException error) { if (mine == generation) ShowStartup(StartupPhase.Failure, error.Message); }
    }
    private async Task EnterAsync(int mine, SetupState? known = null)
    {
        var setup = known; var failure = model.ConnectionError;
        if (setup is null && model.Connected && !model.NeedsLogin)
            try { setup = await new SetupApi(model.Management.Api).StatusAsync(model.ConnectionToken); }
            catch (OperationCanceledException) when (model.ConnectionToken.IsCancellationRequested) { return; }
            catch (Exception error) { failure = error.Message; }
        // a485 7e: the paywall is the server's entitlement answer, read once per entry (a failed read shows the app).
        var paywalled = setup is not null && await new SubscriptionApi(model.Management.Api).PaywalledAsync(model.ConnectionToken);
        if (mine != generation) return;
        var route = StartupRoute.AfterConnect(model.NeedsLogin, model.Connected, setup, paywalled);
        if (route != StartupPhase.Failure) attempt = 0;
        switch (route)
        {
            case StartupPhase.Ready: ShowStartup(StartupPhase.Ready); ShowList(); break;
            case StartupPhase.Onboarding: ShowStartup(StartupPhase.Onboarding, setup: setup); break;
            case StartupPhase.SignIn: ShowStartup(StartupPhase.SignIn); break;
            case StartupPhase.Paywall: ShowStartup(StartupPhase.Paywall); break;
            default: ShowStartup(StartupPhase.Failure, failure); if (model.ConnectionRetryable) ScheduleRetry(mine); break;
        }
    }
    // The failure page leaves by itself with the Core backoff (no attempt limit); a new connection or page cancels it.
    private void ScheduleRetry(int mine)
    {
        retry?.Cancel(); var source = retry = new CancellationTokenSource(); var step = attempt++;
        _ = Run();
        async Task Run()
        {
            try { await model.RetryDelayAsync(step, source.Token); } catch (OperationCanceledException) { return; }
            if (source.IsCancellationRequested || mine != generation || phase != StartupPhase.Failure) return;
            await ConnectAsync(model.Server, automatic: true);
        }
    }
}
