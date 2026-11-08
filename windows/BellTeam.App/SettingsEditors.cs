using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using BellTeam.Core;

namespace BellTeam.App;

// The Mac settings: a 300-wide category list on the left, the chosen page on the right. Page bodies live in SettingsPages.cs.
public sealed partial class SettingsWindow : EditorWindow
{
    private readonly Workspace workspace;
    private readonly Action? changeServer;
    private readonly Action? signOut;
    private readonly DesktopNotifications? notifications;
    private readonly Dictionary<SettingsPage, Border> rows = [];
    private readonly TextBlock profileName = SettingsUi.Text("あなた", 15, SettingsUi.Ink, FontWeights.SemiBold);
    private readonly AvatarTile profileAvatar = new() { Width = 36, Height = 36 };
    private readonly TextBlock stopRowText = SettingsUi.Text("", 13, SettingsUi.Secondary);
    private readonly TextBlock notificationRowText = SettingsUi.Text("", 13, SettingsUi.Secondary);
    private readonly ContentControl pane = new();
    private readonly ContentControl toolbarLeft = new();
    private readonly ContentControl toolbarRight = new();
    private readonly TextBlock toolbarTitle = SettingsUi.Text("", 13, SettingsUi.Secondary, FontWeights.SemiBold);
    private SettingsPage selected = SettingsPage.Profile;
    private CancellationTokenSource? lifetime;
    private EditorWindow? embedded;
    private bool inSubPage;
    private AiControl? control;

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
        Closed += (_, _) => { if (notifications is not null) notifications.PropertyChanged -= NotificationsChanged; lifetime?.Cancel(); embedded?.Close(); };
        UpdateNotificationRow();
    }

    // Leaving the page is blocked while a save here, or an update running in the hosted pane, is still in progress.
    public override bool CanNavigateAway => base.CanNavigateAway && embedded?.CanNavigateAway != false;
    public override void ScrollToEndForRender() { if (pane.Content is ScrollViewer scroller) { scroller.ScrollToEnd(); scroller.UpdateLayout(); } }
    public SettingsPage Selected => selected;

    public async Task InitializeAsync(SettingsPage page = SettingsPage.Profile)
    {
        var loads = new List<Task> { LoadControlAsync() };
        // The profile page reads the owner itself and updates the list row from that.
        if (page != SettingsPage.Profile) loads.Add(LoadOwnerAsync());
        loads.Add(SelectAsync(page));
        await Task.WhenAll(loads);
    }

    public async Task SelectAsync(SettingsPage page)
    {
        if (page == selected && !inSubPage && pane.Content is not null) return;
        if (embedded?.CanNavigateAway == false) { workspace.ReportActionError("操作が終わってから画面を切り替えてください。"); return; }
        lifetime?.Cancel(); lifetime?.Dispose(); embedded?.Close(); embedded = null; inSubPage = false;
        selected = page; Highlight(); SetToolbar(null, null, null);
        lifetime = CancellationTokenSource.CreateLinkedTokenSource(Token); var token = lifetime.Token;
        try
        {
            await (page switch
            {
                SettingsPage.Profile => ProfilePageAsync(token), SettingsPage.Ai => AiPageAsync(token), SettingsPage.Features => FeaturesPageAsync(token),
                SettingsPage.Notifications => NotificationsPage(), SettingsPage.Connection => ConnectionPage(), SettingsPage.Display => DisplayPage(),
                SettingsPage.Billing => BillingPage(), SettingsPage.Update => UpdatePageAsync(), SettingsPage.About => AboutPage(), _ => StopPageAsync(token)
            });
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
    }

    private UIElement BuildSidebar()
    {
        var list = new StackPanel { Margin = new Thickness(0, 50, 0, 16) };
        profileAvatar.Entry = OwnerEntry(null); profileAvatar.Workspace = workspace;
        var profile = new Grid(); profile.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(36) }); profile.ColumnDefinitions.Add(new ColumnDefinition());
        profile.Children.Add(profileAvatar);
        var text = new StackPanel { Margin = new Thickness(14, 0, 0, 0), VerticalAlignment = VerticalAlignment.Center }; text.Children.Add(profileName); text.Children.Add(SettingsUi.Text("プロフィールとあなたの決まり", 12, SettingsUi.Secondary, null, new Thickness(0, 2, 0, 0)));
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
                labels.Children.Add(SettingsUi.Text(SettingsPageInfo.Title(page), 14, page == SettingsPage.Stop ? SettingsUi.Red : SettingsUi.Ink, FontWeights.Medium));
                labels.Children.Add(SettingsUi.Text(SettingsPageInfo.Detail(page), 12, SettingsUi.Secondary, null, new Thickness(0, 2, 0, 0)));
                Grid.SetColumn(labels, 1); grid.Children.Add(labels);
                var trailing = page == SettingsPage.Stop ? stopRowText : page == SettingsPage.Notifications ? notificationRowText : null;
                if (trailing is not null) { trailing.VerticalAlignment = VerticalAlignment.Center; trailing.TextWrapping = TextWrapping.NoWrap; Grid.SetColumn(trailing, 2); grid.Children.Add(trailing); }
                list.Children.Add(CategoryRow(page, SettingsPageInfo.Title(page), grid, new Thickness(0, first ? 10 : 0, 0, 0))); first = false;
            }
        }
        return new ScrollViewer { Content = list, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled };
    }

    private Border CategoryRow(SettingsPage page, string name, UIElement content, Thickness margin)
    {
        var row = new Border { Child = content, Margin = new Thickness(10, margin.Top, 10, 0), Padding = new Thickness(8, 5, 10, 5), CornerRadius = new CornerRadius(8), Background = Brushes.Transparent, Focusable = true, Cursor = Cursors.Hand };
        System.Windows.Automation.AutomationProperties.SetName(row, name);
        row.MouseLeftButtonUp += (_, _) => _ = SelectAsync(page);
        row.KeyDown += (_, args) => { if (args.Key is Key.Enter or Key.Space) { _ = SelectAsync(page); args.Handled = true; } };
        rows[page] = row; return row;
    }
    private void Highlight() { foreach (var (page, row) in rows) row.Background = page == selected ? new SolidColorBrush(Color.FromRgb(0xE1, 0xE1, 0xE6)) : Brushes.Transparent; }

    private ConversationEntry OwnerEntry(OwnerProfile? owner) => new(new("owner", false), owner?.Name ?? workspace.OwnerName, "", DateTimeOffset.MinValue, new Bot { Id = "owner", Name = owner?.Name ?? workspace.OwnerName, DisplayName = owner?.Name ?? workspace.OwnerName, Avatar = owner?.Avatar ?? "" }, null);
    private void UpdateProfileRow(OwnerProfile owner) { profileName.Text = owner.Name; profileAvatar.Entry = OwnerEntry(owner); }
    private async Task LoadOwnerAsync()
    {
        try { var owner = (await workspace.Planning.OwnerAsync(Token)).Owner; UpdateProfileRow(owner); }
        catch (OperationCanceledException) when (Token.IsCancellationRequested) { }
        catch (Exception) { /* the row keeps the owner name already known to the workspace; the profile page shows the reason */ }
    }

    private void NotificationsChanged(object? sender, System.ComponentModel.PropertyChangedEventArgs args) { if (args.PropertyName is nameof(DesktopNotifications.Enabled) or nameof(DesktopNotifications.Error)) Dispatcher.BeginInvoke(UpdateNotificationRow); }
    private void UpdateNotificationRow() => notificationRowText.Text = notifications is null ? "" : notifications.Enabled ? "オン" : "オフ";
    private void ShowControl(AiControl? value)
    {
        control = value;
        stopRowText.Text = value?.RowText ?? ""; stopRowText.Foreground = value?.State is AiControlState.Stopped or AiControlState.Stopping or AiControlState.Unconfirmed ? SettingsUi.Red : SettingsUi.Secondary;
        stopRowText.FontWeight = value?.State is AiControlState.Stopped or AiControlState.Stopping ? FontWeights.SemiBold : FontWeights.Normal;
    }
    // The list row shows the live state whichever page is open, so it is read once when settings open.
    private async Task LoadControlAsync()
    {
        try { ShowControl((await workspace.Planning.AiControlAsync(Token)).Control); }
        catch (OperationCanceledException) when (Token.IsCancellationRequested) { }
        catch (Exception) { ShowControl(null); }
    }

    private StackPanel NewPage(SettingsPage? page, bool scroll = true)
    {
        // Mac: card pages sit closer to the top than Form pages.
        var stack = new StackPanel { Margin = new Thickness(20, page is SettingsPage.Ai or SettingsPage.Features or SettingsPage.Billing ? 28 : 44, 20, 24), MaxWidth = 720 };
        if (page is { } known) stack.Children.Add(SettingsUi.Header(known));
        if (scroll) pane.Content = new ScrollViewer { Content = stack, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled };
        return stack;
    }
    private void SetToolbar(UIElement? left, string? title, UIElement? right) { toolbarLeft.Content = left; toolbarTitle.Text = title ?? ""; toolbarRight.Content = right; }
    // A page opened from inside a page (a feature, the summary AI): the toolbar gets a back control that returns to the category.
    private void ShowSubPage(string title, UIElement content, Action back)
    {
        inSubPage = true;
        var button = SettingsUi.Capsule("‹ " + SettingsPageInfo.Title(selected), Brushes.Transparent, SettingsUi.Violet, 8, 13, new Thickness(8, 4, 8, 4));
        button.Click += (_, _) => back();
        SetToolbar(button, title, null); pane.Content = content;
    }
    private void Reopen() { var page = selected; inSubPage = true; _ = SelectAsync(page); }
    private static string ErrorText(Exception error) => error is BellApiException { Status: not null } ? error.Message : "操作の結果を確認できませんでした。現在の状態を確認してください。\n" + error.Message;
}
