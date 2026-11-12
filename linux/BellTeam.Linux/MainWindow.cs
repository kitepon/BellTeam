using Avalonia.Automation;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.Primitives;
using Avalonia.Input;
using Avalonia.Interactivity;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Media.Imaging;
using Avalonia.Platform.Storage;
using Avalonia.Threading;
using Avalonia.VisualTree;
using BellTeam.Core;

namespace BellTeam.Linux;

public sealed class MainWindow : Window, ISheetHost
{
    private readonly LinuxWorkspace model;
    private readonly SettingsStore settingsStore;
    private readonly DesktopNotifications? notifications;
    private StartupPhase startup = StartupPhase.Ready;
    private int connectGeneration;
    private bool connecting;
    private string? lastAddress;
    // Failed startup connections since the last success; the next automatic try waits ReconnectBackoff for this number. A manual try does not reset it.
    private int startupAttempt;
    private CancellationTokenSource? startupRetry;
    // Off for the render seams, which capture a screen and must not move on by themselves.
    public bool AutoRetry { get; set; } = true;
    private bool loadingOlder;
    private bool unreadNew; // a message arrived while the reader was away from the bottom
    private bool syncingComposer;
    private string attachmentKey = "", queueKey = "";

    // ---- sidebar ----
    private readonly StackPanel list = new();
    private readonly Dictionary<ChatTarget, ConversationRow> rows = [];
    private bool listQueued;
    private readonly TextBox search = new() { Classes = { "bare" }, FontSize = 16, PlaceholderText = "メンバー・ルームを検索", VerticalContentAlignment = VerticalAlignment.Center };
    private readonly TextBlock searchHint = new() { Text = "Ctrl+K", FontSize = 14, Foreground = BellTheme.Muted, VerticalAlignment = VerticalAlignment.Center };
    private readonly Button clearSearch;
    private readonly Button addMenu;
    private readonly Button updateBadge;
    private readonly Border accountsBanner = new() { Background = new SolidColorBrush(Color.Parse("#1FFF9500")), CornerRadius = new CornerRadius(10), Padding = new Thickness(11, 7), Margin = new Thickness(0, 8, 0, 0), IsVisible = false };
    private readonly TextBlock accountsText = new() { Foreground = new SolidColorBrush(Color.Parse("#C77700")), FontSize = 13, FontWeight = FontWeight.SemiBold, TextWrapping = TextWrapping.Wrap };
    private readonly TextBlock notFound = BellTheme.Text("見つかりませんでした", 13, BellTheme.Muted, margin: new Thickness(24, 16));
    private readonly TextBlock onlineSummary = new() { FontSize = 14, Foreground = BellTheme.Muted };
    private readonly TextBlock ownerName = new() { FontSize = 14, Foreground = BellTheme.Muted, MaxWidth = 140, TextTrimming = TextTrimming.CharacterEllipsis, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(6, 0, 0, 0) };
    private readonly Button[] nav;

