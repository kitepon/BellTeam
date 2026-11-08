using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using BellTeam.Core;
using Microsoft.Win32;
using System.Windows.Media;

namespace BellTeam.App;

public partial class MainWindow : Window, IInspectorHost
{
    private readonly Workspace model;
    private readonly DesktopAccess? access;
    private readonly DesktopNotifications? notifications;
    private readonly SettingsStore settingsStore;
    private StartupPhase startup = StartupPhase.Ready;
    private int connectGeneration;
    private bool connecting;
    private bool signingOut;
    private string? lastAddress;
    // Failed startup connections since the last success; the next automatic try waits ReconnectBackoff for this number. A manual try does not reset it.
    private int startupAttempt;
    private CancellationTokenSource? startupRetry;
    // Off for the render seams, which capture a screen and must not move on by themselves.
    public bool AutoRetry { get; set; } = true;
    private bool inspectorVisible = true;
    private EditorWindow? page;
    private bool loadingOlder;
    private bool unreadNew; // a message arrived while the reader was away from the bottom
    public Task PageReady { get; private set; } = Task.CompletedTask;
    public MainWindow(Workspace model, bool persistPlacement = true, DesktopAccess? access = null, DesktopNotifications? notifications = null, SettingsStore? settings = null)
    {
        this.model = model; settingsStore = settings ?? new SettingsStore(SettingsStore.UserDirectory);
        this.access = access;
        this.notifications = notifications;
        SetResourceReference(StyleProperty, typeof(Window));
        InitializeComponent(); ProfilePanel.Host = this;
        DataContext = model;
        if (notifications is not null) notifications.PropertyChanged += (_, args) => { if (args.PropertyName == nameof(DesktopNotifications.Error) && notifications.Error is { } error) Dispatcher.Invoke(() => model.ReportActionError(error)); };
        model.MessageArrived += async message =>
        {
            if (notifications?.Enabled != true || IsActive && page is null && model.Selected?.Target == message.Target) return;
            await notifications.NotifyAsync(message);
            if (!notifications.Enabled) model.ReportActionError(notifications.Status);
        };
        UpdateWelcome(); ProfileLayout();
        model.Messages.CollectionChanged += (_, _) => UpdateWelcome();
        MessageScroll.ScrollChanged += async (_, args) =>
        {
            if (!ReferenceEquals(args.OriginalSource, MessageScroll)) return;
            ShowLatestButton();
            var previousBottomDistance = args.ExtentHeight - args.ExtentHeightChange - args.ViewportHeight - args.VerticalOffset;
            if (!loadingOlder && args.ExtentHeightChange > 0 && previousBottomDistance < 80) _ = Dispatcher.BeginInvoke(() => MessageScroll.ScrollToEnd());
            if (!loadingOlder && args.VerticalChange < 0 && args.VerticalOffset < 48 && model.HasMore && !model.Loading) await LoadOlderPreservingPositionAsync();
        };
        ConversationList.PreviewMouseDown += (_, args) => { if (page is not null && args.OriginalSource is DependencyObject target && ItemsControl.ContainerFromElement(ConversationList, target) is ListBoxItem) ShowConversation(); };
        Closed += (_, _) => { CancelStartupRetry(); CloseGallery(); page?.Close(); sheetContent?.Dispose(); (UpdateSheetHost.Content as IDisposable)?.Dispose(); (StartupHost.Child as IDisposable)?.Dispose(); };
        Closing += (_, args) => { if (page?.CanNavigateAway == false) args.Cancel = true; };
        DataObject.AddPastingHandler(Composer, Composer_Pasting);
        model.ScrollToBottom += force =>
        {
            if (force || MessageScroll.ScrollableHeight - MessageScroll.VerticalOffset < 80)
                Dispatcher.BeginInvoke(() => MessageScroll.ScrollToEnd());
            else { unreadNew = true; ShowLatestButton(); }
        };
        model.PropertyChanged += (_, args) =>
        {
            // Mac requireLogin: whenever the server asks for a login, the login screen takes the window.
            if (args.PropertyName == nameof(Workspace.NeedsLogin) && model.NeedsLogin && !connecting) { if (Dispatcher.CheckAccess()) RouteToLogin(); else Dispatcher.BeginInvoke(RouteToLogin); }
            if (args.PropertyName == nameof(Workspace.Connected)) { if (model.Connected) _ = RefreshUpdateNoticeAsync(); else { UpdateBadge.Visibility = Visibility.Collapsed; CloseMemberWindows(); } }
            // Without a selection (the welcome screen) there is no inspector column, as on the Mac.
            if (args.PropertyName == nameof(Workspace.IsRoom) && inspectorVisible && page is null) ProfileLayout();
            if (args.PropertyName == nameof(Workspace.Selected) && page is null) ProfileLayout();
            if (args.PropertyName is nameof(Workspace.Selected) or nameof(Workspace.Connected)) UpdateGoalBar();
            if (args.PropertyName is nameof(Workspace.Loading) or nameof(Workspace.Selected) or nameof(Workspace.LoadFailed) or nameof(Workspace.HasActivity)) UpdateWelcome();
            if (args.PropertyName is nameof(Workspace.Selected)) unreadNew = false;
            if (args.PropertyName == nameof(Workspace.StopResult)) ShowStopResult();
            if (args.PropertyName is nameof(Workspace.ConnectionError) or nameof(Workspace.ActionError)) { ErrorStrip.Visibility = model.ConnectionError is null && model.ActionError is null ? Visibility.Collapsed : Visibility.Visible; ReconnectButton.Visibility = model.ConnectionError is null || model.Server.Length == 0 ? Visibility.Collapsed : Visibility.Visible; ConnectionButton.Visibility = model.ConnectionError is null ? Visibility.Collapsed : Visibility.Visible; }
        };
        model.UpdatesChanged += () => _ = RefreshUpdateNoticeAsync();
        PreviewKeyDown += Window_KeyDown;
        // Mac scenePhase .active: coming back to the window reads the goals again.
        Activated += (_, _) => { GoalBar.Reload(); (page as GoalsWindow)?.Reload(); };
        StateChanged += (_, _) => { if (WindowState == WindowState.Minimized) model.ReturnToProfile(); };
        if (persistPlacement)
        {
            var saved = settingsStore.Load(); DisplayPreference.Current = saved.ConversationOpening;
            var placement = saved.Window;
            if (placement is not null)
            {
                Width = Math.Max(MinWidth, placement.Width); Height = Math.Max(MinHeight, placement.Height);
                Left = placement.Left; Top = placement.Top;
                var desktop = new Rect(SystemParameters.VirtualScreenLeft, SystemParameters.VirtualScreenTop, SystemParameters.VirtualScreenWidth, SystemParameters.VirtualScreenHeight);
                if (!desktop.IntersectsWith(new Rect(Left, Top, Width, Height))) { Left = desktop.Left + 30; Top = desktop.Top + 30; }
                WindowStartupLocation = WindowStartupLocation.Manual;
                if (placement.Maximized) WindowState = WindowState.Maximized;
            }
            Closing += (_, _) =>
            {
                var store = settingsStore;
                var bounds = RestoreBounds;
                try { store.Save(store.Load() with { Window = new(bounds.Left, bounds.Top, bounds.Width, bounds.Height, WindowState == WindowState.Maximized) }); }
                catch (Exception error) { MessageBox.Show(this, "窓の位置を保存できませんでした。" + error.Message, "BellTeam"); }
            };
        }
    }
    private async void Conversation_Changed(object sender, SelectionChangedEventArgs e)
    {
        if (ConversationList.SelectedItem is ConversationEntry entry && model.Selected?.Target != entry.Target)
        {
            ShowConversation();
            await model.SelectAsync(entry);
        }
    }
    private async void Send_Click(object sender, RoutedEventArgs e) => await model.SendAsync();
    private async void Older_Click(object sender, RoutedEventArgs e) => await LoadOlderPreservingPositionAsync();
    private async Task LoadOlderPreservingPositionAsync()
    {
        if (loadingOlder) return;
        loadingOlder = true; var target = model.Selected?.Target; var offset = MessageScroll.VerticalOffset; var height = MessageScroll.ExtentHeight;
        try
        {
            await model.LoadOlderAsync();
            if (model.Selected?.Target == target) { MessageScroll.UpdateLayout(); MessageScroll.ScrollToVerticalOffset(offset + MessageScroll.ExtentHeight - height); }
        }
        finally { loadingOlder = false; }
    }
    private async void Reconnect_Click(object sender, RoutedEventArgs e) { if (page?.CanNavigateAway == false || model.Server.Length == 0) return; ShowConversation(); await ConnectAsync(model.Server); }
    private async void Export_Click(object sender, RoutedEventArgs e)
    {
        if (model.Selected is not { } entry) return;
        var dialog = new SaveFileDialog { FileName = $"BellTeam-{entry.Target.Id}.json", Filter = "JSONファイル|*.json", DefaultExt = ".json" };
        if (dialog.ShowDialog(this) == true) await model.ExportAsync(dialog.FileName);
    }
    private async void Attach_Click(object sender, RoutedEventArgs e)
    {
        var dialog = new OpenFileDialog { Filter = "画像|*.png;*.jpg;*.jpeg;*.webp;*.gif", Multiselect = true, Title = "画像を添付" };
        if (dialog.ShowDialog(this) == true) await model.AttachFilesAsync(dialog.FileNames);
    }
    private void RemoveImage_Click(object sender, RoutedEventArgs e) { if (sender is Button { Tag: ImageAttachment image }) model.RemoveAttachment(image); }
    private void Images_DragOver(object sender, DragEventArgs e)
    {
        if (e.Data.GetDataPresent(DataFormats.FileDrop)) { e.Effects = model.CanAttach ? DragDropEffects.Copy : DragDropEffects.None; e.Handled = true; }
    }
    private async void Images_Drop(object sender, DragEventArgs e)
    {
        if (e.Data.GetData(DataFormats.FileDrop) is string[] paths) { e.Handled = true; await model.AttachFilesAsync(paths); }
    }
    private async void Composer_Pasting(object sender, DataObjectPastingEventArgs e)
    {
        if (e.DataObject.GetData(DataFormats.Bitmap) is System.Windows.Media.Imaging.BitmapSource image)
        {
            e.CancelCommand();
            try { model.AttachClipboardImage(image); } catch (Exception) { model.ReportDraftError("貼り付けた画像を読み込めませんでした。"); }
        }
        else if (e.DataObject.GetData(DataFormats.FileDrop) is string[] paths) { e.CancelCommand(); await model.AttachFilesAsync(paths); }
    }
    private void CreateRoom_Click(object sender, RoutedEventArgs e) => ShowRoomSheet(null);
    private void CreateMember_Click(object sender, RoutedEventArgs e) => ShowMemberSheet();
    private void OpenMenu_Click(object sender, RoutedEventArgs e) { if (sender is Button { ContextMenu: { } menu } button) { menu.PlacementTarget = button; menu.IsOpen = true; } }
    private void Schedules_Click(object sender, RoutedEventArgs e) => ShowSchedules();
    private void Goals_Click(object sender, RoutedEventArgs e) => ShowGoals();
    private void Settings_Click(object sender, RoutedEventArgs e) => ShowSettings();
    private void Updates_Click(object sender, RoutedEventArgs e) => ShowUpdates();
    // The sidebar Update badge (and an update notification) opens the Update sheet, as on the Mac.
    public void ShowUpdates() => ShowUpdateSheet();
    private UpdateContent? sheetContent;
    public Task SheetReady { get; private set; } = Task.CompletedTask;
    public void ShowUpdateSheet()
    {
        if (!model.Connected) return;
        if (sheetContent is null)
        {
            CloseUpdateSheet(); OpenSheet("アップデート", sheetContent = new UpdateContent(model));
        }
        PageReady = SheetReady = sheetContent.RefreshAsync();
    }
    // Mac PeerMessageSheet in the shared in-window sheet.
    public void ShowPeerSheet(TimelineMessage message)
    {
        CloseUpdateSheet(); OpenSheet("メンバー間の連絡", new PeerMessageView(model, message));
    }
    private ISheetSave? sheetSave;
    private void SheetSaveChanged()
    {
        if (sheetSave is null) return;
        UpdateSheetSave.IsEnabled = sheetSave.CanSave; UpdateSheetSave.Content = sheetSave.SaveLabel; UpdateSheetClose.Content = sheetSave.CloseLabel; UpdateSheetClose.IsEnabled = sheetSave.CanClose;
        System.Windows.Automation.AutomationProperties.SetName(UpdateSheetClose, sheetSave.CloseLabel); System.Windows.Automation.AutomationProperties.SetName(UpdateSheetSave, sheetSave.SaveLabel);
    }
    private void UpdateSheetSave_Click(object sender, RoutedEventArgs e) { if (sheetSave is { CanSave: true } save) _ = save.SaveAsync(); }
    private void ReleaseSheetSave()
    {
        if (sheetSave is not null) sheetSave.CanSaveChanged -= SheetSaveChanged;
        sheetSave = null; UpdateSheetSave.Visibility = Visibility.Collapsed; UpdateSheetClose.Content = "閉じる"; UpdateSheetSave.Content = "保存";
    }
    public void OpenSheet(string title, UIElement content)
    {
        ReleaseSheetSave();
        if (content is ISheetSave save) { sheetSave = save; save.CanSaveChanged += SheetSaveChanged; UpdateSheetSave.Visibility = Visibility.Visible; SheetSaveChanged(); }
        if (content is AvatarActionsView actions) actions.BusyChanged += () => UpdateSheetClose.IsEnabled = !actions.Busy;
        SheetTitle.Text = title; System.Windows.Automation.AutomationProperties.SetName(SheetFrame, title);
        UpdateSheetHost.Content = content; UpdateSheet.Visibility = Visibility.Visible; UpdateSheet.Focus();
    }
    void IInspectorHost.CloseSheet() => CloseUpdateSheet();
    Window? IInspectorHost.OwnerWindow => this;
    public void CloseUpdateSheet()
    {
        CloseCropSheet(null); ReleaseSheetSave();
        switch (UpdateSheetHost.Content) { case AvatarActionsView actions: actions.Dispose(); break; case EditorFormView editor: editor.Dispose(); break; case AccessLoginView login: login.Dispose(); break; }
        UpdateSheetClose.IsEnabled = true;
        sheetContent?.Dispose(); sheetContent = null; UpdateSheetHost.Content = null; UpdateSheet.Visibility = Visibility.Collapsed;
    }
    private void UpdateSheetClose_Click(object sender, RoutedEventArgs e) { if (UpdateSheetHost.Content is AvatarActionsView { Busy: true } || sheetSave is { CanClose: false }) return; CloseUpdateSheet(); }

