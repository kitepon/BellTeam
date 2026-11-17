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
    private SettingsPage? settingsBody;
    private CancellationTokenSource? settingsLife;
    private readonly ScrollViewer messageScroll = new() { VerticalScrollBarVisibility = Avalonia.Controls.Primitives.ScrollBarVisibility.Auto };
    private readonly TextBox composer = new() { Classes = { "bare" }, AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, MinHeight = 24, MaxHeight = 124, FontSize = 16, PlaceholderText = "メッセージ" };
    private readonly Button send = new() { Classes = { "plain" }, Content = "送信", Background = BellTheme.Violet, Foreground = Brushes.White, Padding = new Thickness(18, 10) };
    private readonly TextBlock sendError = new() { Foreground = BellTheme.Red, FontSize = 14, TextWrapping = TextWrapping.Wrap, IsVisible = false };
    private readonly Button older = new() { Classes = { "plain" }, Content = "以前のメッセージを読む", HorizontalAlignment = HorizontalAlignment.Center, Background = Brushes.White, IsVisible = false };
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
        model = new LinuxWorkspace(origin => new BellApi(origin, cookies: access.Cookies), access.PrepareAsync);
        approvals = new ApprovalsHub(model); approvals.Changed += UpdateApprovalsEntry;
        Window.Pusher = PushPage; Window.Popper = PopPage;
        MarkdownView.LinkFailed = message => model.ReportActionError(message);
        // Links in messages and guides open in the system browser (there is no shell to execute an address on Android).
        ExternalLink.Opener = uri => MainActivity.Current.StartActivity(new global::Android.Content.Intent(global::Android.Content.Intent.ActionView, global::Android.Net.Uri.Parse(uri.AbsoluteUri)));
        var back = new Button { Classes = { "plain" }, Content = Icons.Draw(Icons.ChevronRight, 22, BellTheme.Ink), Background = Brushes.Transparent, RenderTransform = new ScaleTransform(-1, 1), Width = 52, Height = 52 };
        back.Click += (_, _) => ShowList();
        var header = new Grid { ColumnDefinitions = new ColumnDefinitions("Auto,*"), Background = BellTheme.BandFill, Children = { back, title } };
        Grid.SetColumn(title, 1);
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
        older.Click += async (_, _) => await model.LoadOlderAsync();
        messageScroll.Content = new StackPanel { VerticalAlignment = VerticalAlignment.Bottom, Margin = new Thickness(12, 12), Children = { older, messages } };
        Grid.SetRow(messageScroll, 1);
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
        conversationPage.Children.Add(header); conversationPage.Children.Add(messageScroll); conversationPage.Children.Add(band);

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
        model.ScrollToBottom += force => Dispatcher.UIThread.Post(() => messageScroll.ScrollToEnd());
        model.ThisPc = new NoThisPc();
        // A field that gets focus scrolls into view once the keyboard has taken its space.
        AddHandler(GotFocusEvent, (_, e) => { if (e.Source is TextBox box) { Dispatcher.UIThread.Post(() => Reveal(box), DispatcherPriority.Background); DispatcherTimer.RunOnce(() => Reveal(box), TimeSpan.FromMilliseconds(350)); } });
        AttachedToVisualTree += (_, _) => Attached();
        Loaded += (_, _) => Begin();
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

    private void Begin()
    {
        var saved = settings.Load().ServerUrl;
        if (StartupRoute.Initial(saved) == StartupPhase.Setup) ShowStartup(StartupPhase.Setup); else _ = ConnectAsync(saved!);
    }

    // ---- the pages of the linked screens ----
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
        window.Show(); return window;
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

    private void ShowList() { conversationPage.IsVisible = false; settingsPage.IsVisible = false; listPage.IsVisible = true; EndSettings(); }
    private void ShowConversation() { listPage.IsVisible = false; settingsPage.IsVisible = false; conversationPage.IsVisible = true; }
    private void ShowSettings()
    {
        if (!model.Connected) { ShowStartup(StartupPhase.Setup); return; }
        EndSettings();
        settingsLife = CancellationTokenSource.CreateLinkedTokenSource(model.ConnectionToken);
        settingsBody = new SettingsPage(model, () => ShowStartup(StartupPhase.Setup), () => { access.SignOut(); ShowList(); model.SignOut(); }, settingsLife.Token); Grid.SetRow(settingsBody, 1); settingsPage.Children.Add(settingsBody);
        listPage.IsVisible = false; conversationPage.IsVisible = false; settingsPage.IsVisible = true;
    }
    // The page's reads end when it is left.
    private void EndSettings() { settingsLife?.Cancel(); settingsLife = null; if (settingsBody is not null) { settingsPage.Children.Remove(settingsBody); settingsBody = null; } }

    private void ModelChanged(string? name)
    {
        switch (name)
        {
            case nameof(LinuxWorkspace.Connected): UpdateApprovalsEntry(); if (model.Connected) approvals.Sync(); break;
            case nameof(LinuxWorkspace.Selected): title.Text = model.Selected?.Name ?? ""; break;
            case nameof(LinuxWorkspace.Quote): UpdateQuoteBar(); break;
            case nameof(LinuxWorkspace.Attachments) or nameof(LinuxWorkspace.CanAttach): UpdateAttachments(); break;
            case nameof(LinuxWorkspace.NeedsLogin): if (model.NeedsLogin && phase != StartupPhase.SignIn) ShowStartup(StartupPhase.SignIn); break;
            case nameof(LinuxWorkspace.ConnectionError) or nameof(LinuxWorkspace.ActionError): { var text = model.ActionError ?? model.ConnectionError; status.Text = text; status.IsVisible = !string.IsNullOrEmpty(text); break; }
            case nameof(LinuxWorkspace.HasMore): older.IsVisible = model.HasMore; break;
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
            StartupPhase.SignIn => new AccessLoginPage(access, ServerOrigin.Parse(model.Server), () => _ = ConnectAsync(model.Server), () => ShowStartup(StartupPhase.Setup)),
            _ => new OnboardingView(new SetupApi(model.Management.Api), setup!, async ready => { await model.ReconnectAsync(); await EnterAsync(generation, ready); }, () => ShowStartup(StartupPhase.Setup), model.ConnectionToken)
        };
        startupHost.IsVisible = next != StartupPhase.Ready;
    }
    private void ConnectToAddress(string text)
    {
        var origin = ServerOrigin.Parse(text);
        settings.Save(settings.Load() with { ServerUrl = origin.AbsoluteUri });
        model.SignOut();
        _ = ConnectAsync(origin.AbsoluteUri);
    }
    private async Task ConnectAsync(string address, bool automatic = false)
    {
        retry?.Cancel();
        var mine = ++generation;
        if (!(automatic && phase == StartupPhase.Failure)) ShowStartup(StartupPhase.Checking);
        try { await model.ConnectAsync(address); await EnterAsync(mine); }
        catch (ArgumentException error) { if (mine == generation) ShowStartup(StartupPhase.Failure, error.Message); }
    }
    private async Task EnterAsync(int mine, SetupState? known = null)
    {
        var setup = known; var failure = model.ConnectionError;
        if (setup is null && model.Connected && !model.NeedsLogin)
            try { setup = await new SetupApi(model.Management.Api).StatusAsync(model.ConnectionToken); }
            catch (OperationCanceledException) when (model.ConnectionToken.IsCancellationRequested) { return; }
            catch (Exception error) { failure = error.Message; }
        if (mine != generation) return;
        var route = StartupRoute.AfterConnect(model.NeedsLogin, model.Connected, setup);
        if (route != StartupPhase.Failure) attempt = 0;
        switch (route)
        {
            case StartupPhase.Ready: ShowStartup(StartupPhase.Ready); ShowList(); break;
            case StartupPhase.Onboarding: ShowStartup(StartupPhase.Onboarding, setup: setup); break;
            case StartupPhase.SignIn: ShowStartup(StartupPhase.SignIn); break;
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