    // ---- conversation ----
    private readonly Grid conversationArea = new();
    private readonly Border pageArea = new() { Background = BellTheme.ConversationBackground, IsVisible = false };
    private readonly ScrollViewer messageScroll = new() { VerticalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled };
    private readonly Grid messageColumn = new();
    private readonly Button older = new() { Classes = { "plain" }, Content = "以前のメッセージを読む", HorizontalAlignment = HorizontalAlignment.Center, Background = Brushes.White, BorderBrush = BellTheme.Line, BorderThickness = new Thickness(1), Foreground = BellTheme.Violet, IsVisible = false };
    private readonly Border queueStrip = new() { Background = BellTheme.QueueFill, CornerRadius = new CornerRadius(16), Padding = new Thickness(14, 9.5), IsVisible = false };
    private readonly StackPanel queueRows = new();
    private readonly StackPanel welcome = new() { VerticalAlignment = VerticalAlignment.Center, HorizontalAlignment = HorizontalAlignment.Center, MaxWidth = 450, Margin = new Thickness(30) };
    private readonly Spinner loadingSpinner = new(BellTheme.Muted, 20) { VerticalAlignment = VerticalAlignment.Top, HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 90, 0, 0), IsVisible = false };
    private readonly StackPanel emptyConversation = new() { VerticalAlignment = VerticalAlignment.Top, HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(30, 100, 30, 0), IsVisible = false };
    private readonly AvatarTile emptyAvatar = new() { Width = 72, Height = 72, HorizontalAlignment = HorizontalAlignment.Center };
    private readonly TextBlock emptyTitle = BellTheme.Text("", 18, BellTheme.Ink, FontWeight.SemiBold, new Thickness(0, 13, 0, 0));
    private readonly StackPanel failedConversation = new() { VerticalAlignment = VerticalAlignment.Top, HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(30, 60, 30, 0), IsVisible = false };
    private readonly Button latest = new() { Classes = { "plain" }, Content = "最新へ ↓", HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Bottom, Margin = new Thickness(0, 0, 0, 12), Background = BellTheme.ProminentFill, Foreground = Brushes.White, IsVisible = false };
    private readonly SeatLaunchBar seatLaunchBar = new();
    private readonly Button exportButton;
    private readonly Border stopNoticeBox = new() { CornerRadius = new CornerRadius(16), Padding = new Thickness(14), Margin = new Thickness(0, 0, 0, 8), Background = BellTheme.QueueFill, IsVisible = false };
    private readonly TextBlock stopNoticeText = new() { FontSize = 14, TextWrapping = TextWrapping.Wrap };
    private readonly TextBlock sendError = new() { Foreground = BellTheme.Red, FontSize = 14, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 0, 0, 8), IsVisible = false };
    private readonly StackPanel attachments = new() { Orientation = Orientation.Horizontal };
    private readonly ScrollViewer attachmentScroll;
    private readonly Button replyTarget;
    private readonly TextBlock replyLabel = new() { FontSize = 14, FontWeight = FontWeight.SemiBold, Foreground = BellTheme.Violet, VerticalAlignment = VerticalAlignment.Center };
    private readonly TextBox composer = new() { Classes = { "bare" }, AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, MinHeight = 24, MaxHeight = 124, FontSize = 18, Margin = new Thickness(0, 8), PlaceholderText = "メッセージを入力…" };
    private readonly Button attach, stopCurrent, send;

    // ---- status band, startup, overlays ----
    private readonly Border errorStrip = new() { Background = BellTheme.BandFill, Padding = new Thickness(8), IsVisible = false };
    private readonly TextBlock connectionError = new() { TextAlignment = TextAlignment.Center, VerticalAlignment = VerticalAlignment.Center, Foreground = BellTheme.Red, TextWrapping = TextWrapping.Wrap, FontSize = 10 };
    private readonly TextBlock actionError = new() { TextAlignment = TextAlignment.Center, Foreground = BellTheme.Red, TextWrapping = TextWrapping.Wrap, FontSize = 10 };
    private readonly Button reconnect, changeServer;
    private readonly Border startupHost = new() { IsVisible = false };
    private readonly Grid sheet = new() { Background = new SolidColorBrush(Color.Parse("#66000000")), IsVisible = false, Focusable = true };
    private readonly Border sheetFrame = new();
    private readonly TextBlock sheetTitle = new() { HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center, FontSize = 15, FontWeight = FontWeight.SemiBold, Foreground = BellTheme.Ink };
    private readonly ContentControl sheetHost = new();
    private Button? closeSheetButton, saveSheetButton;
    private ISheetSave? sheetSave;
    private readonly GoalPill goalPill = new();
    private readonly Grid galleryHost = new() { Background = Brushes.Black, IsVisible = false, Focusable = true };
    private IInputElement? focusBeforeGallery;

    public MainWindow(LinuxWorkspace model, bool persistPlacement = true, SettingsStore? settings = null, DesktopNotifications? notifications = null)
    {
        this.model = model; settingsStore = settings ?? new SettingsStore(SettingsStore.UserDirectory); this.notifications = notifications;
        Title = "BellTeam"; Width = 1280; Height = 820; MinWidth = 1100; MinHeight = 640;
        Icon = new WindowIcon(EmbeddedAsset.Open("BellTeam.png"));
        addMenu = BuildAddMenu();
        updateBadge = BuildUpdateBadge();
        clearSearch = Flat(Icons.Close, 12, "検索を消去", () => { model.Search = ""; search.Text = ""; search.Focus(); }); clearSearch.IsVisible = false;
        exportButton = BuildExport();
        attach = CircleOrFlat(Icons.Paperclip, 22, BellTheme.Violet, "画像を添付", AttachAsync, "画像ファイルを添付。ここへドロップ、入力欄へ貼り付けもできます");
        stopCurrent = Circle(BellTheme.Red, "今の動作を止める", () => _ = model.StopCurrentAsync(), "今の動作を止める");
        stopCurrent.Content = new Border { Width = 13, Height = 13, CornerRadius = new CornerRadius(2.5), Background = Brushes.White };
        send = Circle(BellTheme.Violet, "送信", () => _ = model.SendAsync(), "送信（Enter）"); send.Content = Icons.Draw(Icons.Send, 20, Brushes.White, thickness: 2.4);
        replyTarget = BuildReplyTarget();
        reconnect = StripButton("再接続", () => { if (model.Server.Length != 0) { ShowConversation(); _ = ConnectAsync(model.Server); } });
        changeServer = StripButton("接続先", OpenConnectionSettings);
        attachmentScroll = new ScrollViewer { VerticalScrollBarVisibility = ScrollBarVisibility.Disabled, HorizontalScrollBarVisibility = ScrollBarVisibility.Auto, Content = attachments, IsVisible = false };
        nav = [];
        var navButtons = new List<Button>();
        Content = BuildRoot(navButtons);
        nav = navButtons.ToArray();
        WireModel(); UpdateAll();
        AddHandler(KeyDownEvent, WindowKeyDown, RoutingStrategies.Tunnel);
        Closed += (_, _) => { CancelStartupRetry(); CloseGallery(); CloseSheet(); (startupHost.Child as IDisposable)?.Dispose(); };
        // Mac scenePhase .active: coming back to the window reads the goals again.
        Activated += (_, _) => { goalPill.Reload(); (pageArea.Child as GoalsPage)?.Reload(); };
        if (persistPlacement) RestorePlacement();
    }

    // ---- construction ----
    private static Button Flat(string icon, double size, string name, Action click, IBrush? stroke = null)
    {
        var button = new Button { Classes = { "plain" }, Background = Brushes.Transparent, Padding = new Thickness(2), Content = Icons.Draw(icon, size, stroke ?? BellTheme.Muted) };
        AutomationProperties.SetName(button, name); ToolTip.SetTip(button, name); button.Click += (_, _) => click(); return button;
    }
    private static Button CircleOrFlat(string icon, double size, IBrush stroke, string name, Func<Task> click, string tip)
    {
        var button = new Button { Classes = { "plain" }, Background = Brushes.Transparent, Width = 40, Height = 40, Padding = default, Margin = new Thickness(0, 0, 12, 0), VerticalAlignment = VerticalAlignment.Bottom, HorizontalContentAlignment = HorizontalAlignment.Center, VerticalContentAlignment = VerticalAlignment.Center, Content = Icons.Draw(icon, size, stroke) };
        AutomationProperties.SetName(button, name); ToolTip.SetTip(button, tip); button.Click += async (_, _) => await click(); return button;
    }
    private static Button Circle(IBrush fill, string name, Action click, string tip)
    {
        var button = new Button { Classes = { "plain" }, Background = fill, Width = 38, Height = 38, Padding = default, CornerRadius = new CornerRadius(19), Margin = new Thickness(0, 0, 0, 1), VerticalAlignment = VerticalAlignment.Bottom, HorizontalContentAlignment = HorizontalAlignment.Center, VerticalContentAlignment = VerticalAlignment.Center };
        AutomationProperties.SetName(button, name); ToolTip.SetTip(button, tip); button.Click += (_, _) => click(); return button;
    }
    private static Button StripButton(string text, Action click)
    {
        var button = new Button { Classes = { "plain" }, Content = text, Margin = new Thickness(8, 0, 0, 0), Padding = new Thickness(10, 2), FontSize = 11, FontWeight = FontWeight.Normal, Background = Brushes.White, BorderBrush = BellTheme.Line, BorderThickness = new Thickness(1), Foreground = BellTheme.Violet, IsVisible = false };
        AutomationProperties.SetName(button, text); button.Click += (_, _) => click(); return button;
    }

    private Control BuildRoot(List<Button> navButtons)
    {
        var main = new Grid { ColumnDefinitions = new ColumnDefinitions("340,5,*") };
        var sidebar = BuildSidebar(navButtons);
        main.ColumnDefinitions[0].MinWidth = 320; main.ColumnDefinitions[0].MaxWidth = 420;
        main.Children.Add(sidebar);
        var splitter = new GridSplitter { Width = 5, Background = Brushes.Transparent, ResizeDirection = GridResizeDirection.Columns, ResizeBehavior = GridResizeBehavior.PreviousAndNext }; AutomationProperties.SetName(splitter, "サイドバーの幅");
        Grid.SetColumn(splitter, 1); main.Children.Add(splitter);
        BuildConversation();
        Grid.SetColumn(conversationArea, 2); Grid.SetColumn(pageArea, 2); main.Children.Add(conversationArea); main.Children.Add(pageArea);
        // Mac bottom banner (safeAreaInset): a centred red caption on material. Linux keeps 再接続 and 接続先 next to it.
        var buttons = new StackPanel { Orientation = Orientation.Horizontal }; DockPanel.SetDock(buttons, Dock.Right); buttons.Children.Add(changeServer); buttons.Children.Add(reconnect);
        var stripTop = new DockPanel { Children = { buttons, connectionError } };
        errorStrip.Child = new StackPanel { Children = { stripTop, actionError } };
        Grid.SetRow(errorStrip, 1);
        // Sheet: Mac bellEditorSheet, min 720x540, ideal 820x680, shrinks to fit the window.
        var closeSheet = closeSheetButton = new Button { Classes = { "plain" }, Content = "閉じる", Padding = new Thickness(16, 7), CornerRadius = new CornerRadius(99), FontWeight = FontWeight.Normal, Foreground = BellTheme.Ink, Background = new SolidColorBrush(Color.Parse("#80FFFFFF")), BorderBrush = new SolidColorBrush(Color.Parse("#C9C4DE")), BorderThickness = new Thickness(1), HorizontalAlignment = HorizontalAlignment.Left, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(12, 0, 0, 0) };
        AutomationProperties.SetName(closeSheet, "閉じる"); closeSheet.Click += (_, _) => { if (sheetSave is { CanClose: false }) return; CloseSheet(); };
        // The save button of a sheet that is an ISheetSave (Windows UpdateSheetSave): the same pill as 閉じる, on the right.
        var saveSheet = saveSheetButton = new Button { Classes = { "plain" }, Content = "保存", Padding = new Thickness(16, 7), CornerRadius = new CornerRadius(99), FontWeight = FontWeight.Normal, Foreground = BellTheme.Ink, Background = new SolidColorBrush(Color.Parse("#80FFFFFF")), BorderBrush = new SolidColorBrush(Color.Parse("#C9C4DE")), BorderThickness = new Thickness(1), HorizontalAlignment = HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, 0, 12, 0), IsVisible = false };
        AutomationProperties.SetName(saveSheet, "保存"); saveSheet.Click += (_, _) => { if (sheetSave is { CanSave: true } save) _ = save.SaveAsync(); };
        var header = new Grid { Height = 52, Background = new SolidColorBrush(Color.Parse("#F2F2F7")), Children = { closeSheet, saveSheet, sheetTitle } };
        var line = new Border { Height = 1, Background = new SolidColorBrush(Color.Parse("#E6E6EB")) };
        DockPanel.SetDock(header, Dock.Top); DockPanel.SetDock(line, Dock.Top);
        sheetFrame.Margin = new Thickness(24); sheetFrame.MinWidth = 720; sheetFrame.MinHeight = 540; sheetFrame.MaxWidth = 820; sheetFrame.MaxHeight = 680; sheetFrame.Background = new SolidColorBrush(Color.Parse("#F2F2F7")); sheetFrame.CornerRadius = new CornerRadius(14); sheetFrame.ClipToBounds = true; sheetFrame.BoxShadow = BoxShadows.Parse("0 8 30 0 #40000000");
        sheetFrame.Child = new DockPanel { Children = { header, line, sheetHost } };
        sheet.Children.Add(sheetFrame);
        var root = new Grid { RowDefinitions = new RowDefinitions("*,Auto"), Background = BellTheme.Canvas };
        Grid.SetRowSpan(startupHost, 2); Grid.SetRowSpan(sheet, 2); Grid.SetRowSpan(galleryHost, 2);
        root.Children.Add(main); root.Children.Add(errorStrip); root.Children.Add(startupHost); root.Children.Add(sheet); root.Children.Add(galleryHost);
        return root;
    }

    private Button BuildAddMenu()
    {
        var content = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 12, Children = { Icons.Draw(Icons.PlusCircle, 20, BellTheme.Ink), Icons.Draw(Icons.ChevronDown, 12, BellTheme.Ink) } };
        var button = new Button { Classes = { "plain" }, Background = new SolidColorBrush(Color.Parse("#1F767680")), Padding = new Thickness(12, 6), Foreground = BellTheme.Ink, VerticalAlignment = VerticalAlignment.Center, Content = content };
        AutomationProperties.SetName(button, "追加"); ToolTip.SetTip(button, "追加");
        // Placeholders: the member and room sheets are not ported yet.
        var addMember = new MenuItem { Header = "メンバーを追加" }; addMember.Click += (_, _) => model.ReportActionError("メンバーの追加はLinux版ではまだ使えません。");
        var addRoom = new MenuItem { Header = "ルームを作成" }; addRoom.Click += (_, _) => model.ReportActionError("ルームの作成はLinux版ではまだ使えません。");
        button.Flyout = new MenuFlyout { Items = { addMember, addRoom }, Placement = PlacementMode.BottomEdgeAlignedRight };
        return button;
    }

    // Mac UpdateBadge: a violet arrow disc on a pale violet capsule, only while an update exists.
    private Button BuildUpdateBadge()
    {
        var disc = new Grid { Width = 18, Height = 18, Children = { new Avalonia.Controls.Shapes.Ellipse { Fill = BellTheme.Violet }, Icons.Draw(UpdateIcons.ArrowDown, 10, Brushes.White, thickness: 3.2) } };
        ((Control)disc.Children[1]).HorizontalAlignment = HorizontalAlignment.Center;
        var button = new Button { Classes = { "plain" }, Background = new SolidColorBrush(Color.Parse("#E4DDFB")), Padding = new Thickness(6), CornerRadius = new CornerRadius(99), VerticalAlignment = VerticalAlignment.Center, IsVisible = false, Content = disc, Name = "update-badge" };
        AutomationProperties.SetName(button, "更新があります。アップデートを開く"); ToolTip.SetTip(button, "アップデート"); button.Click += (_, _) => ShowUpdates();
        return button;
    }

    private Control BuildSidebar(List<Button> navButtons)
    {
        var titleRow = new DockPanel { Margin = new Thickness(2, 0, 0, 20) };
        DockPanel.SetDock(addMenu, Dock.Right); titleRow.Children.Add(addMenu);
        titleRow.Children.Add(new StackPanel { Orientation = Orientation.Horizontal, Spacing = 10, Children = { Icons.Draw(Icons.Sparkle, 26, BellTheme.Violet, filled: true, thickness: 0), new TextBlock { Text = "BellTeam", FontSize = 22, FontWeight = FontWeight.Bold, VerticalAlignment = VerticalAlignment.Center }, updateBadge } });
        var searchRight = new Grid { Children = { searchHint, clearSearch } }; DockPanel.SetDock(searchRight, Dock.Right);
        var magnifier = Icons.Draw(Icons.Search, 18, BellTheme.Muted); magnifier.Margin = new Thickness(0, 0, 8, 0); DockPanel.SetDock(magnifier, Dock.Left);
        AutomationProperties.SetName(search, "メンバー・ルームを検索"); ToolTip.SetTip(search, "メンバー・ルームを検索（Ctrl+K）");
        search.TextChanged += (_, _) => { var text = search.Text ?? ""; clearSearch.IsVisible = text.Length != 0; searchHint.IsVisible = text.Length == 0; if (model.Search != text) model.Search = text; };
        var searchBox = new Border { Background = new SolidColorBrush(Color.Parse("#EFFFFFFF")), CornerRadius = new CornerRadius(10), Padding = new Thickness(11, 9), Child = new DockPanel { Children = { searchRight, magnifier, search } } };
        accountsBanner.Child = accountsText; AutomationProperties.SetName(accountsBanner, "アカウントの上限");
        var top = new StackPanel { Margin = new Thickness(18, 20, 18, 10), Children = { titleRow, searchBox, accountsBanner } };
        DockPanel.SetDock(top, Dock.Top);

        // Footer: 予定 and 設定 at the ends, ゴール between. The three open an empty placeholder page in this stage.
        var footerGrid = new Grid { ColumnDefinitions = new ColumnDefinitions("Auto,*,Auto,*,Auto") };
        void Add(Button button, int column) { button.IsEnabled = false; Grid.SetColumn(button, column); footerGrid.Children.Add(button); navButtons.Add(button); }
        Add(NavButton(Icons.Calendar, "予定", "予定（Ctrl+2）", ShowSchedules), 0);
        Add(NavButton(Icons.Target, "ゴール", "ゴール（Ctrl+3）", ShowGoals), 2);
        Add(NavButton(Icons.Gear, "設定", "設定（Ctrl+,）", () => ShowPage("設定")), 4);
        var summaryRow = new DockPanel { Margin = new Thickness(4, 0), Children = { ownerName, new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center, Children = { new Avalonia.Controls.Shapes.Ellipse { Width = 6, Height = 6, Fill = BellTheme.Mint, Margin = new Thickness(0, 0, 7, 0) }, onlineSummary } } } };
        DockPanel.SetDock(ownerName, Dock.Right);
        var footer = new StackPanel { Margin = new Thickness(14), Children = { new Border { BorderBrush = BellTheme.Line, BorderThickness = new Thickness(0, 1, 0, 0), Padding = new Thickness(0, 8), Child = footerGrid }, summaryRow } };
        DockPanel.SetDock(footer, Dock.Bottom);

        notFound.IsVisible = false; notFound.VerticalAlignment = VerticalAlignment.Top; notFound.IsHitTestVisible = false;
        var listArea = new Grid { Children = { new ScrollViewer { HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, Content = list }, notFound } };
        AutomationProperties.SetName(list, "メンバーとルーム");
        return new Border { Background = BellTheme.SidebarFill, BorderBrush = BellTheme.Line, BorderThickness = new Thickness(0, 0, 1, 0), Child = new DockPanel { Children = { top, footer, listArea } } };
    }
    private static Button NavButton(string icon, string text, string tip, Action click)
    {
        var button = new Button { Classes = { "plain" }, Background = Brushes.Transparent, Foreground = BellTheme.Ink, FontSize = 14, FontWeight = FontWeight.Normal, Padding = new Thickness(2, 9), Content = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 5, Children = { Icons.Draw(icon, 18, BellTheme.Ink, thickness: 1.6), new TextBlock { Text = text, VerticalAlignment = VerticalAlignment.Center } } } };
        AutomationProperties.SetName(button, text); ToolTip.SetTip(button, tip); button.Click += (_, _) => click(); return button;
    }
    private Button BuildExport()
    {
        // Mac window toolbar button: a violet filled circle with a white glyph.
        var button = new Button { Classes = { "plain" }, Width = 38, Height = 38, Padding = default, CornerRadius = new CornerRadius(19), Background = BellTheme.Violet, HorizontalAlignment = HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Top, Margin = new Thickness(0, 7, 10, 0), HorizontalContentAlignment = HorizontalAlignment.Center, VerticalContentAlignment = VerticalAlignment.Center, Content = Icons.Draw(Icons.Export, 20, Brushes.White), IsVisible = false, ZIndex = 5 };
        AutomationProperties.SetName(button, "会話を書き出す"); ToolTip.SetTip(button, "会話を書き出す"); button.Click += async (_, _) => await ExportAsync(); return button;
    }
    private Button BuildReplyTarget()
    {
        var content = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6, Children = { Icons.Draw(Icons.Send, 14, BellTheme.Violet), replyLabel, Icons.Draw(Icons.ChevronDown, 10, BellTheme.Violet) } };
        var button = new Button { Classes = { "plain" }, Padding = default, HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 0, 0, 8), IsVisible = false, Background = Brushes.Transparent, Content = new Border { Background = new SolidColorBrush(Color.Parse("#BFE8E0FF")), CornerRadius = new CornerRadius(99), Padding = new Thickness(11, 7), Child = content } };
        AutomationProperties.SetName(button, "返信先"); button.Click += (_, _) => ShowReplyMenu(button); return button;
    }

    private void BuildConversation()
    {
        conversationArea.Background = BellTheme.ConversationBackground; conversationArea.RowDefinitions = new RowDefinitions("52,*,Auto");
        // Mac shows no avatar+name row here: the window title says BellTeam and the toolbar band only carries the corner button.
        seatLaunchBar.Margin = new Thickness(0, 52, 0, 0); seatLaunchBar.VerticalAlignment = VerticalAlignment.Top; Grid.SetRowSpan(seatLaunchBar, 2);

        var messages = new ItemsControl { ItemsSource = model.Messages, ItemTemplate = new Avalonia.Controls.Templates.FuncDataTemplate<MessageItem>((item, _) => new MessageCard(item, model)) };
        // Mac queueStrip: one line per running or queued delivery; in a room each member's line has its own stop button.
        queueStrip.Child = queueRows; AutomationProperties.SetName(queueStrip, "処理中");
        older.Click += async (_, _) => await LoadOlderPreservingPositionAsync();
        var stack = new StackPanel { VerticalAlignment = VerticalAlignment.Bottom, Margin = new Thickness(18, 20, 18, 18), Children = { older, messages, queueStrip } };
        messageColumn.Children.Add(stack); messageScroll.Content = messageColumn; AutomationProperties.SetName(messageScroll, "会話");
        Grid.SetRow(messageScroll, 1);
        messageScroll.PropertyChanged += (_, args) => { if (args.Property == ScrollViewer.ViewportProperty) messageColumn.MinHeight = messageScroll.Viewport.Height; };
        messageScroll.ScrollChanged += async (_, args) =>
        {
            ShowLatestButton();
            var previousBottomDistance = messageScroll.Extent.Height - args.ExtentDelta.Y - messageScroll.Viewport.Height - messageScroll.Offset.Y;
            if (!loadingOlder && args.ExtentDelta.Y > 0 && previousBottomDistance < 80) Dispatcher.UIThread.Post(() => messageScroll.ScrollToEnd());
            if (!loadingOlder && args.OffsetDelta.Y < 0 && messageScroll.Offset.Y < 48 && model.HasMore && !model.Loading) await LoadOlderPreservingPositionAsync();
        };
        model.ScrollToBottom += force =>
        {
            if (force || messageScroll.Extent.Height - messageScroll.Viewport.Height - messageScroll.Offset.Y < 80) Dispatcher.UIThread.Post(() => messageScroll.ScrollToEnd());
            else { unreadNew = true; ShowLatestButton(); }
        };
        DragDrop.SetAllowDrop(messageScroll, true); messageScroll.AddHandler(DragDrop.DragOverEvent, ImagesDragOver); messageScroll.AddHandler(DragDrop.DropEvent, ImagesDrop);

        welcome.Children.Add(Icons.Draw(Icons.Chat, 56, BellTheme.Violet, thickness: 1.4)); ((Control)welcome.Children[0]).HorizontalAlignment = HorizontalAlignment.Center; ((Control)welcome.Children[0]).Margin = new Thickness(0, 0, 0, 18);
        var welcomeTitle = BellTheme.Text("チームと、同じデスクで。", 29, BellTheme.Ink, FontWeight.Bold); welcomeTitle.TextAlignment = TextAlignment.Center; welcome.Children.Add(welcomeTitle);
        var welcomeNote = BellTheme.Text("左のメンバーやルームを選んで、会話を始めましょう。", 16, BellTheme.Muted, margin: new Thickness(0, 14, 0, 0)); welcomeNote.TextAlignment = TextAlignment.Center; welcome.Children.Add(welcomeNote);
        welcome.Children.Add(new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 30, 0, 0), Spacing = 25, Children = { BellTheme.Text("検索  Ctrl+K", 14, BellTheme.Muted), BellTheme.Text("送信  Enter", 14, BellTheme.Muted) } });
        Grid.SetRow(welcome, 1); Grid.SetRow(loadingSpinner, 1); Grid.SetRow(emptyConversation, 1); Grid.SetRow(failedConversation, 1); Grid.SetRow(latest, 1);
        emptyConversation.Children.Add(emptyAvatar); emptyConversation.Children.Add(emptyTitle);
        var emptyNote = BellTheme.Text("最初のメッセージを送ってみてね。", 15, BellTheme.Muted, margin: new Thickness(0, 13, 0, 0)); emptyNote.TextAlignment = TextAlignment.Center; emptyConversation.Children.Add(emptyNote);
        var failedIcon = Icons.Draw(Icons.Warning, 36, BellTheme.Muted, thickness: 1.5); failedIcon.HorizontalAlignment = HorizontalAlignment.Center; failedConversation.Children.Add(failedIcon);
        var failedTitle = BellTheme.Text("会話を読み込めませんでした", 18, BellTheme.Ink, FontWeight.SemiBold, new Thickness(0, 12, 0, 0)); failedTitle.TextAlignment = TextAlignment.Center; failedConversation.Children.Add(failedTitle);
        var failedNote = BellTheme.Text("再読み込みしてください。", 15, BellTheme.Muted, margin: new Thickness(0, 8, 0, 0)); failedNote.TextAlignment = TextAlignment.Center; failedConversation.Children.Add(failedNote);
        var reload = new Button { Classes = { "plain" }, Content = "再読み込み", HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 16, 0, 0), Background = Brushes.White, BorderBrush = BellTheme.Line, BorderThickness = new Thickness(1), Foreground = BellTheme.Violet };
        AutomationProperties.SetName(reload, "再読み込み"); reload.Click += async (_, _) => { if (model.Selected is { } entry) await model.SelectAsync(entry); }; failedConversation.Children.Add(reload);
        latest.Click += (_, _) => { unreadNew = false; messageScroll.ScrollToEnd(); latest.IsVisible = false; }; AutomationProperties.SetName(latest, "最新へ");

        // Composer band (Mac composer): notices and attachments sit above the reply target and the input.
        stopNoticeBox.Child = stopNoticeText; AutomationProperties.SetName(stopNoticeBox, "停止の結果");
        composer.AddHandler(KeyDownEvent, ComposerKeyDown, RoutingStrategies.Tunnel);
        composer.TextChanged += (_, _) => { if (syncingComposer) return; syncingComposer = true; try { model.DraftText = composer.Text ?? ""; } finally { syncingComposer = false; } };
        AutomationProperties.SetName(composer, "メッセージ"); ToolTip.SetTip(composer, "Enterで送信・Shift+Enterで改行");
        DragDrop.SetAllowDrop(composer, true); composer.AddHandler(DragDrop.DragOverEvent, ImagesDragOver); composer.AddHandler(DragDrop.DropEvent, ImagesDrop);
        var input = new Grid { ColumnDefinitions = new ColumnDefinitions("Auto,*,Auto,Auto") };
        composer.VerticalAlignment = VerticalAlignment.Bottom; composer.Margin = new Thickness(0, 8, 12, 8);
        Grid.SetColumn(composer, 1); Grid.SetColumn(stopCurrent, 2); Grid.SetColumn(send, 3); stopCurrent.Margin = new Thickness(0, 0, 12, 1);
        input.Children.Add(attach); input.Children.Add(composer); input.Children.Add(stopCurrent); input.Children.Add(send);
        var pill = new Border { Background = BellTheme.Canvas, BorderBrush = BellTheme.Line, BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(24), Padding = new Thickness(8, 5), Child = input };
        var band = new Border { Background = BellTheme.BandFill, Child = new StackPanel { Margin = new Thickness(15, 11, 15, 8), Children = { stopNoticeBox, sendError, attachmentScroll, replyTarget, goalPill, pill } } };
        Grid.SetRow(band, 2);
        conversationArea.Children.Add(seatLaunchBar); conversationArea.Children.Add(messageScroll); conversationArea.Children.Add(welcome); conversationArea.Children.Add(loadingSpinner); conversationArea.Children.Add(emptyConversation); conversationArea.Children.Add(failedConversation); conversationArea.Children.Add(latest); conversationArea.Children.Add(band); conversationArea.Children.Add(exportButton);
        Grid.SetColumnSpan(exportButton, 1);
    }

    // ---- model wiring ----
    private void WireModel()
    {
        model.PropertyChanged += (_, args) => { if (Dispatcher.UIThread.CheckAccess()) ModelChanged(args.PropertyName); else Dispatcher.UIThread.Post(() => ModelChanged(args.PropertyName)); };
        model.Entries.CollectionChanged += (_, _) => QueueListRebuild();
        model.Messages.CollectionChanged += (_, _) => UpdateWelcome();
        MarkdownView.LinkFailed = message => model.ReportActionError(message);
        // These events come from the connection's thread.
        model.UpdatesChanged += () => Dispatcher.UIThread.Post(() => _ = RefreshUpdateNoticeAsync());
        if (notifications is not null) notifications.PropertyChanged += (_, args) => { if (args.PropertyName == nameof(DesktopNotifications.Error) && notifications.Error is { } error) Dispatcher.UIThread.Post(() => model.ReportActionError(error)); };
        model.MessageArrived += message => Dispatcher.UIThread.Post(async () =>
        {
            if (notifications?.Enabled != true || IsActive && conversationArea.IsVisible && model.Selected?.Target == message.Target) return;
            await notifications.NotifyAsync(message);
            if (!notifications.Enabled) model.ReportActionError(notifications.Status);
        });
    }
    private void ModelChanged(string? name)
    {
        switch (name)
        {
            case nameof(LinuxWorkspace.NeedsLogin): if (model.NeedsLogin && !connecting) RouteToLogin(); break;
            case nameof(LinuxWorkspace.Connected): UpdateNav(); UpdateGoalBar(); if (model.Connected) _ = RefreshUpdateNoticeAsync(); else updateBadge.IsVisible = false; break;
            case nameof(LinuxWorkspace.Selected): UpdateSelection(); unreadNew = false; break;
            case nameof(LinuxWorkspace.IsRoom): UpdateComposerBand(); break;
            case nameof(LinuxWorkspace.Loading) or nameof(LinuxWorkspace.LoadFailed) or nameof(LinuxWorkspace.Title): UpdateWelcome(); break;
            case nameof(LinuxWorkspace.HasActivity) or nameof(LinuxWorkspace.ActivityRows) or nameof(LinuxWorkspace.StopEnabled): UpdateQueue(); UpdateWelcome(); UpdateComposerBand(); break;
            case nameof(LinuxWorkspace.CurrentBotCanStop): UpdateComposerBand(); break;
            case nameof(LinuxWorkspace.StopResult): ShowStopResult(); break;
            case nameof(LinuxWorkspace.ConnectionError) or nameof(LinuxWorkspace.ActionError): UpdateStrip(); break;
            case nameof(LinuxWorkspace.DraftText) or nameof(LinuxWorkspace.SendError) or nameof(LinuxWorkspace.CanSend) or nameof(LinuxWorkspace.SendLabel) or nameof(LinuxWorkspace.CanAttach) or nameof(LinuxWorkspace.Attachments) or nameof(LinuxWorkspace.ReplyTargetLabel): UpdateComposerBand(); break;
            case nameof(LinuxWorkspace.OwnerName) or nameof(LinuxWorkspace.OnlineSummary) or nameof(LinuxWorkspace.AccountsBanner): UpdateSidebarTexts(); break;
            case nameof(LinuxWorkspace.HasMore): older.IsVisible = model.HasMore; break;
        }
    }
    private void UpdateAll() { UpdateNav(); UpdateSelection(); UpdateWelcome(); UpdateQueue(); UpdateComposerBand(); UpdateStrip(); UpdateSidebarTexts(); QueueListRebuild(); }
    private void UpdateNav() { foreach (var button in nav) button.IsEnabled = model.Connected; addMenu.IsEnabled = model.Connected; }
    private void UpdateSidebarTexts()
    {
        onlineSummary.Text = model.OnlineSummary; ownerName.Text = model.OwnerName;
        accountsText.Text = model.AccountsBanner; accountsBanner.IsVisible = model.AccountsBanner.Length != 0;
    }

    private void QueueListRebuild()
    {
        if (listQueued) return;
        listQueued = true; Dispatcher.UIThread.Post(RebuildList, DispatcherPriority.Normal);
    }
    // Rows are reused by their target, so a refresh after each server event does not reload the avatars.
    private void RebuildList()
    {
        listQueued = false;
        var kept = new HashSet<ChatTarget>(); list.Children.Clear();
        foreach (var group in model.Entries.GroupBy(entry => entry.Group))
        {
            var header = new DockPanel { Margin = new Thickness(20, 16, 20, 8) };
            var count = new TextBlock { Text = group.Count().ToString(), FontSize = 14, Foreground = BellTheme.Muted }; DockPanel.SetDock(count, Dock.Right);
            header.Children.Add(count); header.Children.Add(new TextBlock { Text = group.Key, FontSize = 14, FontWeight = FontWeight.SemiBold, Foreground = BellTheme.Muted });
            list.Children.Add(header);
            foreach (var entry in group)
            {
                if (rows.TryGetValue(entry.Target, out var row)) row.Update(entry); else rows[entry.Target] = row = new ConversationRow(model, entry, Select);
                kept.Add(entry.Target); list.Children.Add(row);
            }
        }
        foreach (var target in rows.Keys.Where(target => !kept.Contains(target)).ToArray()) rows.Remove(target);
        notFound.IsVisible = model.Connected && model.Entries.Count == 0;
        UpdateSelection();
    }
    private async void Select(ConversationEntry entry)
    {
        if (model.Selected?.Target == entry.Target && pageArea.IsVisible == false) return;
        ShowConversation();
        if (model.Selected?.Target != entry.Target) await model.SelectAsync(entry);
    }
    private void UpdateSelection()
    {
        foreach (var (target, row) in rows) row.Classes.Set("selected", model.Selected?.Target == target);
        seatLaunchBar.Show(model.Selected?.SeatLaunchLine);
        emptyAvatar.Workspace = model; emptyAvatar.Entry = model.Selected;
        UpdateWelcome(); UpdateComposerBand(); UpdateCorner(); UpdateGoalBar();
    }
    // Mac ChatGoalBar: only a member conversation has the goal capsule.
    private void UpdateGoalBar() => goalPill.Attach(model, model.Connected && model.Selected is { Target: { IsRoom: false } target } ? target.Id : null, this);
    // Mac toolbar: the export belongs to the conversation, so a page or an empty window shows none.
    private void UpdateCorner() => exportButton.IsVisible = conversationArea.IsVisible && model.HasSelection;

    // Mac ConversationContent: spinner while the first read runs, then the empty or failed state when there is nothing (not even a queue line) to show.
    private void UpdateWelcome()
    {
        var empty = model.HasSelection && model.Messages.Count == 0;
        welcome.IsVisible = !model.HasSelection;
        loadingSpinner.IsVisible = empty && model.Loading;
        var idle = empty && !model.Loading && !model.HasActivity;
        emptyConversation.IsVisible = idle && !model.LoadFailed;
        failedConversation.IsVisible = idle && model.LoadFailed;
        emptyTitle.Text = model.Title + "と話しましょう";
        older.IsVisible = model.HasMore;
    }
    private void UpdateQueue()
    {
        queueStrip.IsVisible = model.HasActivity;
        var key = string.Join('\n', model.ActivityRows.Select(row => $"{row.Text}|{row.StopBotId}|{row.Stopping}")) + "|" + model.StopEnabled;
        if (key == queueKey) return;
        queueKey = key; queueRows.Children.Clear();
        foreach (var row in model.ActivityRows)
        {
            var line = new DockPanel { Margin = new Thickness(0, 4.5) };
            if (row.StopBotId is { } id)
            {
                var stop = new Button { Classes = { "plain" }, Content = row.StopLabel, Margin = new Thickness(8, 0, 0, 0), Padding = new Thickness(10, 3), FontSize = 13, FontWeight = FontWeight.Normal, Foreground = BellTheme.Ink, Background = Brushes.White, BorderBrush = BellTheme.Line, BorderThickness = new Thickness(1), IsEnabled = model.StopEnabled };
                AutomationProperties.SetName(stop, $"{row.Name}の今の動作を止める"); var name = row.Name; stop.Click += async (_, _) => await model.StopAsync(id, name);
                DockPanel.SetDock(stop, Dock.Right); line.Children.Add(stop);
            }
            var spinner = new Spinner(BellTheme.Violet) { Margin = new Thickness(0, 0, 9, 0) }; DockPanel.SetDock(spinner, Dock.Left); line.Children.Add(spinner);
            line.Children.Add(new TextBlock { Text = row.Text, FontSize = 14, FontWeight = FontWeight.Medium, Foreground = BellTheme.Violet, VerticalAlignment = VerticalAlignment.Center, TextWrapping = TextWrapping.Wrap });
            queueRows.Children.Add(line);
        }
    }
    private void ShowStopResult()
    {
        var notice = model.StopResult;
        stopNoticeBox.IsVisible = notice is not null; stopNoticeText.Text = notice?.Message ?? ""; stopNoticeText.Foreground = notice?.IsError == true ? BellTheme.Red : BellTheme.Violet;
    }
    private void UpdateStrip()
    {
        connectionError.Text = model.ConnectionError ?? ""; connectionError.IsVisible = model.ConnectionError is not null;
        actionError.Text = model.ActionError ?? ""; actionError.IsVisible = model.ActionError is not null;
        errorStrip.IsVisible = model.ConnectionError is not null || model.ActionError is not null;
        reconnect.IsVisible = model.ConnectionError is not null && model.Server.Length != 0; changeServer.IsVisible = model.ConnectionError is not null;
    }
    private void UpdateComposerBand()
    {
        if ((composer.Text ?? "") != model.DraftText && !syncingComposer)
        {
            syncingComposer = true;
            try { composer.Text = model.DraftText; composer.CaretIndex = model.DraftText.Length; } finally { syncingComposer = false; }
        }
        sendError.Text = model.SendError ?? ""; sendError.IsVisible = !string.IsNullOrEmpty(model.SendError);
        send.IsEnabled = model.CanSend; attach.IsEnabled = model.CanAttach; stopCurrent.IsEnabled = model.StopEnabled; stopCurrent.IsVisible = model.CurrentBotCanStop;
        AutomationProperties.SetName(send, model.SendLabel);
        replyTarget.IsVisible = model.IsRoom; replyLabel.Text = model.ReplyTargetLabel;
        var previews = model.Attachments; var key = string.Join('|', previews.Select(item => item.Data.GetHashCode()));
        attachmentScroll.IsVisible = previews.Length != 0;
        if (key == attachmentKey) return;
        attachmentKey = key; attachments.Children.Clear();
        foreach (var item in previews)
        {
            var remove = new Button { Classes = { "plain" }, Width = 18, Height = 18, Padding = default, CornerRadius = new CornerRadius(9), Background = new SolidColorBrush(Color.Parse("#BF21293D")), BorderBrush = Brushes.White, BorderThickness = new Thickness(1.5), HorizontalAlignment = HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Top, Margin = new Thickness(0, -6, -6, 0), HorizontalContentAlignment = HorizontalAlignment.Center, VerticalContentAlignment = VerticalAlignment.Center, Content = Icons.Draw(Icons.Close, 8, Brushes.White, thickness: 3) };
            AutomationProperties.SetName(remove, item.RemoveLabel); ToolTip.SetTip(remove, item.RemoveLabel); var data = item.Data; remove.Click += (_, _) => model.RemoveAttachment(data);
            var tile = Round.Clip(new Image { Source = item.Preview, Stretch = Stretch.UniformToFill, Width = 60, Height = 60 }, 12);
            attachments.Children.Add(new Grid { Margin = new Thickness(0, 8, 10, 8), Width = 60, Height = 60, Children = { tile, remove } });
        }
    }

    // ---- actions ----
    private void ShowLatestButton()
    {
        var atBottom = messageScroll.Extent.Height - messageScroll.Viewport.Height - messageScroll.Offset.Y < 80;
        if (atBottom) unreadNew = false;
        latest.Content = unreadNew ? "新着メッセージ ↓" : "最新へ ↓";
        latest.IsVisible = !(atBottom && !unreadNew) && model.HasSelection && model.Messages.Count != 0;
    }
    private async Task LoadOlderPreservingPositionAsync()
    {
        if (loadingOlder) return;
        loadingOlder = true; var target = model.Selected?.Target; var offset = messageScroll.Offset.Y; var height = messageScroll.Extent.Height;
        try
        {
            await model.LoadOlderAsync();
            if (model.Selected?.Target == target) { messageScroll.UpdateLayout(); messageScroll.Offset = new Vector(0, offset + messageScroll.Extent.Height - height); }
        }
        finally { loadingOlder = false; }
    }
    private async Task ExportAsync()
    {
        if (model.Selected is not { } entry) return;
        var file = await StorageProvider.SaveFilePickerAsync(new FilePickerSaveOptions { SuggestedFileName = $"BellTeam-{entry.Target.Id}.json", DefaultExtension = "json", FileTypeChoices = [new FilePickerFileType("JSONファイル") { Patterns = ["*.json"] }] });
        if (file?.TryGetLocalPath() is { } path) await model.ExportAsync(path);
    }
    private async Task AttachAsync()
    {
        var files = await StorageProvider.OpenFilePickerAsync(new FilePickerOpenOptions { Title = "画像を添付", AllowMultiple = true, FileTypeFilter = [new FilePickerFileType("画像") { Patterns = ["*.png", "*.jpg", "*.jpeg", "*.webp", "*.gif"] }] });
        var paths = files.Select(file => file.TryGetLocalPath()).OfType<string>().ToArray();
        if (paths.Length != 0) await model.AttachFilesAsync(paths);
    }
    private void ImagesDragOver(object? sender, DragEventArgs e)
    {
        if (e.DataTransfer.Contains(DataFormat.File)) { e.DragEffects = model.CanAttach ? DragDropEffects.Copy : DragDropEffects.None; e.Handled = true; }
    }
    private async void ImagesDrop(object? sender, DragEventArgs e)
    {
        if (e.DataTransfer.TryGetFiles() is not { } files) return;
        e.Handled = true; await model.AttachFilesAsync(files.Select(file => file.TryGetLocalPath()).OfType<string>().ToArray());
    }
    private void ComposerKeyDown(object? sender, KeyEventArgs e)
    {
        // Enter alone sends; Shift+Enter keeps the new line. A conversion confirmed in the IME never reaches this key handler.
        if (e.Key == Key.Enter && e.KeyModifiers == KeyModifiers.None) { e.Handled = true; _ = model.SendAsync(); }
        else if (e.Key == Key.V && e.KeyModifiers == KeyModifiers.Control) { e.Handled = true; _ = PasteAsync(); }
    }
    // A pasted image or image file becomes an attachment; anything else pastes as text.
    private async Task PasteAsync()
    {
        try
        {
            if (Clipboard is { } clipboard && await clipboard.TryGetDataAsync() is { } data)
            {
                using (data)
                {
                    if (await data.TryGetFilesAsync() is { Length: > 0 } files) { await model.AttachFilesAsync(files.Select(file => file.TryGetLocalPath()).OfType<string>().ToArray()); return; }
                    if (await data.TryGetBitmapAsync() is { } bitmap) { model.AttachClipboardImage(bitmap); return; }
                }
            }
        }
        catch (Exception) { model.ReportDraftError("貼り付けた画像を読み込めませんでした。"); return; }
        composer.Paste();
    }
    // Mac targetPicker: "返信者を自動選択" (off when routing is off), then a check per member.
    private void ShowReplyMenu(Button button)
    {
        var menu = new MenuFlyout { Placement = PlacementMode.Top };
        MenuItem Item(string header, bool on, bool enabled, Action click)
        {
            var item = new MenuItem { Header = header, IsEnabled = enabled, ToggleType = MenuItemToggleType.CheckBox, IsChecked = on }; item.Click += (_, _) => click(); return item;
        }
        menu.Items.Add(Item("返信者を自動選択", !model.ReplyMembers.Any(member => member.Selected), model.RoutingEnabled, model.ClearReplyMembers));
        foreach (var member in model.ReplyMembers.ToArray()) menu.Items.Add(Item(member.Name, member.Selected, true, () => model.ToggleReplyMember(member)));
        menu.ShowAt(button);
    }

    // ---- pages (placeholders in this stage) ----
    // 予定 and ゴール are real pages; each reads its data when opened (Windows ShowSchedules / ShowGoals).
    public void ShowSchedules() { if (!model.Connected) return; var page = new SchedulesPage(model, this); ShowPageContent(page); PageReady = page.InitializeAsync(); }
    public void ShowGoals() { if (!model.Connected) return; var page = new GoalsPage(model, this); ShowPageContent(page); PageReady = page.InitializeAsync(); }
    public Task PageReady { get; private set; } = Task.CompletedTask;
    public Control? CurrentPage => pageArea.Child;
    internal GoalPill GoalBar => goalPill;
    private void ShowPageContent(Control page)
    {
        model.ReturnToProfile(); (pageArea.Child as IDisposable)?.Dispose();
        pageArea.Child = page; pageArea.IsVisible = true; conversationArea.IsVisible = false; UpdateCorner();
    }
    private void ShowPage(string title)
    {
        if (!model.Connected) return;
        model.ReturnToProfile();
        var stack = new StackPanel { VerticalAlignment = VerticalAlignment.Center, HorizontalAlignment = HorizontalAlignment.Center, Spacing = 10 };
        stack.Children.Add(BellTheme.Text(title, 29, BellTheme.Ink, FontWeight.Bold)); ((TextBlock)stack.Children[0]).TextAlignment = TextAlignment.Center;
        stack.Children.Add(BellTheme.Text($"{title}はLinux版ではまだ使えません。", 16, BellTheme.Muted)); ((TextBlock)stack.Children[1]).TextAlignment = TextAlignment.Center;
        pageArea.Child = stack; pageArea.IsVisible = true; conversationArea.IsVisible = false; UpdateCorner();
    }
    private void ShowConversation() { (pageArea.Child as IDisposable)?.Dispose(); pageArea.Child = null; pageArea.IsVisible = false; conversationArea.IsVisible = true; UpdateCorner(); }

    // ---- startup: the Mac RootView phases ----
    public StartupPhase Startup => startup;
    public Control? StartupContent => startupHost.Child;
    private void ShowStartup(StartupPhase phase, string? message = null, SetupState? setup = null)
    {
        startup = phase;
        if (phase != StartupPhase.Failure) CancelStartupRetry();
        (startupHost.Child as IDisposable)?.Dispose();
        if (phase != StartupPhase.Ready) CloseSheet();
        startupHost.Child = phase switch
        {
            StartupPhase.Ready => null,
            StartupPhase.Checking => new StartupOpeningView(),
            StartupPhase.Failure => new StartupFailureView(message, () => _ = ConnectAsync(lastAddress ?? model.Server), OpenConnectionSettings),
            StartupPhase.Setup => new ServerSetupView(ConnectToAddress, ShowServerGuide, model.Server),
            StartupPhase.SignIn => new LoginView(OpenConnectionSettings),
            _ => new OnboardingView(new SetupApi(model.Management.Api), setup!, CompleteOnboardingAsync, OpenConnectionSettings, model.ConnectionToken)
        };
        startupHost.IsVisible = phase != StartupPhase.Ready;
    }
    public void ShowServerSetup() => ShowStartup(StartupPhase.Setup);
    // Render seams: the screens that need no server.
    public void ShowStartupForRender(StartupPhase phase, string? message = null) => ShowStartup(phase, message);
    public void ShowServerGuide() { CloseSheet(); OpenSheet("サーバーの導入ガイド", new ServerGuideView()); }
    // Settings needs a live connection, so an unreachable saved server is changed from the connection strip.
    public void OpenConnectionSettings() { ShowConversation(); ShowServerSetup(); }
    private void RouteToLogin() { if (model.NeedsLogin && !connecting && startup != StartupPhase.SignIn) ShowStartup(StartupPhase.SignIn); }

    // Mac changeServer: the server entry screen replaces the window. The saved address stays until a new one is entered, so it is offered again.
    private async Task ChangeServerAsync(string address)
    {
        if (address == model.Server) { await ConnectAsync(address); return; }
        connecting = true;
        model.SignOut();
        await ConnectAsync(address);
    }
    // The Setup screen's 続ける: a bad address throws back to the field; the connection itself reports through the phases.
    private void ConnectToAddress(string text)
    {
        var origin = ServerOrigin.Parse(text);
        settingsStore.Save(settingsStore.Load() with { ServerUrl = origin.AbsoluteUri });
        _ = ChangeServerAsync(origin.AbsoluteUri);
    }
    // Mac bootstrap: opening, then the phase the server's answer decides. A failure retries by itself with the backoff (see ScheduleStartupRetry);
    // 「もう一度試す」 and 再接続 call this again at once. An automatic try keeps the failure page on screen instead of flashing the opening view.
    public async Task ConnectAsync(string address, bool automatic = false)
    {
        CancelStartupRetry();
        var generation = ++connectGeneration; connecting = true;
        if (address != lastAddress) startupAttempt = 0;
        lastAddress = address;
        if (!(automatic && startup == StartupPhase.Failure)) ShowStartup(StartupPhase.Checking);
        try
        {
            await model.ConnectAsync(address);
            await EnterAsync(generation);
        }
        catch (ArgumentException error) { if (generation == connectGeneration) ShowStartup(StartupPhase.Failure, error.Message); }
        finally { if (generation == connectGeneration) connecting = false; }
    }
    private async Task EnterAsync(int generation, SetupState? known = null)
    {
        var setup = known; var failure = model.ConnectionError;
        if (setup is null && model.Connected && !model.NeedsLogin)
            try { setup = await new SetupApi(model.Management.Api).StatusAsync(model.ConnectionToken); }
            catch (OperationCanceledException) when (model.ConnectionToken.IsCancellationRequested) { return; }
            catch (Exception error) { failure = error.Message; }
        if (generation != connectGeneration) return;
        var route = StartupRoute.AfterConnect(model.NeedsLogin, model.Connected, setup);
        if (route != StartupPhase.Failure) startupAttempt = 0;
        switch (route)
        {
            case StartupPhase.Ready: ShowStartup(StartupPhase.Ready); await FinishEntryAsync(setup!); break;
            case StartupPhase.Onboarding: ShowStartup(StartupPhase.Onboarding, setup: setup); break;
            case StartupPhase.SignIn: ShowStartup(StartupPhase.SignIn); break;
            default: ShowStartup(StartupPhase.Failure, failure); if (model.ConnectionRetryable) ScheduleStartupRetry(generation); break;
        }
    }
    private void CancelStartupRetry() { startupRetry?.Cancel(); startupRetry?.Dispose(); startupRetry = null; }
    // The failure page leaves by itself: wait the next backoff step, then connect again unless the page or the connection moved on meanwhile.
    private void ScheduleStartupRetry(int generation)
    {
        if (!AutoRetry) return;
        CancelStartupRetry();
        var source = startupRetry = new CancellationTokenSource(); var attempt = startupAttempt++;
        _ = RetryAsync();
        async Task RetryAsync()
        {
            try { await model.RetryDelayAsync(attempt, source.Token); }
            catch (OperationCanceledException) { return; }
            if (source.IsCancellationRequested || generation != connectGeneration || startup != StartupPhase.Failure) return;
            await ConnectAsync(lastAddress ?? model.Server, automatic: true);
        }
    }
    // After the server reports the first setup done: reload the lists (the guide member exists now) and enter the conversations.
    private async Task CompleteOnboardingAsync(SetupState ready)
    {
        var generation = ++connectGeneration; connecting = true;
        try { await model.ReconnectAsync(); await EnterAsync(generation, ready); }
        finally { if (generation == connectGeneration) connecting = false; }
    }
    private async Task FinishEntryAsync(SetupState setup)
    {
        try
        {
            if (!setup.Complete && setup.GuideBotId is { } guide && model.Entries.FirstOrDefault(entry => entry.Target == new ChatTarget(guide, false)) is { } conversation) await model.SelectAsync(conversation);
            if (notifications is not null) await notifications.InitializeAsync();
            if (notifications is not null) await RefreshUpdateNoticeAsync();
        }
        catch (OperationCanceledException) when (model.ConnectionToken.IsCancellationRequested) { }
        catch (Exception error) { model.ReportActionError(error.Message); }
    }
    // A notification click: the update centre, or the conversation it came from. Only for the server this window is connected to.
    public async Task OpenNotificationAsync(string server, ChatTarget? target)
    {
        if (server != model.Server || !model.Connected) { model.ReportActionError(target is null ? "通知の接続先へ接続してから、更新センターを開いてください。" : "通知の接続先へ接続してから、会話を開いてください。"); return; }
        Raise();
        if (target is null) { ShowUpdates(); return; }
        var entry = model.Conversations.FirstOrDefault(item => item.Target == target);
        if (entry is null) { model.ReportActionError("通知の会話が見つかりません。メンバーとルームの一覧を更新してください。"); return; }
        ShowConversation(); await model.SelectAsync(entry);
    }
    // A second launch raises this window.
    public void Raise()
    {
        if (WindowState == WindowState.Minimized) WindowState = WindowState.Normal;
        Show(); Activate();
    }

    // ---- sheet and gallery ----
    public void OpenSheet(string title, Control content)
    {
        ReleaseSheetSave();
        if (content is ISheetSave save) { sheetSave = save; save.CanSaveChanged += SheetSaveChanged; saveSheetButton!.IsVisible = true; SheetSaveChanged(); }
        sheetTitle.Text = title; AutomationProperties.SetName(sheetFrame, title);
        sheetHost.Content = content; sheet.IsVisible = true; sheet.Focus();
    }
    public void CloseSheet()
    {
        ReleaseSheetSave();
        (sheetHost.Content as IDisposable)?.Dispose();
        sheetContent = null; sheetHost.Content = null; sheet.IsVisible = false;
    }
    private void SheetSaveChanged()
    {
        if (sheetSave is null) return;
        GoalUi.OnUi(() =>
        {
            if (sheetSave is null) return;
            saveSheetButton!.IsEnabled = sheetSave.CanSave; saveSheetButton.Content = sheetSave.SaveLabel; closeSheetButton!.Content = sheetSave.CloseLabel; closeSheetButton.IsEnabled = sheetSave.CanClose;
            AutomationProperties.SetName(closeSheetButton, sheetSave.CloseLabel); AutomationProperties.SetName(saveSheetButton, sheetSave.SaveLabel);
        });
    }
    private void ReleaseSheetSave()
    {
        if (sheetSave is not null) sheetSave.CanSaveChanged -= SheetSaveChanged;
        sheetSave = null; saveSheetButton!.IsVisible = false; closeSheetButton!.Content = "閉じる"; closeSheetButton.IsEnabled = true;
        AutomationProperties.SetName(closeSheetButton, "閉じる");
    }
    // Mac PeerMessageSheet in the shared in-window sheet.
    public void ShowPeerSheet(TimelineMessage message) { CloseSheet(); OpenSheet("メンバー間の連絡", new PeerMessageView(model, message)); }
    // The sidebar Update badge (and an update notification) opens the Update sheet over the window, as on the Mac. It reads again every time it opens.
    private UpdateContent? sheetContent;
    private Task updateNotice = Task.CompletedTask;
    public Task SheetReady { get; private set; } = Task.CompletedTask;
    public Task UpdateNoticeReady => updateNotice;
    public bool UpdateBadgeVisible => updateBadge.IsVisible;
    public UpdateContent? UpdateSheet => sheetContent;
    public void ShowUpdates() => ShowUpdateSheet();
    public void ShowUpdateSheet()
    {
        if (!model.Connected) return;
        if (sheetContent is null) { CloseSheet(); OpenSheet("アップデート", sheetContent = new UpdateContent(model, settingsStore)); }
        SheetReady = sheetContent.RefreshAsync();
    }
    private Task RefreshUpdateNoticeAsync() => updateNotice = ReadUpdateNoticeAsync();
    private async Task ReadUpdateNoticeAsync()
    {
        var server = model.Server;
        try
        {
            var state = await new UpdateCenter(model.Management.Api, settingsStore).InventoryAsync(model.ConnectionToken);
            if (model.Server != server) return;
            if (notifications is not null) await notifications.NotifyUpdatesAsync(server, state.NotificationCandidates);
            // Mac UpdateBadge: shown only while some component has update_available; other states live on the Update page.
            updateBadge.IsVisible = state.Components.Any(item => item.Comparison.State == "update_available");
        }
        catch (OperationCanceledException) when (model.ConnectionToken.IsCancellationRequested) { }
        catch (Exception) { if (model.Server == server) updateBadge.IsVisible = false; }
    }
    // The image gallery covers the whole window (Mac fullScreenCover). Opening it again replaces the one that is open.
    public ImageGallery ShowGallery(string[] paths, int initial)
    {
        if (galleryHost.Children.Count == 0) focusBeforeGallery = FocusManager?.GetFocusedElement();
        galleryHost.Children.Clear();
        var gallery = new ImageGallery(model, paths, initial, CloseGallery); galleryHost.Children.Add(gallery); galleryHost.IsVisible = true; galleryHost.Focus();
        return gallery;
    }
    public ImageGallery? Gallery => galleryHost.Children.OfType<ImageGallery>().FirstOrDefault();
    public void CloseGallery()
    {
        galleryHost.Children.Clear(); galleryHost.IsVisible = false;
        var back = focusBeforeGallery; focusBeforeGallery = null; (back as Control)?.Focus();
    }

    private void WindowKeyDown(object? sender, KeyEventArgs e)
    {
        if (Gallery is { } gallery) { if (e.KeyModifiers == KeyModifiers.None && gallery.HandleKey(e.Key)) e.Handled = true; return; }
        if (sheet.IsVisible) { if (e.Key == Key.Escape) { if (sheetSave?.DismissPopup() != true) CloseSheet(); e.Handled = true; } return; }
        if (startupHost.IsVisible) return;
        if (e.KeyModifiers == KeyModifiers.Control)
        {
            switch (e.Key)
            {
                case Key.D2: ShowSchedules(); e.Handled = true; break;
                case Key.D3: ShowGoals(); e.Handled = true; break;
                case Key.OemComma: ShowPage("設定"); e.Handled = true; break;
                case Key.K: search.Focus(); search.SelectAll(); e.Handled = true; break;
            }
        }
    }

    // ---- window placement ----
    private void RestorePlacement()
    {
        var saved = settingsStore.Load(); DisplayPreference.Current = saved.ConversationOpening;
        if (saved.Window is not { } placement) return;
        Width = Math.Max(MinWidth, placement.Width); Height = Math.Max(MinHeight, placement.Height);
        var point = new PixelPoint((int)placement.Left, (int)placement.Top);
        if (Screens.All.Any(screen => screen.WorkingArea.Contains(point))) { Position = point; WindowStartupLocation = WindowStartupLocation.Manual; }
        if (placement.Maximized) WindowState = WindowState.Maximized;
        Closing += (_, _) =>
        {
            try { settingsStore.Save(settingsStore.Load() with { Window = new(Position.X, Position.Y, Width, Height, WindowState == WindowState.Maximized) }); }
            catch (Exception error) { Console.Error.WriteLine("窓の位置を保存できませんでした。" + error.Message); }
        };
    }

    // Waits for the avatars and images that were just asked for, then lays the screen out.
    public async Task PrepareRenderAsync()
    {
        for (var round = 0; round < 3; round++)
        {
            Dispatcher.UIThread.RunJobs();
            var loads = this.GetVisualDescendants().SelectMany(item => item switch { AvatarTile tile => [tile.LoadTask], RemoteImage image => [image.LoadTask], _ => Array.Empty<Task>() }).ToArray();
            await Task.WhenAll(loads); await Task.Yield();
        }
        UpdateLayout();
        if (conversationArea.IsVisible) { messageScroll.ScrollToEnd(); UpdateLayout(); } // images that finished loading changed the height
    }
}

// Mac ConversationView top inset: a member's seat launch notice right under the toolbar band, red, up to 3 lines.
internal sealed class SeatLaunchBar : Border
{
    private readonly TextBlock text = new() { Foreground = BellTheme.Red, FontSize = 13, LineHeight = 18, MaxLines = 3, TextWrapping = TextWrapping.Wrap, TextTrimming = TextTrimming.CharacterEllipsis };
    public SeatLaunchBar() { Background = new SolidColorBrush(Color.Parse("#CCFFFFFF")); Padding = new Thickness(16, 6); Child = text; IsVisible = false; AutomationProperties.SetName(this, "起動できない理由"); }
    public void Show(string? line) { text.Text = line ?? ""; IsVisible = line is not null; }
}