    // Mac: 追加 opens the new-member and new-room sheets, the profile's edit button the room sheet; a member is edited in a window of its own.
    public void ShowMemberSheet()
    {
        if (!model.Connected) return;
        var view = new MemberEditorView(model, null); OpenEditorSheet("メンバーを追加", view); PageReady = SheetReady = ReadyAfter(view.InitializeAsync(), view);
    }
    public void ShowRoomSheet(string? id)
    {
        if (!model.Connected) return;
        var view = new RoomEditorView(model, id); OpenEditorSheet(id is null ? "ルームを作る" : "ルームを編集", view); PageReady = SheetReady = ReadyAfter(view.InitializeAsync(), view);
    }
    private static async Task ReadyAfter(Task initialize, EditorFormView view) { await initialize; await view.ReadyTask; }
    private void OpenEditorSheet(string title, EditorFormView view) { CloseUpdateSheet(); view.Closer = CloseUpdateSheet; OpenSheet(title, view); }
    // Render seam: the open editor sheet.
    public EditorFormView? OpenEditor => UpdateSheetHost.Content as EditorFormView;
    private readonly Dictionary<string, MemberEditorWindow> memberWindows = [];
    public void EditMember(string id)
    {
        if (!model.Connected) return;
        if (memberWindows.TryGetValue(id, out var open)) { open.Activate(); return; }
        var window = new MemberEditorWindow(model, id) { Owner = this };
        memberWindows[id] = window; window.Closed += (_, _) => memberWindows.Remove(id);
        window.Show(); _ = window.InitializeAsync();
    }
    public void EditRoom(string id) => ShowRoomSheet(id);
    private void CloseMemberWindows() { foreach (var window in memberWindows.Values.ToArray()) window.Close(); }
    // Render seam: the member editor window, built but never shown.
    public MemberEditorWindow CreateMemberWindowForRender(string id) => new(model, id);

