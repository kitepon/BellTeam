using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using BellTeam.Core;
using Microsoft.Win32;
using System.Windows.Media;

namespace BellTeam.App;

public partial class MainWindow : Window
{
    private readonly Workspace model;
    private readonly DesktopAccess? access;
    private bool inspectorVisible = true;
    private EditorWindow? page;
    private bool loadingOlder;
    public Task PageReady { get; private set; } = Task.CompletedTask;
    public MainWindow(Workspace model, bool persistPlacement = true, DesktopAccess? access = null)
    {
        this.model = model;
        this.access = access;
        SetResourceReference(StyleProperty, typeof(Window));
        InitializeComponent();
        DataContext = model;
        UpdateWelcome(); ProfileLayout();
        model.Messages.CollectionChanged += (_, _) => UpdateWelcome();
        MessageScroll.ScrollChanged += async (_, args) =>
        {
            if (!ReferenceEquals(args.OriginalSource, MessageScroll)) return;
            if (MessageScroll.ScrollableHeight - MessageScroll.VerticalOffset < 80) NewMessagesButton.Visibility = Visibility.Collapsed;
            var previousBottomDistance = args.ExtentHeight - args.ExtentHeightChange - args.ViewportHeight - args.VerticalOffset;
            if (!loadingOlder && args.ExtentHeightChange > 0 && previousBottomDistance < 80) _ = Dispatcher.BeginInvoke(() => MessageScroll.ScrollToEnd());
            if (!loadingOlder && args.VerticalChange < 0 && args.VerticalOffset < 48 && model.HasMore && !model.Loading) await LoadOlderPreservingPositionAsync();
        };
        ConversationList.PreviewMouseDown += (_, args) => { if (page is not null && args.OriginalSource is DependencyObject target && ItemsControl.ContainerFromElement(ConversationList, target) is ListBoxItem) ShowConversation(); };
        Closed += (_, _) => page?.Close();
        Closing += (_, args) => { if (page?.CanNavigateAway == false) args.Cancel = true; };
        DataObject.AddPastingHandler(Composer, Composer_Pasting);
        model.ScrollToBottom += force =>
        {
            if (force || MessageScroll.ScrollableHeight - MessageScroll.VerticalOffset < 80)
                Dispatcher.BeginInvoke(() => MessageScroll.ScrollToEnd());
            else NewMessagesButton.Visibility = Visibility.Visible;
        };
        model.PropertyChanged += (_, args) =>
        {
            if (args.PropertyName == nameof(Workspace.IsRoom) && inspectorVisible)
                InspectorColumn.Width = model.IsRoom ? new GridLength(280) : new GridLength(1, GridUnitType.Star);
            if (args.PropertyName == nameof(Workspace.Selected) && page is null) ProfileLayout();
            if (args.PropertyName is nameof(Workspace.Loading) or nameof(Workspace.Selected)) UpdateWelcome();
            if (args.PropertyName is nameof(Workspace.ConnectionError) or nameof(Workspace.ActionError)) ErrorStrip.Visibility = model.ConnectionError is null && model.ActionError is null ? Visibility.Collapsed : Visibility.Visible;
        };
        PreviewKeyDown += Window_KeyDown;
        StateChanged += (_, _) => { if (WindowState == WindowState.Minimized) model.ReturnToProfile(); };
        if (persistPlacement)
        {
            var placement = new SettingsStore(SettingsStore.UserDirectory).Load().Window;
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
                var store = new SettingsStore(SettingsStore.UserDirectory);
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
            try { model.AttachClipboardImage(image); } catch (Exception error) { model.ReportActionError("画像を貼り付けられませんでした。" + error.Message); }
        }
        else if (e.DataObject.GetData(DataFormats.FileDrop) is string[] paths) { e.CancelCommand(); await model.AttachFilesAsync(paths); }
    }
    private async void Screen_Click(object sender, RoutedEventArgs e) => await model.OpenScreenAsync();
    private void Profile_Click(object sender, RoutedEventArgs e) => model.ReturnToProfile();
    private void Edit_Click(object sender, RoutedEventArgs e)
    {
        if (model.Selected is not { } entry) return;
        if (entry.Target.IsRoom) { var editor = new RoomEditor(model, entry.Target.Id) { Owner = this }; _ = editor.InitializeAsync(); editor.ShowDialog(); }
        else { var editor = new MemberEditor(model, entry.Target.Id) { Owner = this }; _ = editor.InitializeAsync(); editor.ShowDialog(); }
    }
    private void CreateRoom_Click(object sender, RoutedEventArgs e) { var editor = new RoomEditor(model, null) { Owner = this }; _ = editor.InitializeAsync(); editor.ShowDialog(); }
    private void CreateMember_Click(object sender, RoutedEventArgs e) { var editor = new MemberEditor(model, null) { Owner = this }; _ = editor.InitializeAsync(); editor.ShowDialog(); }
    private void OpenMenu_Click(object sender, RoutedEventArgs e) { if (sender is Button { ContextMenu: { } menu } button) { menu.PlacementTarget = button; menu.IsOpen = true; } }
    private void Schedules_Click(object sender, RoutedEventArgs e) => ShowSchedules();
    private void Settings_Click(object sender, RoutedEventArgs e) => ShowSettings();
    public void ShowSchedules() { if (!model.Connected) return; var editor = new SchedulesWindow(model); if (ShowPage(editor)) PageReady = editor.InitializeAsync(); }
    public void ShowSettings() { if (!model.Connected) return; var editor = new SettingsWindow(model, OpenConnectionSettings); if (ShowPage(editor)) PageReady = editor.InitializeAsync(); }
    private bool ShowPage(EditorWindow editor)
    {
        if (page?.CanNavigateAway == false) { editor.Close(); model.ReportActionError("操作が終わってから画面を切り替えてください。"); return false; }
        if (IsLoaded) editor.Owner = this;
        model.ReturnToProfile(); PageHost.Content = null; page?.Close(); page = editor;
        PageHost.Content = editor.AsPage(ShowConversation); PageArea.Visibility = Visibility.Visible;
        ConversationArea.Visibility = Inspector.Visibility = Visibility.Collapsed;
        SchedulesNav.Background = editor is SchedulesWindow ? Brushes.White : Brushes.Transparent; SettingsNav.Background = editor is SettingsWindow ? Brushes.White : Brushes.Transparent;
        return true;
    }
    private void ShowConversation()
    {
        if (page?.CanNavigateAway == false) { model.ReportActionError("操作が終わってから画面を切り替えてください。"); return; }
        PageHost.Content = null; page?.Close(); page = null; PageArea.Visibility = Visibility.Collapsed;
        ConversationArea.Visibility = Visibility.Visible; SchedulesNav.Background = SettingsNav.Background = Brushes.Transparent; ProfileLayout();
    }
    private void ProfileLayout()
    {
        var show = inspectorVisible && model.HasSelection;
        Inspector.Visibility = show ? Visibility.Visible : Visibility.Collapsed;
        InspectorColumn.MinWidth = show ? 280 : 0; InspectorColumn.Width = show ? model.IsRoom ? new GridLength(280) : new GridLength(1, GridUnitType.Star) : new GridLength(0);
    }
    private void UpdateWelcome()
    {
        Welcome.Visibility = !model.HasSelection || model.Messages.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
        WelcomeTitle.Text = model.HasSelection ? model.Loading ? "読み込み中…" : model.Title + "との会話" : "チームと、同じデスクで。";
        WelcomeNote.Text = model.Loading ? "" : model.HasSelection ? "最初のメッセージを送って、会話を始めましょう。" : "左のメンバーやルームを選んで、会話を始めましょう。";
    }
    private void NewMessages_Click(object sender, RoutedEventArgs e) { MessageScroll.ScrollToEnd(); NewMessagesButton.Visibility = Visibility.Collapsed; }
    public async Task PrepareRenderAsync()
    {
        await Task.WhenAll(Descendants<RemoteImage>(Root).Select(image => image.LoadTask).Concat(Descendants<AvatarTile>(Root).Select(tile => tile.LoadTask)));
        Root.UpdateLayout();
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
    private void Connection_Click(object sender, RoutedEventArgs e) => OpenConnectionSettings();
    public void OpenConnectionSettings()
    {
        if (page?.CanNavigateAway == false) { model.ReportActionError("操作が終わってから接続先を変更してください。"); return; }
        var dialog = new ConnectionWindow(model.Server) { Owner = this };
        if (dialog.ShowDialog() == true) { ShowConversation(); _ = ConnectAsync(dialog.Address); }
    }
    public async Task ConnectAsync(string address)
    {
        await model.ConnectAsync(address);
        if (!model.Connected) return;
        try
        {
            var setup = await new SetupApi(model.Management.Api).StatusAsync(model.ConnectionToken);
            if (setup.Phase != "ready")
            {
                var editor = new SetupWindow(model, setup) { Owner = this };
                editor.ShowDialog(); setup = editor.State;
                if (setup.Phase != "ready") return;
                await model.ReconnectAsync();
            }
            if (!setup.Complete && setup.GuideBotId is { } guide && model.Entries.FirstOrDefault(entry => entry.Target == new ChatTarget(guide, false)) is { } conversation) await model.SelectAsync(conversation);
        }
        catch (OperationCanceledException) when (model.ConnectionToken.IsCancellationRequested) { }
        catch (Exception error) { model.ReportActionError(error.Message); }
    }
    private async void Login_Click(object sender, RoutedEventArgs e)
    {
        if (access is null) return;
        try { if (new AccessLoginWindow(access, ServerOrigin.Parse(model.Server)) { Owner = this }.ShowDialog() == true) await ConnectAsync(model.Server); }
        catch (Exception) { model.ReportActionError("ログイン画面を開けませんでした。接続先とWebView2 Runtimeを確認してください。"); }
    }
    private void Inspector_Click(object sender, RoutedEventArgs e) => ToggleInspector();
    private void ToggleInspector()
    {
        inspectorVisible = !inspectorVisible;
        if (!inspectorVisible) model.ReturnToProfile();
        ProfileLayout();
    }
    private void Window_KeyDown(object sender, KeyEventArgs e)
    {
        if (Keyboard.Modifiers == ModifierKeys.Control && e.Key == Key.D2) { ShowSchedules(); e.Handled = true; }
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

internal sealed class ConnectionWindow : Window
{
    private readonly TextBox input;
    public string Address { get; private set; } = "";
    public ConnectionWindow(string address)
    {
        Title = "接続先"; Width = 570; Height = 280; ResizeMode = ResizeMode.NoResize; WindowStartupLocation = WindowStartupLocation.CenterOwner;
        var panel = new StackPanel { Margin = new Thickness(24) };
        panel.Children.Add(new TextBlock { Text = "接続先URL", FontWeight = FontWeights.SemiBold, FontSize = 18, Margin = new Thickness(0, 0, 0, 10) });
        input = new TextBox { Text = address };
        panel.Children.Add(input);
        panel.Children.Add(new TextBlock { Text = "HTTPS、またはlocalhost・LANのHTTP接続先URL", Margin = new Thickness(0, 8, 0, 8), TextWrapping = TextWrapping.Wrap });
        var errorText = new TextBlock { Foreground = System.Windows.Media.Brushes.Firebrick, TextWrapping = TextWrapping.Wrap };
        panel.Children.Add(errorText);
        var save = new Button { Content = "接続", IsDefault = true, HorizontalAlignment = HorizontalAlignment.Right };
        save.Click += (_, _) =>
        {
            try
            {
                var origin = ServerOrigin.Parse(input.Text);
                var store = new SettingsStore(SettingsStore.UserDirectory);
                store.Save(store.Load() with { ServerUrl = origin.AbsoluteUri });
                Address = origin.AbsoluteUri;
                DialogResult = true;
            }
            catch (Exception error) { errorText.Text = error.Message; }
        };
        panel.Children.Add(save); Content = panel;
    }
}