    // The crop sheet: one request at a time. 使用する hands the result back to whoever asked; anything else gives null.
    private TaskCompletionSource<AvatarCropOutcome?>? cropRequest;
    private AvatarCropView? cropView;
    public Task<AvatarCropOutcome?> CropAsync(System.Windows.Media.Imaging.BitmapSource image, AvatarVariant variant, AvatarCropRect? initialCrop, bool wantsSelection)
    {
        CloseCropSheet(null);
        cropView = new AvatarCropView(image, variant, initialCrop, wantsSelection); CropHost.Content = cropView; CropSheet.Visibility = Visibility.Visible; CropSheet.Focus();
        return (cropRequest = new(TaskCreationOptions.RunContinuationsAsynchronously)).Task;
    }
    private void CloseCropSheet(AvatarCropOutcome? outcome)
    {
        var request = cropRequest; cropRequest = null; cropView = null; CropHost.Content = null; CropSheet.Visibility = Visibility.Collapsed;
        request?.TrySetResult(outcome);
    }
    private void CropCancel_Click(object sender, RoutedEventArgs e) => CloseCropSheet(null);
    private void CropUse_Click(object sender, RoutedEventArgs e) { if (cropView?.TryUse() is { } outcome) CloseCropSheet(outcome); }
    // Render seam: the crop sheet over the main window.
    public AvatarCropView ShowCropForRender(System.Windows.Media.Imaging.BitmapSource image, AvatarVariant variant)
    {
        _ = CropAsync(image, variant, null, false); return cropView!;
    }
    private async Task RefreshUpdateNoticeAsync()
    {
        var server = model.Server;
        try
        {
            var state = await new UpdateCenter(model.Management.Api, new SettingsStore(SettingsStore.UserDirectory)).InventoryAsync(model.ConnectionToken);
            if (model.Server != server) return;
            if (notifications is not null) await notifications.NotifyUpdatesAsync(server, state.NotificationCandidates);
            // Mac UpdateBadge: shown only while some component has update_available; other states live on the Update page.
            UpdateBadge.Visibility = state.Components.Any(item => item.Comparison.State == "update_available") ? Visibility.Visible : Visibility.Collapsed;
        }
        catch (OperationCanceledException) when (model.ConnectionToken.IsCancellationRequested) { }
        catch (Exception) { if (model.Server == server) UpdateBadge.Visibility = Visibility.Collapsed; }
    }
    public void ShowGoals() { if (!model.Connected) return; var editor = new GoalsWindow(model, this); if (ShowPage(editor)) PageReady = editor.InitializeAsync(); }
    private void UpdateGoalBar() => GoalBar.Attach(model, model.Connected && model.Selected is { Target: { IsRoom: false } target } ? target.Id : null, this);
    public void ShowSchedules() { if (!model.Connected) return; var editor = new SchedulesWindow(model, this); if (ShowPage(editor)) PageReady = editor.InitializeAsync(); }
    // Render seam: the schedule page when it is the open page.
    internal SchedulesWindow? SchedulesPage => page as SchedulesWindow;
    public void ShowSettings(SettingsPage page = SettingsPage.Profile) { if (!model.Connected) return; var editor = new SettingsWindow(model, OpenConnectionSettings, notifications, () => _ = SignOutAsync()); if (ShowPage(editor)) PageReady = editor.InitializeAsync(page); }
    private bool ShowPage(EditorWindow editor)
    {
        if (page?.CanNavigateAway == false) { editor.Close(); model.ReportActionError("操作が終わってから画面を切り替えてください。"); return false; }
        if (IsLoaded) editor.Owner = this;
        model.ReturnToProfile(); PageHost.Content = null; page?.Close(); page = editor;
        PageHost.Content = editor.AsPage(ShowConversation); PageArea.Visibility = Visibility.Visible;
        ConversationArea.Visibility = Inspector.Visibility = Visibility.Collapsed; UpdateCornerButtons();
        return true;
    }
    private void ShowConversation()
    {
        if (page?.CanNavigateAway == false) { model.ReportActionError("操作が終わってから画面を切り替えてください。"); return; }
        PageHost.Content = null; page?.Close(); page = null; PageArea.Visibility = Visibility.Collapsed;
        ConversationArea.Visibility = Visibility.Visible; ProfileLayout();
    }
    private void ProfileLayout()
    {
        var show = inspectorVisible && model.HasSelection;
        Inspector.Visibility = show ? Visibility.Visible : Visibility.Collapsed;
        InspectorColumn.MinWidth = show ? 280 : 0; InspectorColumn.Width = show ? model.IsRoom ? new GridLength(280) : new GridLength(1, GridUnitType.Star) : new GridLength(0);
        UpdateCornerButtons();
    }
    // Mac toolbar: the inspector toggle and the export belong to the conversation, so a page (settings, schedules, goals) or an empty window shows neither.
    private void UpdateCornerButtons() => CornerButtons.Visibility = ConversationArea.Visibility == Visibility.Visible && model.HasSelection ? Visibility.Visible : Visibility.Collapsed;
    // Mac ConversationContent: spinner while the first read runs, then the empty or failed state when there is nothing (not even a queue line) to show.
    private void UpdateWelcome()
    {
        var empty = model.HasSelection && model.Messages.Count == 0;
        Welcome.Visibility = model.HasSelection ? Visibility.Collapsed : Visibility.Visible;
        LoadingSpinner.Visibility = empty && model.Loading ? Visibility.Visible : Visibility.Collapsed;
        var idle = empty && !model.Loading && !model.HasActivity;
        EmptyConversation.Visibility = idle && !model.LoadFailed ? Visibility.Visible : Visibility.Collapsed;
        FailedConversation.Visibility = idle && model.LoadFailed ? Visibility.Visible : Visibility.Collapsed;
        EmptyTitle.Text = model.Title + "と話しましょう";
    }
    private void ShowStopResult()
    {
        var notice = model.StopResult;
        StopNoticeBox.Visibility = notice is null ? Visibility.Collapsed : Visibility.Visible;
        StopNoticeText.Text = notice?.Message ?? "";
        StopNoticeText.Foreground = notice?.IsError == true ? new SolidColorBrush(Color.FromRgb(255, 59, 48)) : (Brush)FindResource("Violet");
    }
    // Mac: "新着メッセージ ↓" once something new arrived while reading older messages, else "最新へ ↓"; hidden at the bottom.
    private void ShowLatestButton()
    {
        var atBottom = MessageScroll.ScrollableHeight - MessageScroll.VerticalOffset < 80;
        if (atBottom) unreadNew = false;
        NewMessagesButton.Content = unreadNew ? "新着メッセージ ↓" : "最新へ ↓";
        NewMessagesButton.Visibility = atBottom && !unreadNew ? Visibility.Collapsed : Visibility.Visible;
    }
    private void NewMessages_Click(object sender, RoutedEventArgs e) { unreadNew = false; MessageScroll.ScrollToEnd(); NewMessagesButton.Visibility = Visibility.Collapsed; }
    private async void Reload_Click(object sender, RoutedEventArgs e) { if (model.Selected is { } entry) await model.SelectAsync(entry); }
    private async void StopBot_Click(object sender, RoutedEventArgs e) { if (sender is Button { Tag: ActivityRow { StopBotId: { } id } row }) await model.StopAsync(id, row.Name); }
    private async void StopCurrent_Click(object sender, RoutedEventArgs e) => await model.StopCurrentAsync();
    // Mac targetPicker: "返信者を自動選択" (off when routing is off), then a check per member.
    private void ReplyTarget_Click(object sender, RoutedEventArgs e)
    {
        if (sender is not Button button) return;
        static TextBlock Check(bool on) => new() { Text = on ? "\uE73E" : "\uE91F", FontFamily = new FontFamily("Segoe Fluent Icons, Segoe MDL2 Assets") };
        var menu = new ContextMenu { PlacementTarget = button, Placement = System.Windows.Controls.Primitives.PlacementMode.Top };
        var auto = new MenuItem { Header = "返信者を自動選択", Icon = Check(!model.ReplyMembers.Any(member => member.Selected)), IsEnabled = model.RoutingEnabled };
        auto.Click += (_, _) => model.ClearReplyMembers(); menu.Items.Add(auto);
        foreach (var member in model.ReplyMembers.ToArray())
        {
            var item = new MenuItem { Header = member.Name, Icon = Check(member.Selected) };
            item.Click += (_, _) => model.ToggleReplyMember(member); menu.Items.Add(item);
        }
        menu.IsOpen = true;
    }
    // Render seam: the image sheet a tap on the hero image opens.
    public AvatarActionsView? ShowAvatarSheetForRender(AvatarVariant variant) => ProfilePanel.OpenActionsForRender(variant);
    public void HideInspectorForRender() { inspectorVisible = false; ProfileLayout(); }
    public async Task PrepareRenderAsync(bool bottomOfPage = false)
    {
        await Task.WhenAll(Descendants<RemoteImage>(Root).Select(image => image.LoadTask).Append(ProfilePanel.LoadTask).Concat(Descendants<AvatarTile>(Root).Select(tile => tile.LoadTask)));
        if (bottomOfPage) page?.ScrollToEndForRender();
        Root.UpdateLayout();
        if (ConversationArea.Visibility == Visibility.Visible) { MessageScroll.ScrollToEnd(); Root.UpdateLayout(); } // images that finished loading changed the height
    }
    private static IEnumerable<T> Descendants<T>(DependencyObject parent) where T : DependencyObject
    {
        for (var index = 0; index < VisualTreeHelper.GetChildrenCount(parent); index++)
        {
            var child = VisualTreeHelper.GetChild(parent, index);
            if (child is T found) yield return found;
            foreach (var nested in Descendants<T>(child)) yield return nested;
        }
    }
    // Settings needs a live connection, so an unreachable saved server is changed from the connection strip.
    private void Connection_Click(object sender, RoutedEventArgs e) => OpenConnectionSettings();
    private void ClearSearch_Click(object sender, RoutedEventArgs e) { model.Search = ""; SearchBox.Focus(); }
    // Mac changeServer: the server entry screen replaces the window. The saved address stays until a new one is entered, so it is offered again.
    public void OpenConnectionSettings()
    {
        if (page?.CanNavigateAway == false) { model.ReportActionError("操作が終わってから接続先を変更してください。"); return; }
        ShowConversation(); ShowServerSetup();
    }
    public void ShowServerSetup() => ShowStartup(StartupPhase.Setup);
    // Render seam: the opening screen.
    public void ShowOpeningForRender() => ShowStartup(StartupPhase.Checking);
    private async Task SignOutAsync()
    {
        ShowConversation(); signingOut = true;
        try { model.SignOut(); } finally { signingOut = false; }
        try { if (notifications is not null) await notifications.SetEnabledAsync(false, persist: false); if (access is not null) await access.SignOutAsync(); }
        catch (Exception error) { model.ReportActionError(error.Message); }
    }
    private async Task ChangeServerAsync(string address)
    {
        if (address == model.Server) { await ConnectAsync(address); return; }
        connecting = true;
        try { model.SignOut(); if (notifications is not null) await notifications.SetEnabledAsync(false, persist: false); if (access is not null) await access.SignOutAsync(); }
        catch (Exception error) { connecting = false; ShowStartup(StartupPhase.Failure, error.Message); return; }
        await ConnectAsync(address);
    }
    // The Setup screen's 続ける: a bad address throws back to the field; the connection itself reports through the phases.
    private void ConnectToAddress(string text)
    {
        var origin = ServerOrigin.Parse(text);
        settingsStore.Save(settingsStore.Load() with { ServerUrl = origin.AbsoluteUri });
        _ = ChangeServerAsync(origin.AbsoluteUri);
    }

    // ---- startup: the Mac RootView phases ----
    public StartupPhase Startup => startup;
    public UIElement? StartupContent => StartupHost.Child;
    private void ShowStartup(StartupPhase phase, string? message = null, SetupState? setup = null)
    {
        startup = phase;
        if (phase != StartupPhase.Failure) CancelStartupRetry();
        (StartupHost.Child as IDisposable)?.Dispose();
        if (phase != StartupPhase.Ready) CloseUpdateSheet();
        StartupHost.Child = phase switch
        {
            StartupPhase.Ready => null,
            StartupPhase.Checking => new StartupOpeningView(),
            StartupPhase.Failure => new StartupFailureView(message, () => _ = ConnectAsync(lastAddress ?? model.Server), OpenConnectionSettings),
            StartupPhase.Setup => new ServerSetupView(ConnectToAddress, ShowServerGuide, model.Server),
            StartupPhase.SignIn => new LoginView(OpenLoginSheet),
            _ => new OnboardingView(new SetupApi(model.Management.Api), setup!, CompleteOnboardingAsync, OpenConnectionSettings, model.ConnectionToken)
        };
        StartupHost.Visibility = phase == StartupPhase.Ready ? Visibility.Collapsed : Visibility.Visible;
    }
    public void ShowServerGuide() { CloseUpdateSheet(); OpenSheet("サーバーの導入ガイド", new ServerGuideView()); }
    private void RouteToLogin() { if (model.NeedsLogin && !connecting && startup != StartupPhase.SignIn) ShowSignIn(!signingOut && model.AuthMode == "cloudflare"); }
    // Mac LoginView opens its login sheet by itself when the server just asked for a login (not after an explicit logout).
    private void ShowSignIn(bool openLogin) { ShowStartup(StartupPhase.SignIn); if (openLogin) OpenLoginSheet(); }
    private void OpenLoginSheet()
    {
        if (access is null) return;
        try
        {
            var origin = ServerOrigin.Parse(model.Server);
            CloseUpdateSheet();
            OpenSheet("ログイン", new AccessLoginView(access, origin, () => { CloseUpdateSheet(); _ = ConnectAsync(model.Server, openLogin: false); }));
        }
        catch (Exception) { (StartupHost.Child as LoginView)?.ShowError("ログイン画面を開けませんでした。接続先とWebView2 Runtimeを確認してください。"); }
    }
    // Mac bootstrap: opening, then the phase the server's answer decides. A failure retries by itself with the backoff (see ScheduleStartupRetry);
    // 「もう一度試す」 and 再接続 call this again at once. An automatic try keeps the failure page on screen instead of flashing the opening view.
    public async Task ConnectAsync(string address, bool openLogin = true) => await ConnectAsync(address, openLogin, false);
    private async Task ConnectAsync(string address, bool openLogin, bool automatic)
    {
        CancelStartupRetry();
        var generation = ++connectGeneration; connecting = true;
        if (address != lastAddress) startupAttempt = 0;
        lastAddress = address;
        if (!(automatic && startup == StartupPhase.Failure)) ShowStartup(StartupPhase.Checking);
        try
        {
            await model.ConnectAsync(address);
            await EnterAsync(generation, openLogin, null);
        }
        catch (ArgumentException error) { if (generation == connectGeneration) ShowStartup(StartupPhase.Failure, error.Message); }
        finally { if (generation == connectGeneration) connecting = false; }
    }
    private async Task EnterAsync(int generation, bool openLogin, SetupState? known)
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
            case StartupPhase.SignIn: ShowSignIn(openLogin && model.AuthMode == "cloudflare"); break;
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
            await ConnectAsync(lastAddress ?? model.Server, true, true);
        }
    }
    // After the server reports the first setup done: reload the lists (the guide member exists now) and enter the conversations.
    private async Task CompleteOnboardingAsync(SetupState ready)
    {
        var generation = ++connectGeneration; connecting = true;
        try { await model.ReconnectAsync(); await EnterAsync(generation, true, ready); }
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
    public async Task OpenNotificationAsync(string server, ChatTarget? target)
    {
        if (server != model.Server || !model.Connected) { model.ReportActionError(target is null ? "通知の接続先へ接続してから、更新センターを開いてください。" : "通知の接続先へ接続してから、会話を開いてください。"); return; }
        if (page?.CanNavigateAway == false) { model.ReportActionError("操作が終わってから通知を開いてください。"); return; }
        if (target is null) { if (WindowState == WindowState.Minimized) WindowState = WindowState.Normal; Show(); Activate(); ShowUpdates(); return; }
        var entry = model.Conversations.FirstOrDefault(item => item.Target == target);
        if (entry is null) { model.ReportActionError("通知の会話が見つかりません。メンバーとルームの一覧を更新してください。"); return; }
        ShowConversation(); if (WindowState == WindowState.Minimized) WindowState = WindowState.Normal; Show(); Activate(); await model.SelectAsync(entry);
    }
    private void Inspector_Click(object sender, RoutedEventArgs e) => ToggleInspector();
    private void ToggleInspector()
    {
        inspectorVisible = !inspectorVisible;
        if (!inspectorVisible) model.ReturnToProfile();
        ProfileLayout();
    }
    // The image gallery covers the whole window (Mac fullScreenCover). Opening it again replaces the one that is open.
    private IInputElement? focusBeforeGallery;
    public ImageGallery ShowGallery(string[] paths, int initial)
    {
        if (GalleryHost.Children.Count == 0) focusBeforeGallery = Keyboard.FocusedElement;
        GalleryHost.Children.Clear();
        var gallery = new ImageGallery(model, paths, initial, CloseGallery); GalleryHost.Children.Add(gallery); GalleryHost.Visibility = Visibility.Visible; GalleryHost.Focus();
        return gallery;
    }
    public ImageGallery? Gallery => GalleryHost.Children.OfType<ImageGallery>().FirstOrDefault();
    public void CloseGallery()
    {
        GalleryHost.Children.Clear(); GalleryHost.Visibility = Visibility.Collapsed;
        var back = focusBeforeGallery; focusBeforeGallery = null; if (back is not null) Keyboard.Focus(back);
    }
    private void Window_KeyDown(object sender, KeyEventArgs e)
    {
        if (Gallery is { } gallery) { if (Keyboard.Modifiers == ModifierKeys.None && gallery.HandleKey(e.Key)) e.Handled = true; return; }
        if (CropSheet.Visibility == Visibility.Visible) { if (e.Key == Key.Escape) { CloseCropSheet(null); e.Handled = true; } return; }
        if (UpdateSheet.Visibility == Visibility.Visible)
        {
            if (e.Key != Key.Escape) return;
            e.Handled = true;
            if (sheetSave?.DismissPopup() == true || sheetSave is { CanClose: false } || UpdateSheetHost.Content is AvatarActionsView { Busy: true }) return;
            CloseUpdateSheet(); return;
        }
        if (StartupHost.Visibility == Visibility.Visible) return;
        if (Keyboard.Modifiers == ModifierKeys.Control && e.Key == Key.D2) { ShowSchedules(); e.Handled = true; }
        if (Keyboard.Modifiers == ModifierKeys.Control && e.Key == Key.D3) { ShowGoals(); e.Handled = true; }
        if (Keyboard.Modifiers == ModifierKeys.Control && e.Key == Key.OemComma) { ShowSettings(); e.Handled = true; }
        if (e.Key == Key.K && Keyboard.Modifiers == ModifierKeys.Control) { SearchBox.Focus(); SearchBox.SelectAll(); e.Handled = true; }
        if (e.Key == Key.I && Keyboard.Modifiers == (ModifierKeys.Control | ModifierKeys.Shift)) { ToggleInspector(); e.Handled = true; }
    }
    private async void Composer_KeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.Enter && Keyboard.Modifiers == ModifierKeys.None)
        {
            // 日本語IMEの変換確定はKey.ImeProcessedとなるため、ここでは送信しない。
            e.Handled = true;
            await model.SendAsync();
        }
    }
}
